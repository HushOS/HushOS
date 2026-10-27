import { decryptKey, encryptKey } from './aead';
import { encodeStatement, uuid } from './canonical';
import { CryptoError } from './errors';
import { decode, encode } from './keys';

/*
 * A device's rollback marks for one account (the web's lib/rollback-marks.ts):
 * the highest settings sequence and identity key version it has seen, and
 * whether it has opened a version 2 settings document and a version 2
 * identity. They say which account used this browser and how far it got, so
 * they are kept sealed, never in the clear.
 *
 * Sealed in the crypto worker under a key derived from the account root
 * (HKDF-SHA-256, salt 32 zero bytes, info "hushos/rollback-marks/v1"), which
 * exists only while the account is unlocked: a locked browser holds ciphertext.
 * The record is found by a slot, an HMAC-SHA-256 of the user id under another
 * key from the root ("hushos/rollback-marks/slot/v1"), cut to 16 bytes, so the
 * storage key does not name the account either. The associated data
 * ["hushos/rollback-marks",1,userId,slot] binds a record to its account and
 * slot: one copied to another account, or to another slot, does not open.
 *
 * Envelope: [version 1][24-byte nonce][XChaCha20-Poly1305 of the marks as
 * JSON], base64url; the same layout as the families' device store
 * (session-groups.ts, "The device store").
 *
 * A master-key rotation gives the account a new root, so a new slot: the
 * marks sealed under the old root are no longer found, and the device starts
 * again from none, as a new device does. The server cannot cause that (it
 * cannot make a root), and rotating on this browser carries the marks across
 * (lib/rollback-marks.ts carryMarks).
 */

export type RollbackMarks = {
    /* The highest settings sequence seen; 0 for none. */
    settings: number;
    /* Whether a version 2 settings document has been opened or saved here. */
    settingsDocument: boolean;
    /* The highest own identity key version opened; 0 for none. */
    identity: number;
    /* The highest own identity form opened (1, or 2 once upgraded); 0 for none. */
    identityVersion: number;
};

export const NO_MARKS: RollbackMarks = Object.freeze({
    settings: 0,
    settingsDocument: false,
    identity: 0,
    identityVersion: 0,
});

const KEY_INFO = 'hushos/rollback-marks/v1';
const SLOT_INFO = 'hushos/rollback-marks/slot/v1';
const DOMAIN = 'hushos/rollback-marks';
const VERSION = 1;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

/* A record that does not open: another account's, another slot's, a damaged or changed one. */
export class RollbackMarksError extends CryptoError {}

async function derive(root: Uint8Array<ArrayBuffer>, info: string) {
    if (root.byteLength !== 32) throw new CryptoError('Invalid account key.');
    const material = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt: new Uint8Array(32),
                info: new TextEncoder().encode(info),
            },
            material,
            256,
        ),
    );
}

/* Where this account's marks are kept on this device: no name, only the root can say it. */
export async function rollbackMarksSlot(root: Uint8Array<ArrayBuffer>, userId: string) {
    const raw = await derive(root, SLOT_INFO);
    try {
        const key = await crypto.subtle.importKey(
            'raw',
            raw,
            { name: 'HMAC', hash: 'SHA-256' },
            false,
            ['sign'],
        );
        const mac = await crypto.subtle.sign(
            'HMAC',
            key,
            new TextEncoder().encode(uuid(userId, 'user id')),
        );
        return encode(new Uint8Array(mac, 0, 16));
    } finally {
        raw.fill(0);
    }
}

function context(userId: string, slot: string) {
    return encodeStatement([DOMAIN, VERSION, uuid(userId, 'user id'), slot]);
}

const count = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/* Marks as stored, or refused: anything else reads as a record that does not open. */
function checked(value: unknown): RollbackMarks {
    const marks = value as RollbackMarks;
    if (
        typeof marks !== 'object' ||
        marks === null ||
        !count(marks.settings) ||
        typeof marks.settingsDocument !== 'boolean' ||
        !count(marks.identity) ||
        !count(marks.identityVersion)
    )
        throw new RollbackMarksError('These rollback marks could not be read.');
    return {
        settings: marks.settings,
        settingsDocument: marks.settingsDocument,
        identity: marks.identity,
        identityVersion: marks.identityVersion,
    };
}

export async function sealRollbackMarks(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    marks: RollbackMarks,
) {
    const slot = await rollbackMarksSlot(root, userId);
    const plaintext = new TextEncoder().encode(JSON.stringify(checked(marks)));
    const key = await derive(root, KEY_INFO);
    try {
        const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
        const sealed = await encryptKey(plaintext, key, nonce, context(userId, slot));
        const out = new Uint8Array(1 + NONCE_BYTES + sealed.length);
        out[0] = VERSION;
        out.set(nonce, 1);
        out.set(sealed, 1 + NONCE_BYTES);
        return { slot, envelope: encode(out) };
    } finally {
        key.fill(0);
    }
}

/* The marks `envelope` holds for this account, or RollbackMarksError: never "none". */
export async function openRollbackMarks(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: string,
) {
    const refused = () => new RollbackMarksError('These rollback marks could not be read.');
    let bytes: Uint8Array;
    try {
        bytes = decode(envelope);
    } catch {
        throw refused();
    }
    if (bytes.length < 1 + NONCE_BYTES + TAG_BYTES || bytes[0] !== VERSION) throw refused();
    const slot = await rollbackMarksSlot(root, userId);
    const key = await derive(root, KEY_INFO);
    let plaintext: Uint8Array;
    try {
        plaintext = await decryptKey(
            bytes.subarray(1 + NONCE_BYTES),
            key,
            bytes.subarray(1, 1 + NONCE_BYTES),
            context(userId, slot),
        );
    } catch {
        throw refused();
    } finally {
        key.fill(0);
    }
    try {
        return checked(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
    } catch {
        throw refused();
    }
}

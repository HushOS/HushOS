import { decryptKey, encryptKey } from './aead';
import { encodeStatement, uuid } from './canonical';
import { CryptoError } from './errors';
import { decode, encode } from './keys';

/*
 * A device's rollback marks for one account (the web's lib/rollback-marks.ts):
 * the highest settings sequence and identity key version it has seen, and
 * whether it has opened a version 2 settings document and a version 2
 * identity. They say how far an account got on this browser, so they are kept
 * sealed, never in the clear.
 *
 * Sealed in the crypto worker under a key derived from the settings key
 * (HKDF-SHA-256, salt 32 zero bytes, info "hushos/rollback-marks/v1"), which
 * exists only while the account is unlocked: a locked browser holds
 * ciphertext. Not the root: a master-key rotation only re-wraps the settings
 * key, so the marks open under every root the account has had, a root the
 * server replays from before a rotation included. Under a key from the root, a
 * replayed root would have found no record and read none, a rollback of the
 * marks themselves.
 *
 * The record is found by a slot that needs no key: SHA-256 of
 * "hushos/rollback-marks/slot/v1" and the user id, cut to 16 bytes. So a record
 * that is there and does not open under the settings key the server serves is
 * told apart from no record at all, and refused, never read as none. The slot
 * does not show the account id, though someone who already holds the id (the
 * server) can tell this browser keeps marks for it. The associated data
 * ["hushos/rollback-marks",1,userId,slot] binds a record to its account.
 *
 * Envelope: [version 1][24-byte nonce][XChaCha20-Poly1305 of the marks as
 * JSON], base64url; the layout of the families' device store
 * (session-groups.ts, "The device store").
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
const SLOT_LABEL = 'hushos/rollback-marks/slot/v1';
const DOMAIN = 'hushos/rollback-marks';
const VERSION = 1;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;

/* A record that does not open: another account's, another slot's, a damaged or changed one. */
export class RollbackMarksError extends CryptoError {}

async function derive(settingsKey: Uint8Array<ArrayBuffer>, info: string) {
    if (settingsKey.byteLength !== 32) throw new CryptoError('Invalid settings key.');
    const material = await crypto.subtle.importKey('raw', settingsKey, 'HKDF', false, [
        'deriveBits',
    ]);
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

/* Where this account's marks are kept on this device: found without a key, and not the id itself. */
export async function rollbackMarksSlot(userId: string) {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`${SLOT_LABEL}\u0000${uuid(userId, 'user id')}`),
    );
    return encode(new Uint8Array(digest, 0, 16));
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
    settingsKey: Uint8Array<ArrayBuffer>,
    userId: string,
    marks: RollbackMarks,
) {
    const slot = await rollbackMarksSlot(userId);
    const plaintext = new TextEncoder().encode(JSON.stringify(checked(marks)));
    const key = await derive(settingsKey, KEY_INFO);
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
    settingsKey: Uint8Array<ArrayBuffer>,
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
    const slot = await rollbackMarksSlot(userId);
    const key = await derive(settingsKey, KEY_INFO);
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

/* `a` raised to at least `b`, field by field: no mark is ever lowered. */
export function highestMarks(a: RollbackMarks, b: Partial<RollbackMarks>): RollbackMarks {
    return {
        settings: Math.max(a.settings, b.settings ?? 0),
        settingsDocument: a.settingsDocument || b.settingsDocument === true,
        identity: Math.max(a.identity, b.identity ?? 0),
        identityVersion: Math.max(a.identityVersion, b.identityVersion ?? 0),
    };
}

/*
 * One update of the marks under one settings key: the record `envelope` holds (none for a
 * first record) is opened, raised to at least `to`, and sealed again under the same key, or
 * left as it is when nothing rises. A record that does not open under this key is refused
 * (RollbackMarksError), never sealed over: the marks only ever move to a key they opened
 * under.
 */
export async function updateRollbackMarks(
    settingsKey: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: string | null,
    to: Partial<RollbackMarks>,
) {
    const current =
        envelope === null ? NO_MARKS : await openRollbackMarks(settingsKey, userId, envelope);
    const next = highestMarks(current, to);
    const unchanged =
        next.settings === current.settings &&
        next.settingsDocument === current.settingsDocument &&
        next.identity === current.identity &&
        next.identityVersion === current.identityVersion;
    if (envelope !== null && unchanged) return { marks: current, envelope, changed: false };
    const sealed = await sealRollbackMarks(settingsKey, userId, next);
    return { marks: next, envelope: sealed.envelope, changed: true };
}

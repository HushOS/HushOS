import { wordlist } from '@scure/bip39/wordlists/english.js';
import { CryptoError } from './errors';
import { decode, encode } from './keys';

/*
 * Approving on another device, as the second step (docs/two-step-design.md 12,
 * docs/devices-design.md 2): what the asking device and the approving device both build.
 *
 * The asking device holds the step token. It commits to its signing key and a nonce before it
 * sees anything of the approving device:
 *
 *     commitment = SHA-256("hushos/two-step/device/commit/v1" || purpose || sha256(stepToken) || deviceSigningKey || nonce)
 *
 * One approving device opens the request with 32 fresh bytes of its own (`approverEphemeralKey`;
 * nothing is sealed to it in this design, so it need not be a key), and only then does the
 * asking device reveal its key and nonce. Both compute
 *
 *     code = SHA-256("hushos/two-step/device/v1" || userId || requestId || purpose || sha256(stepToken) || deviceSigningKey || approverEphemeralKey || nonce)
 *
 * and show it as two digits and a word, such as "47 river": the first four bytes as a
 * big-endian integer, mod 100, and the BIP-39 word the next 11 bits index. The person types on
 * the approving device what the asking device shows, and only an exact match is approved, with
 * the approving device's key over
 *
 *     ["hushos/two-step/device",1,userId,requestId,purpose,sha256(stepToken),deviceSigningKey]
 *
 * The purpose and the token are in all three, so an approval is good for one step and for what
 * the approving device was shown, and neither side could choose its value after the other's.
 *
 * Encodings: the labels and the purpose are ASCII; ids are lowercase UUIDs, 36 characters; the
 * token digest is the SHA-256 of the step token's UTF-8 bytes; keys, nonce and digest are 32
 * bytes each. Every field but the purpose has a fixed length, so plain concatenation reads one
 * way only. `packages/db/src/signatures.ts` and `crates/hushos-core/src/device_approval.rs`
 * build the same bytes; the fixtures hold the three to each other.
 */

const COMMIT_DOMAIN = 'hushos/two-step/device/commit/v1';
const CODE_DOMAIN = 'hushos/two-step/device/v1';
const STATEMENT_DOMAIN = 'hushos/two-step/device';
/* What a scanned request starts with (docs/devices-design.md 2, "Scanning instead of typing"). */
export const APPROVAL_QR_PREFIX = 'hushos-approve:';
/* The purposes a step token can have, as the server names them. */
const PURPOSE = /^[a-z][a-z-]{1,31}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const utf8 = (text: string) => new TextEncoder().encode(text);
async function sha256(...parts: Uint8Array[]) {
    const all = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        all.set(part, offset);
        offset += part.length;
    }
    return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}
function purposeOf(purpose: string) {
    if (!PURPOSE.test(purpose)) throw new CryptoError('Invalid device approval.');
    return utf8(purpose);
}
function idOf(id: string) {
    const lower = id.toLowerCase();
    if (!UUID.test(lower)) throw new CryptoError('Invalid device approval.');
    return lower;
}

export type DeviceStep = {
    userId: string;
    requestId: string;
    purpose: string;
    /* SHA-256 of the step token's UTF-8 bytes, base64url: what the server keeps of the token. */
    tokenDigest: string;
    /* The asking device's Ed25519 public key, base64url. */
    deviceSigningKey: string;
};

/* What the asking device posts before it has seen the approving device's key, base64url. */
export async function deviceStepCommitment(input: {
    purpose: string;
    tokenDigest: string;
    deviceSigningKey: string;
    nonce: string;
}) {
    return encode(
        await sha256(
            utf8(COMMIT_DOMAIN),
            purposeOf(input.purpose),
            decode(input.tokenDigest, 32),
            decode(input.deviceSigningKey, 32),
            decode(input.nonce, 32),
        ),
    );
}

/* The code both devices show, such as "47 river". */
export async function deviceStepCode(input: DeviceStep & { approverKey: string; nonce: string }) {
    const digest = await sha256(
        utf8(CODE_DOMAIN),
        utf8(idOf(input.userId)),
        utf8(idOf(input.requestId)),
        purposeOf(input.purpose),
        decode(input.tokenDigest, 32),
        decode(input.deviceSigningKey, 32),
        decode(input.approverKey, 32),
        decode(input.nonce, 32),
    );
    const number = new DataView(digest.buffer).getUint32(0) % 100;
    const word = wordlist[(digest[4]! << 3) | (digest[5]! >> 5)]!;
    return `${String(number).padStart(2, '0')} ${word}`;
}

/* The bytes the approving device signs with its device key. */
export function deviceStepStatement(input: DeviceStep) {
    purposeOf(input.purpose);
    return utf8(
        JSON.stringify([
            STATEMENT_DOMAIN,
            1,
            idOf(input.userId),
            idOf(input.requestId),
            input.purpose,
            encode(decode(input.tokenDigest, 32)),
            encode(decode(input.deviceSigningKey, 32)),
        ]),
    );
}

/* The approving device's signature over its statement, base64url (64 bytes). */
export async function signDeviceStep(privateKey: CryptoKey, input: DeviceStep) {
    const statement = deviceStepStatement(input);
    return encode(
        new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, statement)),
    );
}

/*
 * What the asking device shows as a QR code: the request and its commitment, so an approving
 * device with a camera checks 256 bits itself instead of asking the person to compare a code.
 */
export function approvalQr(input: { requestId: string; commitment: string }) {
    const id = idOf(input.requestId).replaceAll('-', '');
    const bytes = new Uint8Array(48);
    for (let index = 0; index < 16; index++)
        bytes[index] = Number.parseInt(id.slice(index * 2, index * 2 + 2), 16);
    bytes.set(decode(input.commitment, 32), 16);
    return `${APPROVAL_QR_PREFIX}${encode(bytes)}`;
}

/* A scanned code's request and commitment, or null for anything that is not one. */
export function readApprovalQr(text: string) {
    const scanned = text.trim();
    if (!scanned.startsWith(APPROVAL_QR_PREFIX)) return null;
    let bytes: Uint8Array;
    try {
        bytes = decode(scanned.slice(APPROVAL_QR_PREFIX.length), 48);
    } catch {
        return null;
    }
    const hex = [...bytes.subarray(0, 16)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
    return {
        requestId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        commitment: encode(bytes.subarray(16)),
    };
}

/*
 * A typed code as both devices write it, or null when it is not one: two digits, then a word of
 * the list. Read forgivingly: case, and whatever stands between or around the two, are ignored.
 */
export function normalizeApprovalCode(typed: string) {
    const match = /^\s*(\d{2})[\s-]*([a-z]+)\s*$/i.exec(typed);
    if (!match) return null;
    const word = match[2]!.toLowerCase();
    return wordlist.includes(word) ? `${match[1]} ${word}` : null;
}

/*
 * A typed code as the two numbers it stands for, or null when it is not one: the digits, and
 * the word's place in the list. The server, which has no list of words, compares these.
 */
export function approvalCodeParts(typed: string) {
    const code = normalizeApprovalCode(typed);
    if (!code) return null;
    return { number: Number(code.slice(0, 2)), word: wordlist.indexOf(code.slice(3)) };
}

/* The words a typed beginning could become, for completion: a few, in the list's order. */
export function approvalWords(prefix: string, limit = 6) {
    const typed = prefix.trim().toLowerCase();
    if (!/^[a-z]+$/.test(typed)) return [];
    const found: string[] = [];
    for (const word of wordlist) {
        if (word.startsWith(typed)) found.push(word);
        if (found.length === limit) break;
    }
    return found;
}

export {
    APPROVAL_PROMPTS_A_DAY,
    approvalPromptsAllowed,
    type PromptRecord,
} from './approval-prompts';

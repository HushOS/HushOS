import { bytesOf, digestOf, integer, uuid } from './canonical';
import { CryptoError } from './errors';
import { fingerprint, hexBytes, keyDigest, publicKeyBytes } from './fingerprint';

/*
 * The rules a device applies to the pins and settings the server hands back.
 * Web Crypto only, so the main thread can apply them without libsodium.
 */

/*
 * Whether a pin stands for a words check over the keys it holds: a version 3
 * pin (docs/identity-pq-design.md), carrying the X25519 and Ed25519 keys, the
 * digests of the ML-DSA and ML-KEM keys, and the version 3 fingerprint over
 * all four. Pins made before (version 2, over X25519 and Ed25519 alone, or
 * made automatically) trust nothing until the two people compare words again,
 * whatever the server serves for that contact.
 */
export async function pinVerified(pin: {
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKeyHash?: string | null;
    kemPublicKeyHash?: string | null;
    fingerprint: string;
}) {
    if (!pin.signingPublicKey || !pin.mlDsaPublicKeyHash || !pin.kemPublicKeyHash) return false;
    try {
        const print = await fingerprint(
            canonicalKey(pin.encryptionPublicKey),
            canonicalKey(pin.signingPublicKey),
            hexBytes(pin.mlDsaPublicKeyHash),
            hexBytes(pin.kemPublicKeyHash),
        );
        return print === pin.fingerprint;
    } catch {
        return false;
    }
}

/*
 * The key fields of a contact pin, as every rule below reads them. A pin
 * comes out of the settings document, so any field may be missing or of
 * another type; every rule treats that as not holding.
 */
export type PinKeys = {
    keyVersion?: number | null;
    encryptionPublicKey: string;
    signingPublicKey: string;
    mlDsaPublicKeyHash?: string | null;
    kemPublicKeyHash?: string | null;
    fingerprint: string;
};

/*
 * The key commitment (docs/optional-verification.md 1): the version 3
 * fingerprint over a pin's four keys, whether or not anyone compared it. It is
 * how two pins, a pin and a guard entry, or a pin and a staged admission are
 * compared; the pin's own `fingerprint` never is, since every first-seen pin
 * holds `""` there. Null when a key field is missing or not in canonical form
 * (base64url keys, 64 lowercase hex digests), so a malformed pin matches
 * nothing. The Rust core's `key_commitment` is its twin.
 */
export async function keyCommitment(pin: Omit<PinKeys, 'fingerprint'>) {
    if (!pin.mlDsaPublicKeyHash || !pin.kemPublicKeyHash) return null;
    try {
        return await fingerprint(
            canonicalKey(pin.encryptionPublicKey),
            canonicalKey(pin.signingPublicKey),
            hexBytes(pin.mlDsaPublicKeyHash),
            hexBytes(pin.kemPublicKeyHash),
        );
    } catch {
        return null;
    }
}

/*
 * What a contact pin stands for (docs/optional-verification.md 2.2), the one
 * rule every client applies, twinned by the Rust core's `pin_trust`:
 * - verified: pinVerified, a words check over its four keys;
 * - seen: a first-seen pin, `fingerprint` exactly `""` with every key field
 *   well formed: the keys this person's devices first saw, which nobody
 *   checked;
 * - legacy: no ML-DSA digest, a pin from before post-quantum identities;
 * - invalid: anything else (a fingerprint over other keys, a malformed key).
 *   Treated as legacy: it can become first-seen again, never verified.
 */
export type PinTrust = 'verified' | 'seen' | 'legacy' | 'invalid';
export async function pinTrust(pin: PinKeys): Promise<PinTrust> {
    if (!pin.mlDsaPublicKeyHash) return 'legacy';
    if (await pinVerified(pin)) return 'verified';
    if (pin.fingerprint === '' && (await keyCommitment(pin)) !== null) return 'seen';
    return 'invalid';
}

/*
 * The key fields of a version 3 pin of keys the server serves: the X25519 and
 * Ed25519 keys, the digests of the ML-DSA and ML-KEM keys, the key version,
 * and the fingerprint: the version 3 one when the two people just compared
 * words (`verified`), `""` for a first-seen pin (`seen`). Refused when the
 * keys would not make a pin of that kind, so nothing malformed is pinned.
 * The Rust core's `pin_of_served` is its twin.
 */
export async function pinKeysOfServed(
    served: {
        keyVersion: number;
        encryptionPublicKey: string;
        signingPublicKey: string;
        mlDsaPublicKey: string;
        kemPublicKey: string;
    },
    form: 'verified' | 'seen',
) {
    let keys;
    try {
        const mlDsa = canonicalBytes(served.mlDsaPublicKey, 1952);
        const kem = canonicalBytes(served.kemPublicKey, 1184);
        keys = {
            encryptionPublicKey: served.encryptionPublicKey,
            signingPublicKey: served.signingPublicKey,
            mlDsaPublicKeyHash: await keyDigest(mlDsa),
            kemPublicKeyHash: await keyDigest(kem),
            keyVersion: integer(served.keyVersion, 'key version'),
        };
    } catch {
        throw new CryptoError('Invalid identity key.');
    }
    const commitment = await keyCommitment(keys);
    if (commitment === null) throw new CryptoError('Invalid identity key.');
    return { ...keys, fingerprint: form === 'verified' ? commitment : '' };
}

/*
 * Bytes in canonical base64url (of exactly `length`, when given), as the Rust core's decode
 * takes them: no padding, no other alphabet, no spare bits set. Anything else throws, so a key
 * written another way is never read as the same key on one client and refused on another.
 */
function canonicalBytes(value: string, length?: number) {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value))
        throw new Error('Invalid key.');
    const bytes = publicKeyBytes(value);
    let again = '';
    for (let at = 0; at < bytes.length; at += 0x8000)
        again += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    again = btoa(again).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    if ((length !== undefined && bytes.length !== length) || again !== value)
        throw new Error('Invalid key.');
    return bytes;
}

/*
 * SHA-256 (hex) of a public key as the server serves it, or null when it is not canonical
 * base64url: how a pin's digests are compared with served keys, alike in both twins (the Rust
 * core's `digest_of` decodes canonically too).
 */
export async function servedKeyDigest(value: unknown) {
    try {
        return await keyDigest(canonicalBytes(value as string));
    } catch {
        return null;
    }
}

/*
 * A 32-byte key in canonical base64url (no padding, no other alphabet), as every
 * client writes it; anything else throws, so a pin verifies on every client or
 * on none (the Rust core refuses the same encodings).
 */
function canonicalKey(value: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new Error('Invalid key.');
    const bytes = publicKeyBytes(value);
    // The last character carries 2 spare bits, which must be zero in the canonical form.
    if (!/[AEIMQUYcgkosw048]$/.test(value) || bytes.length !== 32) throw new Error('Invalid key.');
    return bytes;
}

/*
 * Whether settings the server served are older than this device has seen: an
 * older version, or none at all after one was seen. The server keeps the
 * settings and could otherwise bring back a pin the person replaced or drop
 * one they made.
 */
export function settingsRolledBack(served: number | null, seen: number) {
    return served === null ? seen > 0 : served < seen;
}

/*
 * What the settings document keeps per group (docs/groups-design.md 2.7): the
 * version 1 group key whose words were checked (the ML-DSA key by its
 * SHA-256, base64url, since the document has no room for the key), when, and
 * the marks a server must never take back: the latest roster this person's
 * devices accepted (version and digest), the group key at that point
 * (version and the digest of both halves), and per area the highest
 * workspace key version opened. Every device verifies the roster chain from
 * version 1; the pin is never a starting point, only a mark the served chain
 * must reach (else a rollback) and pass through (else a fork).
 */
export type GroupPin = {
    firstEd25519PublicKey: string;
    firstMlDsaPublicKeyDigest: string;
    checkedAt: string;
    keyVersion: number;
    groupKeyDigest: string;
    rosterVersion: number;
    rosterDigest: string;
    areas: Record<string, number>;
};

/*
 * A group pin as the settings document holds it, or refused: canonical
 * base64url keys and digests, versions from 1 to 2^53 - 1, lowercase area
 * ids, and nothing else. A pin that does not pass is not a pin, and nothing
 * is trusted through it.
 */
/*
 * A check time as pins carry it: the 24 ASCII characters of an ISO 8601 UTC
 * time to the millisecond (`Date.prototype.toISOString`), so every client
 * orders check times alike, byte by byte.
 */
const CHECK_TIME =
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
export function checkTime(value: unknown) {
    if (typeof value !== 'string' || !CHECK_TIME.test(value))
        throw new CryptoError('Invalid group pin.');
    return value;
}

export function checkGroupPin(groupId: string, value: unknown): GroupPin {
    uuid(groupId, 'group id');
    if (typeof value !== 'object' || value === null) throw new CryptoError('Invalid group pin.');
    const pin = value as GroupPin;
    checkTime(pin.checkedAt);
    if (typeof pin.areas !== 'object' || pin.areas === null || Array.isArray(pin.areas))
        throw new CryptoError('Invalid group pin.');
    // Every id, then every version: the refusal names the same field whatever order the keys are
    // in (the Rust core's `group_pin_check` holds the same order).
    for (const workspaceId of Object.keys(pin.areas)) uuid(workspaceId, 'workspace id');
    const areas: Record<string, number> = {};
    for (const [workspaceId, version] of Object.entries(pin.areas))
        areas[workspaceId] = integer(version, 'workspace key version');
    return {
        firstEd25519PublicKey: bytesOf(pin.firstEd25519PublicKey, 32, 'group key'),
        firstMlDsaPublicKeyDigest: digestOf(pin.firstMlDsaPublicKeyDigest, 'key digest'),
        checkedAt: pin.checkedAt,
        keyVersion: integer(pin.keyVersion, 'group key version'),
        groupKeyDigest: digestOf(pin.groupKeyDigest, 'key digest'),
        rosterVersion: integer(pin.rosterVersion, 'roster version'),
        rosterDigest: digestOf(pin.rosterDigest, 'roster digest'),
        areas,
    };
}

/*
 * An area this device opened (groupOpenArea's `pinArea`), with the family it
 * was opened under: what mergePin folds in from `opened`. The chain's or the
 * server's list of areas never adds one. `current` and `next` are plain pins,
 * though: areas written into them by hand would only raise an area's mark (and
 * the next acceptance then needs that key version), which is the limit of
 * this rule; the only `next` is an acceptance's `pin`.
 */
export type OpenedArea = { groupId: string; workspaceId: string; version: number };

/*
 * `next`, with the opened areas folded in, as it may be saved over `current`
 * (docs/groups-design.md 2.7; apps/web/src/lib/groups/pins.ts settles it):
 * - null when `current` is ahead of it (a later roster or group key), so it
 *   must not be written;
 * - 'conflict' when the two name other first keys, or other rosters or group
 *   keys at one version: never saved over, and acceptance (run again with the
 *   settings pin as a mark) says what it is.
 * An opened area of another family than `groupId` is refused. Pure: the Rust
 * core's `merge_pin` is its twin.
 */
export function mergePin(
    groupId: string,
    current: GroupPin | null,
    next: GroupPin,
    opened: readonly OpenedArea[] = [],
): GroupPin | null | 'conflict' {
    if (opened.some((area) => area.groupId !== groupId))
        throw new CryptoError('This folder is not one of this family’s.');
    if (current) {
        if (
            current.firstEd25519PublicKey !== next.firstEd25519PublicKey ||
            current.firstMlDsaPublicKeyDigest !== next.firstMlDsaPublicKeyDigest
        )
            return 'conflict';
        if (
            (current.rosterVersion === next.rosterVersion &&
                current.rosterDigest !== next.rosterDigest) ||
            (current.keyVersion === next.keyVersion &&
                current.groupKeyDigest !== next.groupKeyDigest)
        )
            return 'conflict';
        if (current.rosterVersion > next.rosterVersion || current.keyVersion > next.keyVersion)
            return null;
    }
    const areas: Record<string, number> = { ...current?.areas };
    for (const [workspaceId, version] of Object.entries(next.areas))
        areas[workspaceId] = Math.max(areas[workspaceId] ?? 0, version);
    for (const { workspaceId, version } of opened)
        areas[workspaceId] = Math.max(areas[workspaceId] ?? 0, version);
    return {
        ...next,
        // The earliest words check stands, whichever side made it.
        checkedAt:
            current && current.checkedAt < next.checkedAt ? current.checkedAt : next.checkedAt,
        areas,
    };
}

/*
 * The family guard after an acceptance (docs/optional-verification.md 2.8):
 * the held guard merged with the accepted `pin` and the folders opened on
 * this device (mergePin), only when that records anything new (pinAhead);
 * null when it is behind, conflicts, or adds nothing, so a guard never goes
 * down. The Rust core's `guard_after` is its twin.
 */
export function guardAfter(
    groupId: string,
    guard: GroupPin | null,
    pin: GroupPin,
    opened: readonly OpenedArea[] = [],
): GroupPin | null {
    const merged = mergePin(groupId, guard, pin, opened);
    if (merged === null || merged === 'conflict') return null;
    return pinAhead(guard, merged) ? merged : null;
}

/* Whether saving `next` over `current` records anything new (the core's `pin_ahead`). */
export function pinAhead(current: GroupPin | null, next: GroupPin) {
    if (!current) return true;
    if (next.rosterVersion > current.rosterVersion || next.keyVersion > current.keyVersion)
        return true;
    if (next.checkedAt < current.checkedAt) return true;
    return Object.entries(next.areas).some(
        ([workspaceId, version]) => version > (current.areas[workspaceId] ?? 0),
    );
}

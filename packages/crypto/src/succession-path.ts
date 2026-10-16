import { keyDigest } from './fingerprint';
import {
    verifySuccessionConsent,
    verifySuccessionLink,
    type PinnedKeys,
    type ServedKeys,
    type SuccessionLink,
} from './identity';
import { decode } from './keys';
import { ML_DSA_PUBLIC_KEY_BYTES } from './pq';

/*
 * The group core's own way along a member's succession links (group-trust.ts
 * and the seal openers in groups.ts use it; personal pins keep the shipped
 * strict verifier, verifySuccessionChain, whose callers rely on its chain
 * being contiguous in the order served, and which must never reuse this
 * walk's `verified` map: the two accept links on different proofs).
 *
 * Each link is verified once, under its proof:
 * - by default its version 2 signature under the old keys it names (what every
 *   shipped client signs): the roster-lag walk, the personal-pin walk and
 *   foldInEntry, where a holder's planted keys never start;
 * - with `consentUntil`, its successor consent (both the old keys and the new
 *   keys it names sign `hushos/identity/succession-consent`) for every link
 *   until the walk reaches those keys, and its version 2 signature after: the
 *   walk from a member's first keys to their entry's, which a holder who
 *   planted the first keys could otherwise bridge to the real identity with a
 *   link signed from the planted keys alone. The group walk never checks a
 *   consented link's version 2 signature, so it and the personal verifier can
 *   disagree on one link.
 * The verified links form a graph between sets of keys. From `start` (matched
 * by X25519, Ed25519 and the ML-DSA key's digest) the reachable part must be a
 * single line:
 * - a set of keys with two verified links leaving it, to different keys, is an
 *   identity fork of the member (two of their devices succeeded at once, or a
 *   retried upload made a second successor): 'fork', whatever order the links
 *   were served in, since nothing tells which identity is theirs now;
 * - otherwise the line is followed to the served keys ('path', the links in
 *   order), or it ends, or loops, short of them ('none');
 * - a verified link leaving the served keys means the served identity is not
 *   the member's latest (the server rolled it back): 'stale', which readers
 *   treat as unchecked, never as a verdict on the member's records. That holds
 *   when the start itself is the served identity (its three keys match): a
 *   rollback to the entry's own keys is stale too;
 * - more than MAX_SUCCESSION_LINKS links that could join the member's chain
 *   (from the start, from one of `memberKeys`, or from a link the walk
 *   followed): 'too-many', checked no further (each costs two hybrid
 *   verifications). Links with other old keys are never verified and never
 *   counted. The member's own keys are public, so a server can always make a
 *   walk overflow; readers treat 'too-many' as links that did not load
 *   (group-trust.ts), which costs retirement and leaves unknown keys
 *   unchecked, never a verdict on the member.
 * The served identity's key version is not signed, so it decides nothing: the
 * served keys are matched by their four keys alone.
 * Junk, links out of order and duplicates of one link change nothing. The
 * work is at most one verification per link and proof and one step per link.
 * `verified`, which a caller may share across calls for a session, is keyed
 * by the SHA-256 of the member, the proof and the link's fields named one by
 * one, and holds at most MAX_VERIFIED_LINKS results, the least recently used
 * dropped first.
 */
export type SuccessionPath =
    | { status: 'path'; links: SuccessionLink[] }
    | { status: 'fork' }
    | { status: 'stale' }
    | { status: 'too-many' }
    | { status: 'none' };

/* The most succession links one identity may carry: far beyond any honest history. */
export const MAX_SUCCESSION_LINKS = 64;

/* The most verification results a shared `verified` map keeps. */
export const MAX_VERIFIED_LINKS = 4096;

/* The SHA-256 of a base64url ML-DSA public key, as hex; null when it is not one. */
async function mlDsaHash(publicKey: string) {
    try {
        return await keyDigest(decode(publicKey, ML_DSA_PUBLIC_KEY_BYTES));
    } catch {
        return null;
    }
}

/* Whether a link's new keys are `keys` (X25519, Ed25519 and the ML-DSA key's digest). */
async function leadsTo(link: SuccessionLink, keys: PinnedKeys) {
    return (
        link.newEncryptionPublicKey === keys.encryptionPublicKey &&
        link.newSigningPublicKey === keys.signingPublicKey &&
        (await mlDsaHash(link.newMlDsaPublicKey)) === keys.mlDsaPublicKeyHash
    );
}

const sameKeys = (a: PinnedKeys, b: PinnedKeys) =>
    a.encryptionPublicKey === b.encryptionPublicKey &&
    a.signingPublicKey === b.signingPublicKey &&
    a.mlDsaPublicKeyHash === b.mlDsaPublicKeyHash;

/*
 * A link's fields as plain values, or null when one is not the type a link
 * carries: what the walk verifies and what it remembers the verification by,
 * so no serialization hook or field order can make two links share one.
 */
function snapshot(link: SuccessionLink) {
    const text = (value: unknown) => typeof value === 'string';
    const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value);
    if (
        typeof link !== 'object' ||
        link === null ||
        !count(link.oldKeyVersion) ||
        !count(link.newKeyVersion) ||
        ![
            link.oldEncryptionPublicKey,
            link.oldSigningPublicKey,
            link.oldMlDsaPublicKey,
            link.newEncryptionPublicKey,
            link.newSigningPublicKey,
            link.newMlDsaPublicKey,
            link.newKemPublicKey,
            link.signature,
        ].every(text) ||
        !(link.consent === undefined || link.consent === null || text(link.consent))
    )
        return null;
    return {
        oldKeyVersion: link.oldKeyVersion,
        newKeyVersion: link.newKeyVersion,
        oldEncryptionPublicKey: link.oldEncryptionPublicKey,
        oldSigningPublicKey: link.oldSigningPublicKey,
        oldMlDsaPublicKey: link.oldMlDsaPublicKey,
        newEncryptionPublicKey: link.newEncryptionPublicKey,
        newSigningPublicKey: link.newSigningPublicKey,
        newMlDsaPublicKey: link.newMlDsaPublicKey,
        newKemPublicKey: link.newKemPublicKey,
        signature: link.signature,
        consent: link.consent ?? null,
    };
}

export async function successionPath(
    userId: string,
    start: PinnedKeys,
    served: ServedKeys,
    links: SuccessionLink[],
    options: {
        verified?: Map<string, boolean>;
        consentUntil?: PinnedKeys | null;
        /* The member's key sets on the chain: links from them count toward the cap. */
        memberKeys?: PinnedKeys[];
    } = {},
): Promise<SuccessionPath> {
    const verified = options.verified ?? new Map<string, boolean>();
    const consentUntil = options.consentUntil ?? null;
    const snapshots = links.map(snapshot);
    const holds = async (index: number, consent: boolean) => {
        const link = snapshots[index];
        if (!link) return false;
        const key = Array.from(
            new Uint8Array(
                await crypto.subtle.digest(
                    'SHA-256',
                    new TextEncoder().encode(
                        JSON.stringify([userId, consent, ...Object.values(link)]),
                    ),
                ),
            ),
            (byte) => byte.toString(16).padStart(2, '0'),
        ).join('');
        let held = verified.get(key);
        if (held === undefined) {
            held = consent
                ? await verifySuccessionConsent(userId, link)
                : await verifySuccessionLink(userId, link, {
                      signingPublicKey: link.oldSigningPublicKey,
                      mlDsaPublicKey: link.oldMlDsaPublicKey,
                  });
        } else verified.delete(key);
        // Most recently used last; the oldest go once the map is full.
        verified.set(key, held);
        for (const oldest of verified.keys()) {
            if (verified.size <= MAX_VERIFIED_LINKS) break;
            verified.delete(oldest);
        }
        return held;
    };
    const keysOf = (l: SuccessionLink) =>
        JSON.stringify([
            l.newEncryptionPublicKey,
            l.newSigningPublicKey,
            l.newMlDsaPublicKey,
            l.newKemPublicKey,
        ]);
    const oldHashes = await Promise.all(
        snapshots.map((link) => (link ? mlDsaHash(link.oldMlDsaPublicKey) : Promise.resolve(null))),
    );
    const leavesSet = (index: number, keys: PinnedKeys) =>
        snapshots[index] !== null &&
        snapshots[index]!.oldEncryptionPublicKey === keys.encryptionPublicKey &&
        snapshots[index]!.oldSigningPublicKey === keys.signingPublicKey &&
        oldHashes[index] === keys.mlDsaPublicKeyHash;
    // The cap counts only links that could join the member's chain: from the start, from one of
    // their key sets on the chain, or from a link the walk followed. Junk with other old keys is
    // free (it is never verified), so serving it suppresses no verdict.
    const counted = new Set<number>();
    links.forEach((_, index) => {
        if ([start, ...(options.memberKeys ?? [])].some((keys) => leavesSet(index, keys)))
            counted.add(index);
    });
    if (counted.size > MAX_SUCCESSION_LINKS) return { status: 'too-many' };
    const servedHash = await mlDsaHash(served.mlDsaPublicKey);
    // Where the walk is: the start (its ML-DSA key known by digest only), then a link's new keys.
    let at: SuccessionLink | null = null;
    // Consent is asked of every link until the walk has reached `consentUntil`.
    let consenting = consentUntil !== null && !sameKeys(start, consentUntil);
    const seen = new Set<string>();
    const path: SuccessionLink[] = [];
    for (let step = 0; step <= links.length; step++) {
        const atServed =
            at === null
                ? start.encryptionPublicKey === served.encryptionPublicKey &&
                  start.signingPublicKey === served.signingPublicKey &&
                  servedHash !== null &&
                  start.mlDsaPublicKeyHash === servedHash
                : at.newEncryptionPublicKey === served.encryptionPublicKey &&
                  at.newSigningPublicKey === served.signingPublicKey &&
                  at.newMlDsaPublicKey === served.mlDsaPublicKey &&
                  at.newKemPublicKey === served.kemPublicKey;
        const continuing: number[] = [];
        links.forEach((_, index) => {
            const link = snapshots[index];
            if (!link) return;
            const continues = at
                ? link.oldEncryptionPublicKey === at.newEncryptionPublicKey &&
                  link.oldSigningPublicKey === at.newSigningPublicKey &&
                  link.oldMlDsaPublicKey === at.newMlDsaPublicKey &&
                  link.oldKeyVersion >= at.newKeyVersion
                : leavesSet(index, start) && link.oldKeyVersion >= (start.keyVersion ?? 0);
            if (continues) continuing.push(index);
        });
        for (const index of continuing) counted.add(index);
        if (counted.size > MAX_SUCCESSION_LINKS) return { status: 'too-many' };
        const leaving: SuccessionLink[] = [];
        for (const index of continuing)
            if (await holds(index, consenting)) leaving.push(links[index]!);
        // At the served identity: done, unless a verified link leaves it (a rollback). A start
        // that is the served identity with nothing leaving it is no path: there was no change.
        if (atServed)
            return leaving.length
                ? { status: 'stale' }
                : at === null
                  ? { status: 'none' }
                  : { status: 'path', links: path };
        const targets = new Set(leaving.map(keysOf));
        if (targets.size > 1) return { status: 'fork' };
        const next = leaving[0];
        if (!next || seen.has(keysOf(next))) return { status: 'none' };
        seen.add(keysOf(next));
        path.push(next);
        at = next;
        if (consenting && (await leadsTo(next, consentUntil!))) consenting = false;
    }
    return { status: 'none' };
}

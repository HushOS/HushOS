import {
    verifyIdentityKeys,
    verifySuccessionChain,
    type ServedKeys,
    type SuccessionLink,
} from './identity';
import { keyCommitment, pinKeysOfServed, pinTrust, type GuardEntry, type PinKeys } from './pins';

/*
 * First-seen pins (docs/optional-verification.md 2): the rules that let a
 * device remember the keys it first saw for a person, and notice when the
 * settings document stops agreeing with what this device has seen. Pure:
 * the guard's store is the app's (an IndexedDB store on the web, its own
 * store on each phone); these say what its entries mean. The Rust core's
 * `first_seen.rs` is the twin.
 */

/* Pure, so the web's main thread takes them without libsodium; re-exported here as before. */
export { nextGuardEntry, type GuardEntry } from './pins';

/*
 * A pin from before post-quantum identities, or a malformed one (pinTrust
 * `legacy` or `invalid`), as a first-seen pin of the served keys (2.5): only
 * when its X25519 and Ed25519 keys are the served ones and the served keys
 * statement holds, so the ML-DSA and ML-KEM keys are signed by the very
 * Ed25519 key the person pinned before. Never verified: trust is not carried
 * forward on Ed25519 alone (docs/identity-pq-design.md 2). Null when the rule
 * does not apply (another key, a statement that does not hold, a pin that is
 * verified or first-seen already); the pin is then left as it is.
 */
export async function firstSeenOfLegacy<T extends PinKeys>(
    userId: string,
    pin: T,
    served: {
        keyVersion: number;
        encryptionPublicKey: string;
        signingPublicKey: string;
        mlDsaPublicKey: string;
        kemPublicKey: string;
        keysSignature: string;
    },
): Promise<T | null> {
    const trust = await pinTrust(pin);
    if (trust !== 'legacy' && trust !== 'invalid') return null;
    if (
        pin.encryptionPublicKey !== served.encryptionPublicKey ||
        pin.signingPublicKey !== served.signingPublicKey
    )
        return null;
    if (!(await verifyIdentityKeys(userId, served))) return null;
    try {
        return { ...pin, ...(await pinKeysOfServed(served, 'seen')) };
    } catch {
        return null;
    }
}

/*
 * Whether a device may act on a person through the settings pin it holds now
 * (2.8, "The rule"):
 * - first-use: this device has no guard entry for them;
 * - agrees: the pin's keys are the guard's (by key commitment);
 * - follows: the pin's keys are the served ones, and a succession chain this
 *   device verifies itself leads to them from the guard's keys (never from
 *   the pin's, nor from anything a link supplies): taken silently, and the
 *   guard moves on;
 * - changed: anything else, a pin missing from the settings included: paused
 *   for that person until Continue or a check (2.4);
 * - unchecked: the guard could not be read, which is never first use.
 * A `previousSigningKeys` list in the settings never stands in for the chain:
 * it is only what some device saw.
 */
export type GuardVerdict = 'first-use' | 'agrees' | 'follows' | 'changed' | 'unchecked';
export async function guardAgrees(
    userId: string,
    guard: GuardEntry | null | 'unreadable',
    pin: PinKeys | null,
    succession: { served: ServedKeys; links: SuccessionLink[] } | null = null,
): Promise<GuardVerdict> {
    if (guard === 'unreadable') return 'unchecked';
    if (guard === null) return 'first-use';
    if (pin === null) return 'changed';
    const trust = await pinTrust(pin);
    if (trust !== 'verified' && trust !== 'seen') return 'changed';
    const held = await keyCommitment(guard);
    const keys = await keyCommitment(pin);
    if (held === null || keys === null) return 'changed';
    if (keys === held) return 'agrees';
    if (!succession) return 'changed';
    let served;
    try {
        served = await pinKeysOfServed(succession.served, 'seen');
    } catch {
        return 'changed';
    }
    if ((await keyCommitment(served)) !== keys) return 'changed';
    const valid = await verifySuccessionChain(
        userId,
        {
            keyVersion: guard.keyVersion,
            encryptionPublicKey: guard.encryptionPublicKey,
            signingPublicKey: guard.signingPublicKey,
            mlDsaPublicKeyHash: guard.mlDsaPublicKeyHash,
        },
        succession.served,
        succession.links,
    );
    return valid ? 'follows' : 'changed';
}

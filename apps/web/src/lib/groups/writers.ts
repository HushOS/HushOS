import type { GroupWriter } from '@hushos/crypto';
import { pinVerified } from '@hushos/crypto/pins';
import { signersFromPins, type Pin } from '@hushos/drive/trust';
import type { GroupContext } from './context';
import { pinsById } from '@/lib/family-pin';
import { fetchIdentities } from './sync';

/*
 * Who may have written what a family folder holds, as group verdicts take
 * them (design 2.8, groupVerify): every entry route 6 serves for the family
 * (their identity and succession links), each with this person's version 3
 * pin of them and where that pin came from, and the personal keys a record
 * the member list does not speak for is checked against. Contacts outside
 * the family come with their personal keys alone.
 *
 * Route 6 failing is not a refusal: the members then go without served keys
 * or links, which the worker reads as "did not load" (a signature none of
 * their known keys holds is `unchecked`, never bad).
 */
export async function groupWriters(
    ctx: GroupContext,
    groupId: string,
    contacts: Record<string, Pin>,
): Promise<GroupWriter[]> {
    const identities = await fetchIdentities(ctx, groupId).catch(() => new Map<string, never>());
    // Ids compared without case on both sides: the worker finds a writer's roster entry by the
    // lowercased id, so a server serving a member's id in other letters must not lose their pin
    // (and with it the key-conflict warning a planted entry raises).
    // Two pins of one person in different case: the one from this person's own words check wins.
    const pins = pinsById(contacts);
    const chosen = Object.fromEntries([...pins.values()].map((pin) => [pin.userId, pin]));
    const personal = new Map(
        Object.entries(await signersFromPins(chosen)).map(([id, signer]) => [
            id.toLowerCase(),
            signer,
        ]),
    );
    const out = new Map<string, GroupWriter>();
    const pinOf = async (userId: string): Promise<GroupWriter['pinned']> => {
        const pin = pins.get(userId.toLowerCase());
        if (!pin || !pin.mlDsaPublicKeyHash || !(await pinVerified(pin))) return null;
        return {
            keyVersion: pin.keyVersion ?? null,
            encryptionPublicKey: pin.encryptionPublicKey,
            signingPublicKey: pin.signingPublicKey,
            mlDsaPublicKeyHash: pin.mlDsaPublicKeyHash,
            // Explicitly null for a pin from this person's own words check: the worker reads a
            // missing origin as no verdict at all (a caller must not drop it).
            trustedVia: pin.trustedVia ?? null,
        };
    };
    for (const [userId, member] of identities)
        out.set(userId.toLowerCase(), {
            userId,
            pinned: await pinOf(userId),
            served: member.identity
                ? {
                      keyVersion: member.identity.keyVersion,
                      encryptionPublicKey: member.identity.encryptionPublicKey,
                      signingPublicKey: member.identity.signingPublicKey,
                      mlDsaPublicKey: member.identity.mlDsaPublicKey,
                      kemPublicKey: member.identity.kemPublicKey,
                  }
                : null,
            links: member.identity ? member.links : null,
            personal: personal.get(userId.toLowerCase()) ?? null,
        });
    for (const [userId, signer] of personal)
        if (!out.has(userId))
            out.set(userId.toLowerCase(), {
                userId,
                pinned: await pinOf(userId),
                served: null,
                links: null,
                personal: signer,
            });
    return [...out.values()];
}

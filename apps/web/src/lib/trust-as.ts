import type { QueryClient } from '@tanstack/react-query';
import { authClient } from '@/lib/auth-client';
import { contactPins, saveSettings } from '@/lib/contacts';
import { familyContext } from '@/lib/families';
import { familyPin, OWN_CHECK_STAYS, pinOf } from '@/lib/family-pin';
import { groupsApi } from '@/lib/groups/api';
import { fetchIdentities, syncGroup } from '@/lib/groups/sync';
import { afterTrustChanged } from '@/lib/integrity';

/*
 * Taking a writer's keys on a family's word (design 2.8, "Trust as Acme
 * does"; the 1c plan's F12), for records outside that family's folders: a
 * person nobody checked who is active in one of this person's families.
 * Loaded only from the Unverified popover.
 */

export type Vouching = {
    groupId: string;
    family: string;
    userId: string;
    name: string;
    email: string;
};

/*
 * The first family this account is active in where `writerId` is an active
 * member, with their name and address as the server gives them (decision
 * D10: the member list vouches for keys, never for names), or null.
 */
export async function familyVouching(userId: string, writerId: string): Promise<Vouching | null> {
    // Someone whose words this person compared themselves is never offered on a family's word.
    const before = pinOf(await contactPins(userId), writerId)?.pin;
    if (before && !before.trustedVia) return null;
    const { groups } = await groupsApi.listGroups();
    for (const group of groups) {
        if (group.state !== 'active') continue;
        const detail = await groupsApi.group(group.id).catch(() => null);
        const member = detail?.members.find(
            (at) => at.userId.toLowerCase() === writerId.toLowerCase() && at.state === 'active',
        );
        if (member?.email)
            return {
                groupId: group.id,
                family: group.name,
                userId: member.userId,
                name: member.name,
                email: member.email,
            };
    }
    return null;
}

/*
 * Writes the version 3 pin of the writer from the family's member list: the
 * family is synced first (the worker's committed chain is what vouches), the
 * keys route 6 serves must be the ones their entry names (groupTrustAs
 * refuses anything else), and the pin records `trustedVia` so a words check
 * replaces it and no admission is ever built on it.
 */
export async function trustAsFamily(queryClient: QueryClient, userId: string, found: Vouching) {
    // Checked before anything is fetched: a pin of one's own words check is never replaced.
    const before = pinOf(await contactPins(userId), found.userId)?.pin;
    if (before && !before.trustedVia) throw new Error(OWN_CHECK_STAYS);
    const ctx = familyContext(userId);
    const synced = await syncGroup(ctx, found.groupId);
    if (synced.status !== 'accepted') throw new Error(`Couldn’t check ${found.family}. Try again.`);
    const served = (await fetchIdentities(ctx, found.groupId)).get(found.userId)?.identity;
    if (!served) throw new Error('HushOS couldn’t load their keys. Try again.');
    const { pin } = await authClient.rpc('groupTrustAs', {
        groupId: found.groupId,
        userId: found.userId,
        served,
        contact: { email: found.email, name: found.name, pinnedAt: new Date().toISOString() },
    });
    await saveSettings(queryClient, userId, (settings) => {
        // Over the pin of that person whatever case their id was stored in, under its own key.
        const held = pinOf(settings.contacts, pin.userId);
        settings.contacts[held?.key ?? pin.userId] = familyPin(held?.pin, pin, {
            groupId: found.groupId,
            name: found.family,
        });
        return settings;
    });
    afterTrustChanged(queryClient);
}

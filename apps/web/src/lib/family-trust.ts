import type { GroupRole, GroupView, PairCode } from '@hushos/crypto';
import { rosterDigest } from '@hushos/crypto/groups';
import { entryCommitment, keyCommitment, pinTrust } from '@hushos/crypto/pins';
import type { QueryClient } from '@tanstack/react-query';
import {
    addContact,
    contactGuardEntry,
    contactPins,
    contactStandings,
    continueWith,
    lookupContact,
    saveFamilyCheck,
    type Pin,
} from '@/lib/contacts';
import { pinOf } from '@/lib/family-pin';
import type { GroupContext } from '@/lib/groups/context';
import { memberJoinCode } from '@/lib/groups/join';
import { letIn } from '@/lib/groups/outbox';
import { clearPendingRoles } from '@/lib/family-pending';
import { continueFoldIn } from '@/lib/groups/removal';
import { fetchServed, syncGroup } from '@/lib/groups/sync';

/*
 * Who in a family this person checked, and the acts that change it, for the
 * family page (docs/optional-verification.md 3.2, 3.4, 3.6, 3.8, 6.8 to 6.10).
 * Per viewer, never shared: everything here reads this account's own
 * settings pins and this device's guard, beside the member list this device
 * accepted.
 */

/*
 * How the member list reads a member (3.8): `verified` only when this
 * account's own verified pin of them (never a family's word) agrees with this
 * device's guard and names the very keys of their entry now, which is also
 * the manager rule (3.6); `changed` when the pin disagrees with the guard;
 * anything else `not-verified`.
 */
export type MemberStanding = 'verified' | 'not-verified' | 'changed';

export async function memberStandings(
    userId: string,
    view: Pick<GroupView, 'members'>,
): Promise<Map<string, MemberStanding>> {
    const [standings, pins] = await Promise.all([contactStandings(userId), contactPins(userId)]);
    const out = new Map<string, MemberStanding>();
    for (const entry of view.members) {
        if (entry.userId.toLowerCase() === userId.toLowerCase()) continue;
        out.set(
            entry.userId,
            await memberStanding(
                entry,
                pinOf(pins, entry.userId)?.pin ?? null,
                standings.get(entry.userId.toLowerCase()),
            ),
        );
    }
    return out;
}

/* One member, from their entry, this account's pin of them and its standing on this device. */
export async function memberStanding(
    entry: GroupView['members'][number],
    pin: Pin | null,
    standing: { verified: boolean; changed: boolean } | undefined,
): Promise<MemberStanding> {
    if (standing?.changed) return 'changed';
    if (!pin || !standing?.verified) return 'not-verified';
    if (pin.trustedVia) return 'not-verified';
    if ((await pinTrust(pin)) !== 'verified') return 'not-verified';
    const [held, named] = await Promise.all([keyCommitment(pin), entryCommitment(entry)]);
    return held !== null && held === named ? 'verified' : 'not-verified';
}

/* A role that needs a check first (3.6): managing the family, and being its organizer (6.9). */
export function needsCheckFor(roles: readonly GroupRole[], next: readonly GroupRole[]) {
    return (
        (next.includes('members') && !roles.includes('members')) ||
        (next.includes('billing') && !roles.includes('billing'))
    );
}

/*
 * The family check's words with `member` (6.10, "Getting the latest" first):
 * the family synced to the server's head, then the pair code over this
 * device's committed chain, with the roster's version and digest for
 * Technical details.
 */
export async function familyCheckCode(
    ctx: GroupContext,
    groupId: string,
    memberUserId: string,
): Promise<PairCode & { rosterDigest?: string }> {
    const synced = await syncGroup(ctx, groupId);
    if (synced.status === 'fork')
        throw new Error(
            'This family looks different on this device. Check it from the family page.',
        );
    if (synced.status !== 'accepted') throw new Error('HushOS couldn’t check this right now.');
    const { served } = await fetchServed(ctx, groupId, 0);
    const code = await ctx.rpc('groupPairCode', {
        groupId,
        userId: memberUserId,
        rosters: served.rosters,
    });
    if (code.status === 'not-admitted') return code;
    const at = served.rosters[code.rosterVersion - 1];
    return {
        ...code,
        ...(at ? { rosterDigest: await rosterDigest(fromBase64url(at.statement)) } : {}),
    };
}

function fromBase64url(value: string) {
    return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (char) =>
        char.charCodeAt(0),
    );
}

/*
 * "They match" in a family check: what the worker allows, saved. `checked`
 * when the check record was saved (the codes matched on this device),
 * `verified` when a verified pin of them was too (their keys are the ones
 * their entry named when they joined, and the ones this device holds).
 */
export async function familyCheckMatch(
    queryClient: QueryClient,
    userId: string,
    ctx: GroupContext,
    groupId: string,
    member: { userId: string; email: string; name: string },
    shown: { rosterVersion: number; code: string[] },
) {
    // Read first, so the worker holds the settings pin of them it compares with.
    await ctx.settings.read();
    const guard = await contactGuardEntry(userId, member.userId);
    const { served } = await fetchServed(ctx, groupId, 0);
    const match = await ctx.rpc('groupPairMatch', {
        groupId,
        userId: member.userId,
        rosters: served.rosters,
        rosterVersion: shown.rosterVersion,
        code: shown.code,
        guard,
        now: ctx.now().toISOString(),
    });
    if (!match.check) return { checked: false, verified: false };
    const saved = await saveFamilyCheck(queryClient, userId, {
        groupId,
        member,
        check: match.check,
        keys: match.pin,
        decidedOver: guard,
    });
    return { checked: true, verified: saved.verified };
}

/* The older-app path (6.10): the old join code, read to a 0.10.0 phone. Saves nothing. */
export async function olderAppCode(ctx: GroupContext, groupId: string, memberUserId: string) {
    return (await memberJoinCode(ctx, groupId, memberUserId)).code;
}

/*
 * This account's pin of someone it is about to put in a family entry, from the
 * keys HushOS serves now: the pin it holds when they agree, else a first-seen
 * pin written now (`firstSeen: family`). A change from what this device holds
 * is the changed-account notice, never a silent new pin.
 */
export async function pinForFamily(
    queryClient: QueryClient,
    userId: string,
    person: { userId: string; email: string },
) {
    const added = await addContact(queryClient, userId, person.email, person.userId, 'family');
    if (added.outcome === 'changed') return added;
    return { outcome: 'pinned' as const, pin: added.pin };
}

/*
 * "Let them in" (6.8): one click. The newcomer pinned first-seen when this
 * account has no pin of them (or the one it holds), the roles asked for at
 * invitation kept only where a check allows them (3.2, 3.6: a manager joins
 * as a member until checked), then the admission signed over that pin and
 * sent (letIn). `heldBack` names the roles held back for a check.
 */
export async function letInWithoutWords(
    queryClient: QueryClient,
    userId: string,
    ctx: GroupContext,
    groupId: string,
    person: {
        userId: string;
        email: string;
        roles: GroupRole[];
        identity: Parameters<typeof letIn>[2]['served'];
    },
) {
    // The server's roles can only hold a role back here, never record that one is owed: only the
    // inviter's own record of Invite someone does that (lib/family-pending.ts).
    const pinned = await pinForFamily(queryClient, userId, person);
    if (pinned.outcome === 'changed') return pinned;
    const verified = (await pinTrust(pinned.pin)) === 'verified' && !pinned.pin.trustedVia;
    const roles = verified ? person.roles : person.roles.filter((role) => role !== 'members');
    const staged = await letIn(
        ctx,
        groupId,
        { kind: 'admit', userId: person.userId, served: person.identity, roles },
        pinned.pin,
    );
    return {
        outcome: 'staged' as const,
        staged,
        heldBack: person.roles.filter((role) => !roles.includes(role)),
    };
}

/*
 * Continue on members' account changes (6.9): for each of them, the keys
 * HushOS serves now pinned (Continue on the contact, or first-seen when this
 * account had no pin of them), then one roster that writes them all into
 * their entries and gives every family folder new keys in the same change
 * (3.3). A manager among them keeps the role only over a verified pin;
 * otherwise it waits for a check (3.6).
 */
export async function continueMembers(
    queryClient: QueryClient,
    userId: string,
    ctx: GroupContext,
    groupId: string,
    members: readonly { userId: string; email: string; name: string }[],
    /* First names by user id, to name another member whose account changed too. */
    names: Record<string, string> = {},
) {
    for (const member of members) {
        const found = await lookupContact(queryClient, userId, member.email);
        if (found.contact.userId.toLowerCase() !== member.userId.toLowerCase())
            throw new Error('That address now belongs to a different account.');
        if (found.changed)
            await continueWith(queryClient, userId, {
                contactId: member.userId,
                name: member.name,
                email: member.email,
            });
        else if (!found.pinned) {
            const added = await pinForFamily(queryClient, userId, member);
            if (added.outcome === 'changed') await continueWith(queryClient, userId, added.change);
        }
    }
    const staged = await continueFoldIn(
        ctx,
        groupId,
        members.map((member) => member.userId),
        names,
    );
    // A role held back for them waited on a check of the keys they had: it goes with them (6.9).
    if (staged.status === 'sent' && staged.outcome.status === 'landed')
        await clearPendingRoles(
            queryClient,
            userId,
            groupId,
            members.map((member) => member.userId),
        ).catch(() => false);
    return staged;
}

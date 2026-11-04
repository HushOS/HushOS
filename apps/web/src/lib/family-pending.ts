import { INVITATION_DAYS } from '@hushos/groups/protocol';
import type { QueryClient } from '@tanstack/react-query';
import { saveSettings, type LoadedSettings } from '@/lib/contacts';

/*
 * The manager role an inviter asked for (docs/optional-verification.md 3.6,
 * 6.8), recorded when they send Invite someone with "Let them manage the
 * family" ticked, in their own sealed settings (`pendingRoles`) and nowhere
 * else: by the invitation's id and the address they typed, since the person
 * has no account id yet. It is tied to the member once this device sees them
 * let in, and only if the account let in has the address the inviter typed.
 * Neither the server's invitation roles nor whoever presses Let them in can
 * make one: the server's roles are only its word, and only the inviter meant
 * it. Once that member reads Verified on one of the inviter's devices, the
 * family page asks whether to give the role. Other managers see an ordinary
 * member.
 */

type Settings = LoadedSettings['settings'];
type Invited = NonNullable<Settings['pendingRoles']>[string][string];

const lower = (id: string) => id.trim().toLowerCase();
const DAY = 24 * 60 * 60 * 1000;

/* The roles waiting for member `userId` in `groupId` (tied to them): empty for none. */
export function pendingRolesOf(
    settings: Settings | undefined,
    groupId: string,
    userId: string,
): readonly 'members'[] {
    const held = settings?.pendingRoles?.[lower(groupId)] ?? {};
    return Object.values(held).some(
        (entry) => entry.userId === lower(userId) && entry.roles.includes('members'),
    )
        ? ['members']
        : [];
}

/* Whether this account asked `email` to manage the family (an invitation's record, tied or not). */
export function invitedToManage(settings: Settings | undefined, groupId: string, email: string) {
    return Object.values(settings?.pendingRoles?.[lower(groupId)] ?? {}).some(
        (entry) => entry.email === lower(email) && entry.roles.includes('members'),
    );
}

/* The settings with Invite someone's "Let them manage the family" kept for `invitationId`. */
export function withInvitedRole(
    settings: Settings,
    groupId: string,
    invitationId: string,
    email: string,
    at: string,
): Settings {
    const group = lower(groupId);
    return {
        ...settings,
        pendingRoles: {
            ...settings.pendingRoles,
            [group]: {
                ...settings.pendingRoles?.[group],
                [lower(invitationId)]: { email: lower(email), roles: ['members'], since: at },
            },
        },
    };
}

/* The settings without the entries `drop` names; the same object when it names none. */
function without(
    settings: Settings,
    groupId: string,
    drop: (id: string, entry: Invited) => boolean,
) {
    const group = lower(groupId);
    const held = settings.pendingRoles?.[group];
    if (!held) return settings;
    const kept = Object.fromEntries(Object.entries(held).filter(([id, entry]) => !drop(id, entry)));
    if (Object.keys(kept).length === Object.keys(held).length) return settings;
    const next = { ...settings.pendingRoles };
    if (Object.keys(kept).length > 0) next[group] = kept;
    else delete next[group];
    const out: Settings = { ...settings, pendingRoles: next };
    if (Object.keys(next).length === 0) delete out.pendingRoles;
    return out;
}

/* The settings with nothing waiting for members `userIds` in `groupId` (every entry for 'all'). */
export function withoutPendingRoles(
    settings: Settings,
    groupId: string,
    userIds: readonly string[] | 'all',
): Settings {
    if (userIds === 'all') return without(settings, groupId, () => true);
    const ids = userIds.map(lower);
    return without(settings, groupId, (_id, entry) =>
        Boolean(entry.userId && ids.includes(entry.userId)),
    );
}

/*
 * The family's entries brought up to date with what route 3 and the checked
 * member list say:
 * - one not tied to anyone yet is tied to the member let in (active) whose
 *   address is the one the inviter typed;
 * - one tied to a member goes once they left, were removed, or manage the
 *   family now;
 * - one not tied yet goes once its invitation has expired (INVITATION_DAYS
 *   after it was sent, a day's grace beside it) with nobody of that address
 *   waiting or in. Cancelling an invitation on this device clears its record
 *   straight away (clearInvitedRole); one cancelled elsewhere goes at expiry.
 *   Route 12's open list is not used for this: it drops an invitation the
 *   moment it is accepted, before route 3 shows who accepted it.
 * The same object when nothing changes.
 */
export function tidiedPendingRoles(
    settings: Settings,
    groupId: string,
    members: readonly {
        userId: string;
        email?: string | null;
        state: string;
        roles: readonly string[];
    }[],
    checkedRoles: (userId: string) => readonly string[] | undefined,
    now: Date,
): Settings {
    const group = lower(groupId);
    const held = settings.pendingRoles?.[group];
    if (!held) return settings;
    const byEmail = (email: string, states: readonly string[]) =>
        members.find(
            (member) =>
                member.email && lower(member.email) === email && states.includes(member.state),
        );
    let changed = false;
    const next: Record<string, Invited> = {};
    for (const [id, entry] of Object.entries(held)) {
        if (!entry.userId) {
            const admitted = byEmail(entry.email, ['active']);
            if (admitted) {
                next[id] = { ...entry, userId: lower(admitted.userId) };
                changed = true;
                continue;
            }
            const gone =
                Date.parse(entry.since) + (INVITATION_DAYS + 1) * DAY < now.getTime() &&
                !byEmail(entry.email, ['accepted']);
            if (gone) changed = true;
            else next[id] = entry;
            continue;
        }
        const member = members.find((at) => lower(at.userId) === entry.userId);
        const roles = member ? (checkedRoles(member.userId) ?? member.roles) : [];
        const done =
            !member ||
            (member.state !== 'active' && member.state !== 'accepted') ||
            (member.state === 'active' && roles.includes('members'));
        if (done) changed = true;
        else next[id] = entry;
    }
    if (!changed) return settings;
    const all = { ...settings.pendingRoles };
    if (Object.keys(next).length > 0) all[group] = next;
    else delete all[group];
    const out: Settings = { ...settings, pendingRoles: all };
    if (Object.keys(all).length === 0) delete out.pendingRoles;
    return out;
}

/* The families this account no longer has listed (left, dissolved, wiped): their entries go. */
export function pendingFamiliesGone(settings: Settings | undefined, listed: readonly string[]) {
    const ids = listed.map(lower);
    return Object.keys(settings?.pendingRoles ?? {}).filter((groupId) => !ids.includes(groupId));
}

/* Saves `change` only when it changes anything: doing what is already done writes nothing. */
export async function savePendingRoles(
    queryClient: QueryClient | undefined,
    userId: string,
    change: (settings: Settings) => Settings,
) {
    let changed = false;
    await saveSettings(queryClient, userId, (settings) => {
        const next = change(settings);
        changed = next !== settings;
        if (!changed) throw new NothingToSave();
        return next;
    }).catch((error: unknown) => {
        if (!(error instanceof NothingToSave)) throw error;
    });
    return changed;
}
class NothingToSave extends Error {}

/* Nothing waits for members `userIds` in `groupId` any more. Another tab or device clearing it first is fine. */
export function clearPendingRoles(
    queryClient: QueryClient | undefined,
    userId: string,
    groupId: string,
    userIds: readonly string[] | 'all',
) {
    return savePendingRoles(queryClient, userId, (settings) =>
        withoutPendingRoles(settings, groupId, userIds),
    );
}

/* An invitation this device cancelled: its record goes with it. */
export function clearInvitedRole(
    queryClient: QueryClient | undefined,
    userId: string,
    groupId: string,
    invitationId: string,
) {
    return savePendingRoles(queryClient, userId, (settings) =>
        without(settings, groupId, (id) => id === lower(invitationId)),
    );
}

/* Invite someone, sent with "Let them manage the family" ticked: the inviter's own record of it. */
export function keepInvitedRole(
    queryClient: QueryClient | undefined,
    userId: string,
    groupId: string,
    invitationId: string,
    email: string,
) {
    return savePendingRoles(queryClient, userId, (settings) =>
        withInvitedRole(settings, groupId, invitationId, email, new Date().toISOString()),
    );
}

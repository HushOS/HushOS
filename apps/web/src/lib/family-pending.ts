import type { QueryClient } from '@tanstack/react-query';
import { saveSettings, type LoadedSettings } from '@/lib/contacts';

/*
 * The manager role asked for at invitation, held back at Let them in until
 * the person is checked (docs/optional-verification.md 3.6, 6.8), kept in
 * this account's own sealed settings (`pendingRoles`) and nowhere else: never
 * the server's invitation roles, which are only the server's word. Once the
 * person reads Verified on any of this account's devices, the family page
 * asks whether to give it. Only this account's devices know, so other
 * managers see an ordinary member.
 */

type Settings = LoadedSettings['settings'];
type PendingRole = 'members';

const lower = (id: string) => id.toLowerCase();

/* The roles waiting for `userId` in `groupId`: empty for none. */
export function pendingRolesOf(settings: Settings | undefined, groupId: string, userId: string) {
    return (settings?.pendingRoles?.[lower(groupId)]?.[lower(userId)]?.roles ?? []).filter(
        (role): role is PendingRole => role === 'members',
    );
}

/* The settings with `roles` waiting for `userId`, since `at`. */
export function withPendingRoles(
    settings: Settings,
    groupId: string,
    userId: string,
    roles: readonly PendingRole[],
    at: string,
): Settings {
    if (roles.length === 0) return settings;
    const group = lower(groupId);
    return {
        ...settings,
        pendingRoles: {
            ...settings.pendingRoles,
            [group]: {
                ...settings.pendingRoles?.[group],
                [lower(userId)]: { roles: [...roles], since: at },
            },
        },
    };
}

/* The settings with nothing waiting for `userIds` in `groupId` (every one of them for 'all'). */
export function withoutPendingRoles(
    settings: Settings,
    groupId: string,
    userIds: readonly string[] | 'all',
): Settings {
    const group = lower(groupId);
    const held = settings.pendingRoles?.[group];
    if (!held) return settings;
    const kept =
        userIds === 'all'
            ? {}
            : Object.fromEntries(
                  Object.entries(held).filter(([id]) => !userIds.map(lower).includes(id)),
              );
    const next = { ...settings.pendingRoles };
    if (Object.keys(kept).length > 0) next[group] = kept;
    else delete next[group];
    const out: Settings = { ...settings, pendingRoles: next };
    if (Object.keys(next).length === 0) delete out.pendingRoles;
    return out;
}

/*
 * What no longer waits, from what route 3 and the checked member list say:
 * someone who left or was removed (or never had a membership, an admission
 * that never landed and an invitation that went), and someone who manages the
 * family now. A person still waiting to be let in keeps theirs.
 */
export function pendingRolesDone(
    settings: Settings | undefined,
    groupId: string,
    members: readonly { userId: string; state: string; roles: readonly string[] }[],
    checkedRoles: (userId: string) => readonly string[] | undefined,
): string[] {
    const held = settings?.pendingRoles?.[lower(groupId)];
    if (!held) return [];
    return Object.keys(held).filter((userId) => {
        const member = members.find((at) => lower(at.userId) === userId);
        if (!member || (member.state !== 'active' && member.state !== 'accepted')) return true;
        const roles = checkedRoles(member.userId) ?? member.roles;
        return member.state === 'active' && roles.includes('members');
    });
}

/* The families this account no longer has listed (left, dissolved, wiped): their waiting roles go. */
export function pendingFamiliesGone(settings: Settings | undefined, listed: readonly string[]) {
    const ids = listed.map(lower);
    return Object.keys(settings?.pendingRoles ?? {}).filter((groupId) => !ids.includes(groupId));
}

/* Saves `change` only when it changes anything: clearing what is already clear writes nothing. */
async function savePending(
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

/* Nothing waits for `userIds` in `groupId` any more. Another tab or device clearing it first is fine. */
export function clearPendingRoles(
    queryClient: QueryClient | undefined,
    userId: string,
    groupId: string,
    userIds: readonly string[] | 'all',
) {
    return savePending(queryClient, userId, (settings) =>
        withoutPendingRoles(settings, groupId, userIds),
    );
}

/* Roles held back for `personId` at Let them in, kept for this account, when not already kept. */
export function keepPendingRoles(
    queryClient: QueryClient | undefined,
    userId: string,
    groupId: string,
    personId: string,
    roles: readonly PendingRole[],
) {
    return savePending(queryClient, userId, (settings) =>
        pendingRolesOf(settings, groupId, personId).length === roles.length
            ? settings
            : withPendingRoles(settings, groupId, personId, roles, new Date().toISOString()),
    );
}

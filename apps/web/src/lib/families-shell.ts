import { queryOptions, useQuery } from '@tanstack/react-query';
import { driveApi } from '@/lib/drive-api';
import { groupsApi } from '@/lib/groups/api';

/*
 * What the drive shell needs of families: whether the server serves them and
 * the account's list for the sidebar. The shell loads for every account, so
 * this module stays off the data layer (outbox, sync, store, the crypto
 * worker, contacts settings); lib/families re-exports it for the families
 * pages, which load lazily with their routes.
 */

export const familyKeys = {
    all: ['families'] as const,
    capabilities: ['drive', 'capabilities'] as const,
    user: (userId: string) => ['families', userId] as const,
    list: (userId: string) => ['families', userId, 'list'] as const,
    family: (userId: string, groupId: string) => ['families', userId, 'family', groupId] as const,
    familySync: (userId: string, groupId: string, signature: string) =>
        ['families', userId, 'family', groupId, 'sync', signature] as const,
    invitations: (userId: string, groupId: string) =>
        ['families', userId, 'family', groupId, 'invitations'] as const,
    pending: (userId: string, groupId: string) =>
        ['families', userId, 'family', groupId, 'pending'] as const,
};

/* Whether this server serves families at all (`/drive/capabilities`); absent before 1c, so false. */
export const capabilitiesQueryOptions = queryOptions({
    queryKey: familyKeys.capabilities,
    queryFn: () => driveApi.capabilities(),
    staleTime: 5 * 60_000,
    retry: 1,
});

/* True only when the server says so: the families UI stays hidden otherwise. */
export function useGroupsEnabled() {
    const { data } = useQuery({ ...capabilitiesQueryOptions, select: (c) => c.groups === true });
    return data === true;
}

/* Route 2: the account's families and where it stands in each. Session only, no keys. */
export const familiesQueryOptions = (userId: string) =>
    queryOptions({
        queryKey: familyKeys.list(userId),
        queryFn: async () => (await groupsApi.listGroups()).groups,
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: 1,
    });

/* How a member reads in a list: the roles in words, never colour alone. */
export function rolesLine(roles: readonly string[]) {
    const organizer = roles.includes('billing');
    const manages = roles.includes('members');
    if (organizer && manages) return 'Organizer · Manages the family';
    if (organizer) return 'Organizer';
    if (manages) return 'Manages the family';
    return 'Member';
}

/* The account's family: active in it (one at most, docs/families-shared-pool.md decision 2). */
export function activeFamily<T extends { kind: string; state: string }>(families: T[] | undefined) {
    return families?.find((at) => at.kind === 'family' && at.state === 'active');
}

/* Route 14b: open invitations to this account's own address, accepted from their emailed links. */
export const myInvitationsQueryOptions = (userId: string) =>
    queryOptions({
        queryKey: [...familyKeys.user(userId), 'invitations'] as const,
        queryFn: async () => (await groupsApi.myInvitations()).invitations,
        // Read afresh whenever Account → Family shows: one may have arrived since.
        staleTime: 0,
        refetchOnWindowFocus: true,
        retry: 1,
    });

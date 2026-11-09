import { queryOptions, useQuery } from '@tanstack/react-query';
import { useFamilyWork } from '@/lib/family-work-state';
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

/* Route 3: the family, its members (names from the server, with their address), seats and what is due. */
export const familyQueryOptions = (userId: string, groupId: string) =>
    queryOptions({
        queryKey: familyKeys.family(userId, groupId),
        queryFn: () => groupsApi.group(groupId),
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        retry: 1,
    });

/* Route 16: who accepted and waits to be let in, with the identity their words are read from. */
export const pendingQueryOptions = (userId: string, groupId: string) =>
    queryOptions({
        queryKey: familyKeys.pending(userId, groupId),
        queryFn: async () => (await groupsApi.pending(groupId)).pending,
        staleTime: 5_000,
        retry: 1,
    });

export function canManage(roles: readonly string[] | undefined) {
    return Boolean(roles?.includes('members'));
}

/*
 * What waits on someone who manages the family: each person waiting to be let in (or back in),
 * and each other member whose changed account needs checking before they get their keys again.
 * The family page's one blue button (Let them in or Continue, while any waits) and the count on
 * the sidebar's family item read it alike.
 */
export function waitingOn({
    userId,
    manager,
    pending,
    members,
    needsCheck,
}: {
    userId: string;
    manager: boolean;
    pending: readonly { inFamily: boolean }[];
    members: readonly { userId: string; state: string }[];
    needsCheck: readonly string[];
}) {
    const toLetIn = pending.filter((person) => !person.inFamily).length;
    const toCheck = manager
        ? members.filter(
              (member) =>
                  member.state === 'active' &&
                  member.userId !== userId &&
                  needsCheck.includes(member.userId),
          ).length
        : 0;
    return toLetIn + toCheck;
}

/*
 * The sidebar's family item opens the family's folders (/app/s/<family>) and stands for the
 * family's own page too (/app/family), so it is the active place on either.
 */
export function familyItemActive(pathname: string, groupId: string) {
    const space = `/app/s/${groupId}`;
    return (
        pathname === space ||
        pathname.startsWith(`${space}/`) ||
        pathname === '/app/family' ||
        pathname.startsWith('/app/family/')
    );
}

/*
 * How a member reads in a list: the roles in words, never colour alone. An organizer reads
 * "Organizer" alone: "Manages the family" beside it only said again what organizer says.
 */
export function rolesLine(roles: readonly string[]) {
    if (roles.includes('billing')) return 'Organizer';
    if (roles.includes('members')) return 'Manages the family';
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

/*
 * How much waits on this person in their family, as the family page counts it (waitingOn):
 * people to let in, and for those who manage it, members to check. Only someone who manages
 * the family is asked; the members to check come from the background pass the Drive runs
 * (lib/family-work-state.ts, nothing loaded for it here), and the family's member list is read
 * only while that pass names someone.
 */
export function useWaitingOn(userId: string, groupId: string, manager: boolean) {
    const pending = useQuery({
        ...pendingQueryOptions(userId, groupId),
        enabled: manager,
        // Someone who accepts turns up within a minute; the family page asks more often.
        refetchInterval: 60_000,
    });
    const { needsCheck } = useFamilyWork(groupId);
    const others = needsCheck.some((id) => id !== userId);
    const detail = useQuery({
        ...familyQueryOptions(userId, groupId),
        enabled: manager && others,
    });
    if (!manager) return 0;
    return waitingOn({
        userId,
        manager,
        pending: pending.data ?? [],
        members: others ? (detail.data?.members ?? []) : [],
        needsCheck,
    });
}

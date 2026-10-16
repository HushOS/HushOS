import type { GroupRole } from '@hushos/crypto';
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { useStore } from 'zustand';
import { authClient } from '@/lib/auth-client';
import { familyKeys } from '@/lib/families-shell';
import { groupsApi, type GroupDetail, type GroupSummary } from '@/lib/groups/api';
import { groupContext } from '@/lib/groups/client';
import type { GroupContext, GroupNotice } from '@/lib/groups/context';
import { dropHeldBack, resumeOutbox } from '@/lib/groups/outbox';
import { syncAll, syncGroup, type SyncResult } from '@/lib/groups/sync';

/*
 * The families pages' side of the groups data layer: the queries they read
 * (route 2's list, route 3's family, invitations and who waits to join), the
 * one data-layer context per account, and the sync every family page runs.
 *
 * Sync order (the step 4 handoff): what the outbox holds is sent again first
 * (resumeOutbox), so a call that landed is known to have before acceptance
 * meets its roster; then the families are accepted against this person's
 * marks. A sync runs again when the window regains focus and whenever route
 * 2's member list version moves, since the query key carries it.
 *
 * Everything here waits for the account to be unlocked on this device: the
 * crypto worker holds every chain, seed and area key.
 */

/* The shell's part (keys, capabilities, route 2's list), here for the families pages. */
export {
    capabilitiesQueryOptions,
    familiesQueryOptions,
    familyKeys,
    useGroupsEnabled,
} from '@/lib/families-shell';

const contexts = new Map<string, GroupContext>();
/* One data-layer context per account: its store, settings access and locks. */
export function familyContext(userId: string) {
    let ctx = contexts.get(userId);
    if (!ctx) {
        ctx = groupContext(userId);
        contexts.set(userId, ctx);
    }
    return ctx;
}

/* Route 3: the family, its members (names from the server, with their address), seats and what is due. */
export const familyQueryOptions = (userId: string, groupId: string) =>
    queryOptions({
        queryKey: familyKeys.family(userId, groupId),
        queryFn: () => groupsApi.group(groupId),
        staleTime: 10_000,
        refetchOnWindowFocus: true,
        retry: 1,
    });

/* Route 12: open invitations, for those who manage the family. */
export const invitationsQueryOptions = (userId: string, groupId: string) =>
    queryOptions({
        queryKey: familyKeys.invitations(userId, groupId),
        queryFn: async () => (await groupsApi.invitations(groupId)).invitations,
        staleTime: 10_000,
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

export type FamilySummary = GroupSummary;
export type FamilyDetail = GroupDetail;
export type FamilyMember = GroupDetail['members'][number];
export type PendingPerson = Awaited<ReturnType<typeof groupsApi.pending>>['pending'][number];
export type Invitation = Awaited<ReturnType<typeof groupsApi.invitations>>['invitations'][number];

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export function useUnlocked(userId: string) {
    return useStore(authClient.store, (state) => state.unlockedUserId === userId);
}

const signatureOf = (groups: readonly GroupSummary[]) =>
    groups
        .map((group) => `${group.id}:${group.state}:${group.rosterVersion}`)
        .sort()
        .join('|');

export type FamiliesSync = {
    results: Map<string, SyncResult | { status: 'failed'; error: string }>;
    notices: GroupNotice[];
};

/*
 * Every family synced, after the outbox is sent again. Keyed by route 2's
 * versions, so a member list that moved on the server syncs again by itself.
 */
export function useFamiliesSync(userId: string, groups: readonly GroupSummary[] | undefined) {
    const unlocked = useUnlocked(userId);
    const signature = groups ? signatureOf(groups) : null;
    return useQuery({
        queryKey: familyKeys.sync(userId, signature ?? ''),
        queryFn: async (): Promise<FamiliesSync> => {
            const ctx = familyContext(userId);
            const resumed = await resumeOutbox(ctx);
            const results = await syncAll(ctx);
            const notices = [...resumed.notices];
            for (const result of results.values())
                if ('notices' in result) notices.push(...result.notices);
            return { results, notices };
        },
        enabled: unlocked && signature !== null,
        staleTime: 0,
        refetchOnWindowFocus: true,
        retry: false,
    });
}

/* One family synced (after the outbox), keyed by its state and member list version. */
export function useFamilySync(userId: string, groupId: string, summary: GroupSummary | undefined) {
    const unlocked = useUnlocked(userId);
    const signature = summary ? `${summary.state}:${summary.rosterVersion}` : null;
    return useQuery({
        queryKey: familyKeys.familySync(userId, groupId, signature ?? ''),
        queryFn: async () => {
            const ctx = familyContext(userId);
            const dropped = await dropHeldBack(ctx, groupId);
            const resumed = await resumeOutbox(ctx);
            const result = await syncGroup(ctx, groupId, { state: summary?.state });
            const notices = [
                ...dropped,
                ...resumed.notices.filter(
                    (notice) => !('groupId' in notice) || notice.groupId === groupId,
                ),
                ...('notices' in result ? result.notices : []),
            ];
            return { result, notices };
        },
        enabled: unlocked && signature !== null,
        staleTime: 0,
        refetchOnWindowFocus: true,
        retry: false,
    });
}

/* After any change: route 2, the family and its sync read again. */
export function afterFamilyChange(queryClient: QueryClient, userId: string) {
    return queryClient.invalidateQueries({ queryKey: familyKeys.user(userId) });
}

/* How a member reads in a list: the roles in words, never colour alone. */
export function rolesLine(roles: readonly string[]) {
    const organizer = roles.includes('billing');
    const manages = roles.includes('members');
    if (organizer && manages) return 'Organizer · Manages the family';
    if (organizer) return 'Organizer';
    if (manages) return 'Manages the family';
    return 'Member';
}

export function canManage(roles: readonly string[] | undefined) {
    return Boolean(roles?.includes('members'));
}

/* Roles with one added or taken away, in the order a roster lists them. */
export function withRole(roles: readonly GroupRole[], role: GroupRole, on: boolean): GroupRole[] {
    const set = new Set(roles);
    if (on) set.add(role);
    else set.delete(role);
    return (['billing', 'guardian', 'members'] as GroupRole[]).filter((at) => set.has(at));
}

/* The member names route 3 gives, by user id: first names for sentences. */
export function firstNames(detail: FamilyDetail | undefined) {
    const out: Record<string, string> = {};
    for (const member of detail?.members ?? []) out[member.userId] = firstName(member.name);
    return out;
}

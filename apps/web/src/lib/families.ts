import type { GroupRole } from '@hushos/crypto';
import { queryOptions, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useStore } from 'zustand';
import { authClient } from '@/lib/auth-client';
import { familiesSyncAllKey, familySynced } from '@/lib/families-keys';
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
    activeFamily,
    capabilitiesQueryOptions,
    familiesQueryOptions,
    familyKeys,
    rolesLine,
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

export type FamiliesSync = {
    results: Map<string, SyncResult | { status: 'failed'; error: string }>;
    notices: GroupNotice[];
};

/*
 * The app-wide pass: what the outbox holds is sent again, then every family is
 * synced. The Drive runtime runs it once the account is unlocked and Drive is
 * open, on servers that serve families, loading this module only then
 * (components/drive/drive-shell.tsx, under the same query key). It empties the
 * outbox before any family page syncs, so Account → Family (/app/family)
 * reads the same query, never starting it, and shows its notices.
 */
export async function syncFamilies(
    userId: string,
    options: { onChanged?: () => void } = {},
): Promise<FamiliesSync> {
    const ctx = familyContext(userId);
    const resumed = await resumeOutbox(ctx);
    const { groups } = await ctx.api.listGroups();
    const results = await syncAll(ctx, groups);
    const notices = [...resumed.notices];
    for (const [groupId, result] of results) {
        if ('notices' in result) notices.push(...result.notices);
        // Family folders' clients follow it, and a family gone from this device takes them along.
        familySynced(groupId, result);
        // What is due, and the walks, in the background, wherever Drive is open: a departure is
        // marked left and a walk finished without anyone opening the family's pages, and members
        // walk too, so a waiting upload does not hang on a manager's device.
        const summary = groups.find((group) => group.id === groupId);
        if (result.status === 'accepted' && summary?.state === 'active')
            void import('@/lib/family-work').then(({ startFamilyWork }) =>
                startFamilyWork(userId, groupId, result, {
                    manager: canManage(summary.roles),
                    onChanged: options.onChanged ?? (() => {}),
                }),
            );
    }
    return { results, notices };
}
/*
 * Folders this family's member list names that aren't its own (the worker's area ledger,
 * `foreignListings`), as one notice per owner: another family, or this account's own files.
 * Asked once the app-wide pass has run (`passedAt`, its time), so every family it accepted has
 * opened its folders in the worker and the owner is known whatever order the families were
 * synced in. The worker ignored the listings; this only says so.
 */
export const foreignListingsQueryOptions = (userId: string, groupId: string, passedAt: number) =>
    queryOptions({
        queryKey: [...familyKeys.family(userId, groupId), 'foreign', passedAt] as const,
        queryFn: async (): Promise<GroupNotice[]> => {
            const { listings } = await familyContext(userId).rpc('groupForeignListings', {
                groupId,
            });
            const byOwner = new Map<string | null, number>();
            for (const { openedBy } of listings)
                byOwner.set(openedBy, (byOwner.get(openedBy) ?? 0) + 1);
            return [...byOwner].map(([owner, count]) => ({
                kind: 'foreign-listing',
                groupId,
                owner,
                count,
            }));
        },
        staleTime: Infinity,
        retry: false,
    });

/* The pass's query key: the drive shell takes it from lib/families-keys, never from here. */
export const familiesSyncKey = familiesSyncAllKey;
export const familiesSyncQueryOptions = (userId: string) =>
    queryOptions({
        queryKey: familiesSyncKey(userId),
        queryFn: () => syncFamilies(userId),
        staleTime: 60_000,
        refetchOnWindowFocus: true,
        retry: false,
    });

/*
 * One family synced (after the outbox), keyed by its state and member list
 * version. `pollWhileWalking` syncs again that often while a key change walks
 * one of its folders (a family space does, so its pages see the walk end;
 * nothing refused meanwhile is retried on its own).
 */
export function useFamilySync(
    userId: string,
    groupId: string,
    summary: GroupSummary | undefined,
    options: { pollWhileWalking?: number } = {},
) {
    const unlocked = useUnlocked(userId);
    const queryClient = useQueryClient();
    const walkPolls = useRef(0);
    const signature = summary ? `${summary.state}:${summary.rosterVersion}` : null;
    return useQuery({
        queryKey: familyKeys.familySync(userId, groupId, signature ?? ''),
        queryFn: async () => {
            const ctx = familyContext(userId);
            const dropped = await dropHeldBack(ctx, groupId);
            const resumed = await resumeOutbox(ctx);
            const result = await syncGroup(ctx, groupId, { state: summary?.state });
            familySynced(groupId, result);
            // What is due, and the walks, in the background (lib/family-work.ts, family pages only).
            if (result.status === 'accepted' && summary?.state === 'active')
                void import('@/lib/family-work').then(({ startFamilyWork }) =>
                    startFamilyWork(userId, groupId, result, {
                        manager: canManage(summary.roles),
                        onChanged: () => void afterFamilyChange(queryClient, userId),
                    }),
                );
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
        // A new member list version is a new key: until its sync answers, the page goes on
        // showing the family as last synced, never a blank one that drops the folder open in
        // it (a removal's sync can wait on a key change). Never another family's or account's.
        // `isPlaceholderData` says so meanwhile: the pages say the family is being checked, and
        // nothing built from the last member list (a role change) is offered.
        placeholderData: (previous, previousQuery) =>
            familyKeys
                .family(userId, groupId)
                .every((part, index) => previousQuery?.queryKey[index] === part)
                ? previous
                : undefined,
        staleTime: 0,
        refetchOnWindowFocus: true,
        refetchInterval: (query) => {
            const result = query.state.data?.result;
            const walking =
                result?.status === 'accepted' &&
                result.areas.some((area) => area.view.rotation !== null);
            if (!walking || !options.pollWhileWalking) {
                walkPolls.current = 0;
                return false;
            }
            // From `pollWhileWalking`, twice as long each poll that still finds it, up to 10 min.
            walkPolls.current++;
            return Math.min(10 * 60_000, options.pollWhileWalking * 2 ** (walkPolls.current - 1));
        },
        retry: false,
    });
}

/* After any change: route 2, the family and its sync read again. */
export function afterFamilyChange(queryClient: QueryClient, userId: string) {
    return queryClient.invalidateQueries({ queryKey: familyKeys.user(userId) });
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

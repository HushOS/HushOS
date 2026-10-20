import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { RotateCcwIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, type ReactNode } from 'react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { useDrive } from '@/components/drive/drive-shell';
import { CheckingLine, ForkAlert } from '@/components/families/family-alerts';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
    canManage,
    capabilitiesQueryOptions,
    familiesQueryOptions,
    familyKeys,
    familyQueryOptions,
    useFamilySync,
} from '@/lib/families';
import { errorCopy } from '@/lib/groups/copy';
import { areaClient, FamilySpaceProvider, pruneAreas, type FamilySpace } from '@/lib/spaces';

/*
 * A family's space (groups 1c step 6): its folders, each a Drive of its own.
 * The family is synced here first (after the outbox), which opens each
 * folder's key in the worker and lists its root; only then does a folder's
 * Drive client open, and only a folder the worker found writable takes
 * anything. While it is mounted, route 2 is read every so often, so a change
 * another manager made (a removal, which starts a key change) syncs the
 * family again; while a key change walks one of the folders the family is
 * synced again every so often too, so the pages see it end (a manager's
 * device walks it meanwhile: lib/family-work.ts). Uploads into a folder the
 * walk has not reached wait in the queue and go once it has.
 *
 * The family's pages (/app/s/<family>) sit inside it, and so does the family
 * folders' section of Trash (/app/trash), which lists their Trash beside My
 * files' (docs/families-shared-pool.md 7.1).
 */
const KEY_CHANGE_POLL_MS = 15_000;
const ROUTE_2_POLL_MS = 30_000;

export function FamilySpaceScope({
    groupId,
    children,
    joinScreen = true,
}: {
    groupId: string;
    children: ReactNode;
    /* Whether a family still being joined leads to its join screen; Trash shows nothing instead. */
    joinScreen?: boolean;
}) {
    const { userId } = useDrive();
    const queryClient = useQueryClient();
    const capabilities = useQuery(capabilitiesQueryOptions);
    const families = useQuery({
        ...familiesQueryOptions(userId),
        refetchInterval: ROUTE_2_POLL_MS,
    });
    const summary = families.data?.find((family) => family.id === groupId);
    const active = summary?.state === 'active';
    const detail = useQuery({ ...familyQueryOptions(userId, groupId), enabled: active });
    const sync = useFamilySync(userId, groupId, summary, {
        pollWhileWalking: KEY_CHANGE_POLL_MS,
    });
    const result = sync.data?.result;
    const areas = useMemo(() => (result?.status === 'accepted' ? result.areas : []), [result]);

    // Each folder's client follows the latest sync: what may be written, and the running key
    // change. A folder the server stopped listing (or a family gone from this device) goes.
    useEffect(() => {
        if (!result) return;
        if (result.status === 'wiped') pruneAreas(groupId, []);
        if (result.status !== 'accepted') return;
        for (const state of result.areas) areaClient(userId, groupId, state);
        pruneAreas(
            groupId,
            result.areas.map((state) => state.workspaceId),
        );
    }, [result, userId, groupId]);

    const recheck = useCallback(
        () => void queryClient.invalidateQueries({ queryKey: familyKeys.family(userId, groupId) }),
        [queryClient, userId, groupId],
    );

    if (capabilities.isPending || families.isPending) return <SkeletonRows rows={3} />;
    if (capabilities.data?.groups !== true)
        return (
            <EmptyState
                title="Families aren’t available here"
                body="This HushOS server doesn’t offer families."
            />
        );
    if (families.isError)
        return (
            <EmptyState title="This family couldn’t be opened" body={errorCopy(families.error)}>
                <Button variant="outline" onClick={() => void families.refetch()}>
                    <RotateCcwIcon />
                    Try again
                </Button>
            </EmptyState>
        );
    if (!summary)
        return (
            <EmptyState
                title="You’re not in this family"
                body="It may have ended, or someone removed you."
            >
                <Link to="/app/family" className="text-sm font-semibold text-primary underline">
                    Family
                </Link>
            </EmptyState>
        );
    // Accepted but not let in yet, or let in but not checked on this account yet: the join
    // screen is where that goes on.
    if (summary.state === 'accepted' || result?.status === 'unchecked')
        return joinScreen ? (
            <Navigate to="/app/families/$groupId/join" params={{ groupId }} replace />
        ) : (
            <p className="border-t border-rule px-5 py-4 text-sm text-muted-foreground sm:px-8">
                Finish joining {summary.name} to see what’s here.{' '}
                <Link
                    to="/app/families/$groupId/join"
                    params={{ groupId }}
                    className="font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                >
                    Continue joining
                </Link>
            </p>
        );

    const family = summary.name;
    if (result?.status === 'wiped')
        return (
            <div className="px-5 sm:px-8">
                <Alert variant="warning">
                    <AlertTitle>You’re not in {family} any more</AlertTitle>
                    <AlertDescription>
                        What this device kept of the family has been cleared.
                    </AlertDescription>
                </Alert>
            </div>
        );
    if (result?.status === 'fork')
        return (
            <div className="flex flex-col gap-3 px-5 sm:px-8">
                <ForkAlert family={family} fork={result.fork} />
            </div>
        );
    if (sync.isError)
        return (
            <div className="px-5 sm:px-8">
                <Alert variant="warning">
                    <AlertTitle>Couldn’t check {family}</AlertTitle>
                    <AlertDescription>{errorCopy(sync.error, { family })}</AlertDescription>
                    <AlertAction>
                        <Button variant="outline" onClick={() => void sync.refetch()}>
                            Try again
                        </Button>
                    </AlertAction>
                </Alert>
            </div>
        );
    if (!result) return <SkeletonRows rows={3} />;

    const space: FamilySpace = {
        userId,
        groupId,
        family,
        areas,
        members: detail.data?.members ?? [],
        manager: active && canManage(summary.roles),
        recheck,
    };
    return (
        <FamilySpaceProvider value={space}>
            {sync.isPlaceholderData && result.status === 'accepted' && (
                <div className="px-5 pb-2 sm:px-8">
                    <CheckingLine family={family} />
                </div>
            )}
            {children}
        </FamilySpaceProvider>
    );
}

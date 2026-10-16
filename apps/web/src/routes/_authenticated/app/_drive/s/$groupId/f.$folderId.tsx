import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { RotateCcwIcon, TriangleAlertIcon } from 'lucide-react';
import { useMemo } from 'react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { FamilyAreaProvider, type FamilyArea } from '@/components/drive/family-area';
import { FolderView } from '@/components/drive/folder-view';
import { Button } from '@/components/ui/button';
import { driveError, driveKeys } from '@/lib/drive';
import { areaOf, membersById, openArea, useAreaFeed, useFamilySpace } from '@/lib/spaces';

export const Route = createFileRoute('/_authenticated/app/_drive/s/$groupId/f/$folderId')({
    head: () => ({ meta: [{ title: 'Family folder · HushOS' }] }),
    // The file open in the viewer, as in My files: a preview has an address of its own.
    validateSearch: (search: Record<string, unknown>): { preview?: string } =>
        typeof search.preview === 'string' && /^[0-9a-f-]{36}$/.test(search.preview)
            ? { preview: search.preview }
            : {},
    component: FamilyFolderPage,
});

/*
 * A folder inside one of the family's folders: the same page as a folder in
 * My files, listed, checked and written by that family folder's own Drive
 * client. Which family folder holds it is found first (its top folder, one
 * listed already, or each asked in turn after a reload).
 */
function FamilyFolderPage() {
    const { groupId, folderId } = Route.useParams();
    const space = useFamilySpace();
    const queryClient = useQueryClient();
    // Asked again whenever the family's folders change (a sync that opens one, or drops one).
    const folders = space.areas.map((area) => `${area.workspaceId}:${area.write}`).join(',');
    const located = useQuery({
        queryKey: [...driveKeys.all, 'space', groupId, 'folder', folderId, folders],
        queryFn: () =>
            areaOf(space.userId, groupId, space.areas, folderId, (listing) =>
                queryClient.setQueryData(driveKeys.folder(folderId), listing),
            ),
        staleTime: Infinity,
        retry: false,
    });
    const state = space.areas.find((area) => area.workspaceId === located.data);
    const opened = useQuery({
        queryKey: [...driveKeys.all, 'space', state?.workspaceId ?? '', 'open'],
        queryFn: () => openArea(space.userId, groupId, state!),
        enabled: state !== undefined && state.opened !== null,
        staleTime: Infinity,
        retry: false,
    });
    useAreaFeed(opened.data ?? null, state?.workspaceId ?? '', space.recheck);
    const members = useMemo(() => membersById(space.members), [space.members]);

    // Found, but its key did not open on this device: nothing to list it with.
    if (state && state.opened === null)
        return (
            <EmptyState
                icon={TriangleAlertIcon}
                tone="danger"
                title="This folder couldn’t be opened"
                body={`HushOS couldn’t check this folder’s keys on this device. ${state.error ?? ''}`.trim()}
            >
                <Button variant="outline" onClick={space.recheck}>
                    <RotateCcwIcon />
                    Check again
                </Button>
            </EmptyState>
        );
    if (located.isPending || (state && opened.isPending)) return <SkeletonRows />;
    const error = located.error ?? opened.error;
    if (error || !state)
        return (
            <EmptyState
                icon={TriangleAlertIcon}
                tone="danger"
                title="This folder couldn’t be opened"
                body={
                    error
                        ? driveError(error)
                        : `It isn’t in ${space.family}’s folders, or it was deleted.`
                }
            >
                {error ? (
                    <Button
                        variant="outline"
                        onClick={() => void (located.error ? located.refetch() : opened.refetch())}
                    >
                        <RotateCcwIcon />
                        Try again
                    </Button>
                ) : (
                    <Link
                        to="/app/s/$groupId"
                        params={{ groupId }}
                        className="text-sm font-semibold text-primary underline"
                    >
                        {space.family}
                    </Link>
                )}
            </EmptyState>
        );
    if (!opened.data) return <SkeletonRows />;
    const area: FamilyArea = {
        groupId,
        family: space.family,
        workspaceId: state.workspaceId,
        rootId: opened.data.root.id,
        name: state.name ?? 'Family folder',
        write: state.write,
        rotation: state.view.rotation,
        members,
        recheck: space.recheck,
    };
    return (
        <FamilyAreaProvider value={area}>
            <FolderView key={folderId} folderId={folderId} />
        </FamilyAreaProvider>
    );
}

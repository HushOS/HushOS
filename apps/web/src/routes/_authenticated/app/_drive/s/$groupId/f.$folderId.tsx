import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { RotateCcwIcon } from 'lucide-react';
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
    // Asked again whenever the family's folders change as areaOf reads them (a sync that opens
    // one, drops one, or gives one another top folder); never for what may be written there,
    // which `state` below always reads from the latest sync.
    const folders = space.areas
        .map((area) => `${area.workspaceId}:${area.opened ? 'open' : 'shut'}:${area.view.root?.id}`)
        .join(',');
    const located = useQuery({
        queryKey: [...driveKeys.all, 'space', groupId, 'folder', folderId, folders],
        queryFn: () =>
            areaOf(space.userId, groupId, space.areas, folderId, (listing) =>
                queryClient.setQueryData(driveKeys.folder(folderId), listing),
            ),
        // Meanwhile this folder stays where it was found, while that family folder is still
        // listed and open: the page keeps its list rather than flashing empty rows.
        placeholderData: (previous, previousQuery) =>
            previous &&
            previousQuery?.queryKey[2] === groupId &&
            previousQuery.queryKey[4] === folderId &&
            space.areas.some((area) => area.workspaceId === previous && area.opened)
                ? previous
                : undefined,
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
                title="This folder couldn’t be opened"
                body={
                    error ? driveError(error) : 'It isn’t in the family folders, or it was deleted.'
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

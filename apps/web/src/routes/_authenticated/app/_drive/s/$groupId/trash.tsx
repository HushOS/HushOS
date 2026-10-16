import type { TrashItem } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { RotateCcwIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { FileMark } from '@/components/drive/file-mark';
import { PageHeader } from '@/components/page-header';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { driveError, driveKeys, formatWhen, invalidateFolders } from '@/lib/drive';
import { openArea, useFamilySpace } from '@/lib/spaces';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/_drive/s/$groupId/trash')({
    head: () => ({ meta: [{ title: 'Family trash · HushOS' }] }),
    component: FamilyTrash,
});

type Row = TrashItem & { workspaceId: string; folder: string };

/*
 * What was moved to Trash in the family's folders, every folder's together:
 * Restore puts an item back (in its family folder's top folder when its own
 * folder is in the Trash too), Delete forever asks once. Anyone in the family
 * may do either, as in the folders themselves, and only where this device
 * may write in that folder. Items stay 30 days, as in My files.
 */
function FamilyTrash() {
    const space = useFamilySpace();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<Row | null>(null);
    const trash = useQuery({
        queryKey: [...driveKeys.trash, 'family', space.groupId],
        queryFn: async () => {
            const rows: Row[] = [];
            for (const state of space.areas) {
                if (!state.opened || !state.view.root) continue;
                const { client } = await openArea(space.userId, space.groupId, state);
                for (const item of await client.listTrash())
                    rows.push({
                        ...item,
                        workspaceId: state.workspaceId,
                        folder: state.name ?? 'Family folder',
                    });
            }
            return rows.sort((a, b) =>
                (b.node.trashedAt ?? '').localeCompare(a.node.trashedAt ?? ''),
            );
        },
        staleTime: 15_000,
        retry: 1,
    });
    const writable = (row: Row) =>
        space.areas.find((area) => area.workspaceId === row.workspaceId)?.write === 'writable';

    async function restore(row: Row) {
        setBusy(row.node.id);
        try {
            const state = space.areas.find((area) => area.workspaceId === row.workspaceId)!;
            const { client, root } = await openArea(space.userId, space.groupId, state);
            const top = row.parentTrashed ? (await client.listFolder(root.id)).folder : undefined;
            await client.restore(row.node, top);
            cue('success');
            toast.add({
                type: 'success',
                title: `Restored “${row.node.name}”`,
                description: row.parentTrashed
                    ? `Its folder is in the Trash too, so it went to “${row.folder}”.`
                    : undefined,
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: `Couldn’t restore “${row.node.name}”`,
                description: driveError(error),
            });
        } finally {
            setBusy(null);
            await invalidateFolders(queryClient, row.node.parentId);
        }
    }

    async function purge(row: Row) {
        setBusy(row.node.id);
        setDeleting(null);
        try {
            const state = space.areas.find((area) => area.workspaceId === row.workspaceId)!;
            const { client } = await openArea(space.userId, space.groupId, state);
            await client.purge(row.node);
            cue('droplet');
            toast.add({ type: 'success', title: `Deleted “${row.node.name}” forever` });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: `Couldn’t delete “${row.node.name}”`,
                description: driveError(error),
            });
        } finally {
            setBusy(null);
            await invalidateFolders(queryClient);
        }
    }

    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                back={
                    <Link to="/app/s/$groupId" params={{ groupId: space.groupId }}>
                        {space.family}
                    </Link>
                }
                title="Trash"
                description="Items in the family’s folders stay here for 30 days, then they’re deleted."
            />
            {trash.isPending && <SkeletonRows rows={3} />}
            {trash.isError && (
                <EmptyState
                    icon={TriangleAlertIcon}
                    tone="danger"
                    title="The Trash couldn’t be opened"
                    body={driveError(trash.error)}
                >
                    <Button variant="outline" onClick={() => void trash.refetch()}>
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </EmptyState>
            )}
            {trash.data?.length === 0 && (
                <EmptyState
                    icon={Trash2Icon}
                    title="Nothing in the Trash"
                    body="What anyone in the family moves to Trash shows up here."
                />
            )}
            {trash.data && trash.data.length > 0 && (
                <ul aria-label="Trash" className="flex flex-col border-t border-rule">
                    {trash.data.map((row) => (
                        <li
                            key={row.node.id}
                            data-node-id={row.node.id}
                            className="flex h-14 items-center gap-3 border-b border-rule pr-3 pl-5 sm:pr-6 sm:pl-8"
                        >
                            <FileMark node={row.node} size="list" />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-[15px] font-medium">
                                    {row.node.name}
                                </span>
                                <span className="truncate text-[13px] text-muted-foreground">
                                    {[
                                        row.folder,
                                        ...row.ancestors.slice(1).map((at) => at.name),
                                    ].join(' / ')}
                                    {row.node.trashedAt
                                        ? ` · ${formatWhen(row.node.trashedAt, { lower: true })}`
                                        : ''}
                                </span>
                            </span>
                            {writable(row) && (
                                <span className="flex shrink-0 gap-2">
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={busy !== null}
                                        onClick={() => void restore(row)}
                                    >
                                        Restore
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="destructive-outline"
                                        disabled={busy !== null}
                                        onClick={() => setDeleting(row)}
                                    >
                                        Delete forever
                                    </Button>
                                </span>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            <AlertDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete “{deleting?.node.name}” forever?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {deleting?.node.kind === 'folder'
                                ? 'Everything inside goes too, for everyone in the family. It can’t be restored after this.'
                                : 'It goes for everyone in the family, and it can’t be restored after this.'}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            onClick={() => deleting && void purge(deleting)}
                        >
                            Delete forever
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

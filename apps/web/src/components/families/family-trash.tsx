import type { TrashItem } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { cn } from 'cn';
import { useEffect, useState } from 'react';
import { EmptyState, SkeletonRows, useCoarsePointer } from '@/components/drive/file-list';
import { FileMark } from '@/components/drive/file-mark';
import { TRASH_COLUMN } from '@/components/drive/trash-view';
import { Spinner } from '@/components/motion';
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
import {
    driveError,
    driveKeys,
    formatBytes,
    formatWhen,
    invalidateFolders,
    nodeSize,
} from '@/lib/drive';
import { useIsMobile } from '@/hooks/use-mobile';
import { openArea, useFamilySpace } from '@/lib/spaces';
import { cue } from '@/lib/sounds';

type Row = TrashItem & { workspaceId: string; folder: string };

/*
 * What was moved to Trash in the family's folders, every folder's together,
 * as the second section of Trash (docs/families-shared-pool.md 7.1), inside the
 * family's space (FamilySpaceScope): Restore puts an item back (in its family
 * folder's top folder when its own folder is in the Trash too), Delete forever
 * asks once. Anyone in the family may do either, as in the folders
 * themselves, and only where this device may write in that folder. Items stay
 * 30 days, as in My files.
 */
export function FamilyTrashList() {
    const space = useFamilySpace();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<Row | null>(null);
    const mobile = useIsMobile();
    // Touch has no hover: the actions show on every row there, as in My files' Trash.
    const coarse = useCoarsePointer();
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
    // Come for the family folders' Trash (/app/trash#family): it is below My files', which
    // may load first and push it down, so it is scrolled to once its own list is there.
    const listed = trash.data !== undefined;
    useEffect(() => {
        if (listed && window.location.hash === '#family')
            document.getElementById('family')?.scrollIntoView({ block: 'start' });
    }, [listed]);
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
                title: row.parentTrashed
                    ? `Restored “${row.node.name}” to ${row.folder}`
                    : `Restored “${row.node.name}” to ${row.ancestors.at(-1)?.name ?? row.folder}`,
                description: row.parentTrashed ? 'Its folder is in the Trash too.' : undefined,
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
            toast.add({
                type: 'success',
                title: `Deleted “${row.node.name}” forever`,
                description: 'Its space frees up in a moment.',
            });
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
        // The same list as My files' Trash above it (TrashView): its columns by the list's
        // own width, the same row and the same two actions, shown on hover as there.
        <div className="@container/list flex flex-col" data-family-trash>
            {trash.isPending && <SkeletonRows rows={3} />}
            {trash.isError && (
                <EmptyState title="The Trash couldn’t be opened" body={driveError(trash.error)}>
                    <Button variant="outline" onClick={() => void trash.refetch()}>
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </EmptyState>
            )}
            {trash.data?.length === 0 && (
                <p className="border-t border-rule px-5 py-4 text-sm text-muted-foreground sm:px-8">
                    Nothing in the family folders’ Trash.
                </p>
            )}
            {trash.data && trash.data.length > 0 && (
                <table
                    aria-label="Family folders’ Trash"
                    className="w-full table-fixed border-collapse"
                >
                    <thead>
                        <tr className="h-10 border-b border-rule text-xs font-semibold text-muted-foreground">
                            <th scope="col" className="pl-4 text-left md:pl-8">
                                <span className="flex items-center gap-3 md:gap-4">
                                    <span className="w-8 shrink-0 md:w-10" />
                                    Name
                                </span>
                            </th>
                            <th scope="col" className={cn(TRASH_COLUMN.where, 'w-[22%] text-left')}>
                                Was in
                            </th>
                            <th scope="col" className={cn(TRASH_COLUMN.trashed, 'w-36 text-left')}>
                                Trashed
                            </th>
                            <th
                                scope="col"
                                className={cn(TRASH_COLUMN.size, 'w-24 pr-2 text-right')}
                            >
                                Size
                            </th>
                            <th
                                scope="col"
                                className={cn(TRASH_COLUMN.actionsWide, 'w-32 pr-3 sm:pr-5')}
                            >
                                <span className="sr-only">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {trash.data.map((row) => {
                            const where = [
                                row.folder,
                                ...row.ancestors.slice(1).map((at) => at.name),
                            ].join(' › ');
                            const rowBusy = busy === row.node.id;
                            return (
                                <tr
                                    key={row.node.id}
                                    data-node-id={row.node.id}
                                    className="group/row h-14 border-b border-rule hover:bg-muted"
                                >
                                    {/* The name heads its row, for a screen reader reading across. */}
                                    {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- its text is the name, two spans down, past the rule's depth */}
                                    <th scope="row" className="min-w-0 p-0 text-left font-normal">
                                        <span className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 pl-4 md:grid-cols-[2.5rem_minmax(0,1fr)] md:gap-x-4 md:pl-8">
                                            <span
                                                className={cn('row-span-2', TRASH_COLUMN.whereSpan)}
                                            >
                                                <FileMark
                                                    node={row.node}
                                                    size={mobile ? 'row' : 'list'}
                                                />
                                            </span>
                                            <span className="truncate text-[14px] font-medium md:text-[15px]">
                                                {row.node.name}
                                            </span>
                                            <span
                                                className={cn(
                                                    TRASH_COLUMN.whereLine,
                                                    'truncate text-[13px] text-muted-foreground',
                                                )}
                                                title={where}
                                            >
                                                Was in{' '}
                                                <span className="font-semibold">{row.folder}</span>
                                                {row.parentTrashed && ', also in the Trash'}
                                            </span>
                                        </span>
                                    </th>
                                    <td
                                        className={cn(
                                            TRASH_COLUMN.where,
                                            'min-w-0 pr-4 text-[13px]',
                                        )}
                                    >
                                        <span className="flex min-w-0 flex-col" title={where}>
                                            <span className="truncate font-semibold">
                                                {row.folder}
                                            </span>
                                            {row.parentTrashed && (
                                                <span className="text-muted-foreground">
                                                    Also in the Trash
                                                </span>
                                            )}
                                        </span>
                                    </td>
                                    <td
                                        className={cn(
                                            TRASH_COLUMN.trashed,
                                            'text-[13px] text-muted-foreground tabular-nums',
                                        )}
                                    >
                                        {row.node.trashedAt ? formatWhen(row.node.trashedAt) : ''}
                                    </td>
                                    <td
                                        className={cn(
                                            TRASH_COLUMN.size,
                                            'pr-2 text-right text-[13px] text-muted-foreground tabular-nums',
                                        )}
                                    >
                                        {row.node.kind === 'folder' || !row.node.currentVersion
                                            ? '–'
                                            : formatBytes(nodeSize(row.node))}
                                    </td>
                                    <td className="pr-3 text-right sm:pr-5">
                                        {rowBusy ? (
                                            <output className="inline-flex items-center gap-2 pr-2 text-[13px] text-muted-foreground">
                                                <Spinner />
                                                <span className={TRASH_COLUMN.actionLabel}>
                                                    Working…
                                                </span>
                                            </output>
                                        ) : (
                                            writable(row) && (
                                                <span
                                                    className={cn(
                                                        'flex justify-end gap-1 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100',
                                                        coarse ? 'opacity-100' : 'opacity-0',
                                                    )}
                                                >
                                                    <Button
                                                        variant="outline"
                                                        disabled={busy !== null}
                                                        aria-label={
                                                            row.parentTrashed
                                                                ? `Restore “${row.node.name}” to ${row.folder}`
                                                                : `Restore “${row.node.name}”`
                                                        }
                                                        onClick={() => void restore(row)}
                                                    >
                                                        <RotateCcwIcon />
                                                        <span className={TRASH_COLUMN.actionLabel}>
                                                            {row.parentTrashed
                                                                ? `Restore to ${row.folder}`
                                                                : 'Restore'}
                                                        </span>
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={`Delete “${row.node.name}” forever`}
                                                        title="Delete forever"
                                                        className="text-destructive hover:bg-destructive-soft hover:text-destructive"
                                                        disabled={busy !== null}
                                                        onClick={() => setDeleting(row)}
                                                    >
                                                        <Trash2Icon />
                                                    </Button>
                                                </span>
                                            )
                                        )}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
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
                                : 'It goes for everyone in the family. It can’t be restored after this.'}
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

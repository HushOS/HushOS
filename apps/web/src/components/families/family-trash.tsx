import type { TrashItem } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { cn } from 'cn';
import { useEffect, useState, type ReactNode } from 'react';
import { EmptyState, SkeletonRows, useCoarsePointer } from '@/components/drive/file-list';
import { FileMark } from '@/components/drive/file-mark';
import { TRASH_COLUMN } from '@/components/drive/trash-view';
import { Spinner } from '@/components/motion';
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

/* The family folders' Trash, every folder's together, newest first: shared by the tab and its prefetch. */
function familyTrashQueryOptions(space: ReturnType<typeof useFamilySpace>) {
    return {
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
            // Newest first, by time. The API client can hand the time back as a Date rather than
            // the ISO string the type says, and sorting it as a string threw on two or more items.
            const at = (row: Row) =>
                row.node.trashedAt ? new Date(row.node.trashedAt).getTime() : 0;
            return rows.sort((a, b) => at(b) - at(a));
        },
        staleTime: 15_000,
        retry: 1,
    };
}

/* Read while My files' tab is open, so the family's tab shows its list at once. */
export function PrefetchFamilyTrash() {
    const space = useFamilySpace();
    const queryClient = useQueryClient();
    const options = familyTrashQueryOptions(space);
    // The family's folders are known once the space has synced; the list follows them.
    const ready = space.areas.length;
    useEffect(() => {
        if (ready) void queryClient.prefetchQuery(options);
        // `options` is rebuilt each render from the same space.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [queryClient, ready]);
    return null;
}

/*
 * The family folders' Trash as a Trash of its own (docs/families-shared-pool.md 7.1), the
 * family's tab of Trash beside My files', inside the family's space (FamilySpaceScope). It
 * reads as My files' does: the same header, columns, rows and actions. Restore puts an item
 * back (in its family folder's top folder when its own folder is in the Trash too); Delete
 * forever and Empty Trash ask once. Anyone in the family may do any of these, as in the
 * folders themselves, and only where this device may write in that folder: Empty Trash leaves
 * what this device can't change. Items stay 30 days, as in My files.
 */
export function FamilyTrashView({ tabs }: { tabs: ReactNode }) {
    const space = useFamilySpace();
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);
    const [deleting, setDeleting] = useState<Row | null>(null);
    const [confirmEmpty, setConfirmEmpty] = useState(false);
    const [emptying, setEmptying] = useState<{ gone: number; total: number } | null>(null);
    const mobile = useIsMobile();
    // Touch has no hover: the actions show on every row there, as in My files' Trash.
    const coarse = useCoarsePointer();
    const trash = useQuery(familyTrashQueryOptions(space));
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

    // What Empty Trash deletes: every item this device may write, less those inside a folder
    // that is in the Trash too, which go with it.
    const emptiable = (trash.data ?? []).filter((row) => writable(row) && !row.parentTrashed);

    async function emptyAll() {
        setConfirmEmpty(false);
        const rows = emptiable;
        setEmptying({ gone: 0, total: rows.length });
        let failed = 0;
        for (const [index, row] of rows.entries()) {
            try {
                const state = space.areas.find((area) => area.workspaceId === row.workspaceId)!;
                const { client } = await openArea(space.userId, space.groupId, state);
                await client.purge(row.node);
            } catch {
                failed += 1;
            }
            setEmptying({ gone: index + 1, total: rows.length });
        }
        setEmptying(null);
        await invalidateFolders(queryClient);
        if (failed === 0) {
            cue('droplet');
            toast.add({ type: 'success', title: 'Trash emptied' });
        } else {
            cue('error');
            toast.add({
                type: 'error',
                title: 'The Trash couldn’t be emptied',
                description: `${failed} of ${rows.length} ${rows.length === 1 ? 'item is' : 'items are'} still there. Try again.`,
            });
        }
    }

    return (
        // The same list as My files' Trash (TrashView): its columns by the list's own width,
        // the same row and the same two actions, shown on hover as there.
        <div className="@container/list flex flex-1 flex-col" data-family-trash>
            <PageHeader
                title="Trash"
                description="Items stay here for 30 days, then they’re deleted for good. They count towards the family’s storage until then."
            >
                {emptiable.length > 0 && (
                    <Button
                        variant="outline"
                        disabled={busy !== null || emptying !== null}
                        onClick={() => setConfirmEmpty(true)}
                    >
                        {emptying ? <Spinner /> : <Trash2Icon />}
                        {emptying
                            ? `Emptying… ${emptying.gone} of ${emptying.total}`
                            : 'Empty Trash'}
                    </Button>
                )}
            </PageHeader>
            {tabs}
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
                <EmptyState
                    title="Trash is empty"
                    body="What anyone in the family moves to the Trash from the family folders stays here for 30 days."
                />
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
                                                        disabled={
                                                            busy !== null || emptying !== null
                                                        }
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
                                                        disabled={
                                                            busy !== null || emptying !== null
                                                        }
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
            <AlertDialog open={confirmEmpty} onOpenChange={setConfirmEmpty}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Empty the family folders’ Trash?</AlertDialogTitle>
                        <AlertDialogDescription>
                            All {emptiable.length} {emptiable.length === 1 ? 'item' : 'items'} in
                            the family folders’ Trash {emptiable.length === 1 ? 'is' : 'are'}{' '}
                            deleted for good, for everyone in the family. This can’t be undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button variant="destructive" onClick={() => void emptyAll()}>
                            Empty Trash
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
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

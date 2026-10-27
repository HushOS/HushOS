import type { DriveNode, TrashItem } from '@hushos/drive/client';
import { useHotkey } from '@tanstack/react-hotkeys';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ListChecksIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useDrive } from '@/components/drive/drive-shell';
import {
    EmptyState,
    MarqueeBox,
    SelectableMark,
    SelectionAction,
    SelectionBar,
    SkeletonRows,
    useListSelection,
} from '@/components/drive/file-list';
import { FileMark } from '@/components/drive/file-mark';
import { keyLabel } from '@/components/drive/shortcuts';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { useIsMobile } from '@/hooks/use-mobile';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuSeparator,
    ContextMenuShortcut,
    ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { toast } from '@/components/ui/toast';
import {
    driveClient,
    driveError,
    folderQueryOptions,
    formatBytes,
    formatWhen,
    invalidateFolders,
    nodeSize,
    purgeTrashRows,
    refreshSharing,
    restoreTrashRows,
    trashQueryOptions,
} from '@/lib/drive';
import { MAX_TRASH_BATCH } from '@hushos/drive/protocol';
import { DriveApiError } from '@hushos/drive/api';
import { cue } from '@/lib/sounds';
import { emptyTrashAll } from '@/lib/trash';

/*
 * Everything with its own trashed_at, newest first. It reads and selects as Files
 * does: click, Mod-click, Shift-click, a box drawn on empty space, arrows. Restore
 * puts an item back where it was; when that place is itself in the Trash, it goes
 * to My files instead, which is a move and a restore in one request. Deleting
 * forever always asks first. Several go in batch requests (lib/trash-batch.ts),
 * and the rows each request settles leave the list as it lands.
 */

/* Whether an ancestor of `item` is among `ids`: its fate then follows that ancestor's. */
function underAny(item: TrashItem, ids: Set<string>) {
    return item.ancestors.some((ancestor) => ids.has(ancestor.id));
}

/* The folder an item was in, as the person knows it: their top folder is "My files". */
function folderName(folder: DriveNode | undefined) {
    if (!folder) return 'My files';
    return folder.parentId === null ? 'My files' : folder.name;
}

type Confirm = { kind: 'one'; item: TrashItem } | { kind: 'many' } | { kind: 'empty' } | null;

type PartialRestore = {
    restored: number;
    total: number;
    failed: { item: TrashItem; reason: string }[];
    /* Back, but in My files: their folder is still in the Trash. */
    moved: TrashItem[];
};

/* A bar under the title while several go back or go for good. */
function Progress({ label, done, total }: { label: string; done: number; total: number }) {
    return (
        <output className="flex items-center gap-3 px-5 pb-4 sm:px-8">
            <span className="text-sm font-semibold whitespace-nowrap">{label}</span>
            <span className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-rule">
                <span
                    className="rounded-full bg-primary transition-[width] duration-500"
                    style={{ width: `${(done / Math.max(1, total)) * 100}%` }}
                />
            </span>
            <span className="text-[13px] text-muted-foreground tabular-nums">
                {done} of {total}
            </span>
        </output>
    );
}

/*
 * What a restore of several couldn't do, and why, with Try again. It stays above
 * the list, where the failed rows also say so, instead of a toast that goes.
 */
function PartialBanner({
    partial,
    busy,
    onRetry,
    onDismiss,
}: {
    partial: PartialRestore;
    busy: boolean;
    onRetry: () => void;
    onDismiss: () => void;
}) {
    const shown = partial.failed.slice(0, 3);
    const more = partial.failed.length - shown.length;
    return (
        <div
            role="alert"
            className="mx-5 mb-4 flex flex-col gap-1.5 rounded-xl bg-destructive-soft px-4 py-3 sm:mx-8"
        >
            <span className="text-[15px] font-semibold text-destructive">
                Restored {partial.restored} of {partial.total}
            </span>
            {shown.map(({ item, reason }) => (
                <span key={item.node.id} className="text-sm wrap-anywhere">
                    “{item.node.name}” couldn’t be restored. {reason}
                </span>
            ))}
            {more > 0 && <span className="text-sm">{more} more couldn’t be restored either.</span>}
            {partial.moved.map((item) => (
                <span key={item.node.id} className="text-sm text-muted-foreground wrap-anywhere">
                    “{item.node.name}” went back to My files, because its folder “
                    {folderName(item.ancestors.at(-1))}” is still in the Trash.
                </span>
            ))}
            <span className="flex gap-2 pt-1">
                <Button size="sm" disabled={busy} onClick={onRetry}>
                    <RotateCcwIcon />
                    Try again
                </Button>
                <Button size="sm" variant="ghost" onClick={onDismiss}>
                    Dismiss
                </Button>
            </span>
        </div>
    );
}

export function TrashView({
    section,
    followed = false,
}: {
    /* A heading for My files' items, when another section follows (the family folders'). */
    section?: string;
    /* Another section follows the list (the family folders' Trash): the list doesn't fill the page. */
    followed?: boolean;
} = {}) {
    const { rootId, userId } = useDrive();
    const queryClient = useQueryClient();
    const trash = useQuery(trashQueryOptions);
    const root = useQuery(folderQueryOptions(rootId));
    /* The row a request is working on, so it can say so in place. */
    const [active, setActive] = useState<{ id: string; verb: 'restoring' | 'deleting' } | null>(
        null,
    );
    const [confirm, setConfirm] = useState<Confirm>(null);
    /* Emptying: how many are gone of how many there were. */
    const [emptying, setEmptying] = useState<{ gone: number; total: number } | null>(null);
    /* What a restore of several couldn't do; it stays until dismissed or retried. */
    const [partial, setPartial] = useState<PartialRestore | null>(null);
    /*
     * A batch under way: what it is doing, and how far. `requests` is how many it
     * takes; with one, it is over before a bar could say anything, so none shows.
     */
    const [batch, setBatch] = useState<{
        verb: 'Restoring' | 'Deleting';
        done: number;
        total: number;
        requests: number;
    } | null>(null);
    const rows = useMemo(() => trash.data ?? [], [trash.data]);
    const ids = useMemo(() => rows.map((item) => item.node.id), [rows]);
    const listRef = useRef<HTMLDivElement>(null);
    const mobile = useIsMobile();
    const {
        coarse,
        selected,
        setSelected,
        focused,
        marquee,
        select,
        toggle,
        clear,
        selectAll,
        moveFocus,
    } = useListSelection(ids, listRef);
    // Only rows still in the trash count: one restored or deleted elsewhere drops out of the selection.
    const picked = rows.filter((item) => selected.has(item.node.id));
    const allPicked = rows.length > 0 && picked.length === rows.length;
    const working = batch !== null || active !== null || emptying !== null;
    const failedIds = useMemo(
        () => new Set(partial?.failed.map((entry) => entry.item.node.id)),
        [partial],
    );

    // Keys work while nothing else has them: no dialog open, nothing under way.
    const keys = confirm === null && !working;
    useHotkey('ArrowDown', () => moveFocus(1), { enabled: keys });
    useHotkey('ArrowUp', () => moveFocus(-1), { enabled: keys });
    useHotkey('Shift+ArrowDown', () => moveFocus(1, true), { enabled: keys });
    useHotkey('Shift+ArrowUp', () => moveFocus(-1, true), { enabled: keys });
    useHotkey('Mod+A', selectAll, { enabled: keys, ignoreInputs: true });
    useHotkey('Escape', clear, { enabled: keys });
    // In the Trash the delete key deletes forever, so it always asks first.
    useHotkey('Backspace', () => picked.length > 0 && setConfirm({ kind: 'many' }), {
        enabled: keys,
    });
    useHotkey('Delete', () => picked.length > 0 && setConfirm({ kind: 'many' }), {
        enabled: keys,
    });
    // Enter acts on the selection as it opens in Files: here that is bringing it back.
    useHotkey(
        'Enter',
        (event) => {
            if (event.target instanceof Element && event.target.closest('a, button')) return;
            if (picked.length > 0) void restoreMany(picked);
        },
        { enabled: keys, preventDefault: false },
    );

    /* Takes a finished row off the list at once, before the refetch confirms it. */
    function drop(id: string) {
        queryClient.setQueryData(trashQueryOptions.queryKey, (current) =>
            current?.filter((item) => item.node.id !== id),
        );
        setSelected((current) => {
            const next = new Set(current);
            next.delete(id);
            return next;
        });
    }

    /*
     * Restores the picked rows. Those whose folders in the Trash are all picked
     * too go back where they were, in batch requests that bring each folder back
     * before what is in it. The rest, and any whose folder could not come back,
     * go to My files, one request each, since each needs its key wrapped again.
     */
    async function restoreMany(items: TrashItem[]) {
        if (working) return;
        setPartial(null);
        const pickedIds = new Set(items.map((item) => item.node.id));
        const home = (item: TrashItem) =>
            item.ancestors.every((ancestor) => !ancestor.trashedAt || pickedIds.has(ancestor.id));
        const inPlace = items.filter(home);
        const toRoot = items.filter((item) => !home(item));
        const total = items.length;
        let done = 0;
        const requests = Math.ceil(inPlace.length / MAX_TRASH_BATCH) + toRoot.length;
        setBatch({ verb: 'Restoring', done, total, requests });
        const failed: PartialRestore['failed'] = [];
        const moved: TrashItem[] = [];
        if (inPlace.length) {
            const byId = new Map(inPlace.map((item) => [item.node.id, item]));
            const result = await restoreTrashRows(inPlace, (back) => {
                for (const node of back) drop(node.id);
                done += back.length;
                setBatch({ verb: 'Restoring', done, total, requests });
            });
            for (const { node, error } of result.failed) {
                const item = byId.get(node.id)!;
                // Its folder was picked but stayed in the Trash: My files, as for the rest.
                if (error instanceof DriveApiError && error.code === 'parent-trashed')
                    toRoot.push(item);
                else failed.push({ item, reason: driveError(error) });
            }
        }
        for (const item of toRoot) {
            setActive({ id: item.node.id, verb: 'restoring' });
            try {
                const target = root.data?.folder;
                if (!target) throw new Error('My files isn’t open yet.');
                await driveClient.restore(item.node, target);
                moved.push(item);
                drop(item.node.id);
            } catch (error) {
                failed.push({ item, reason: driveError(error) });
            }
            setBatch({ verb: 'Restoring', done: ++done, total, requests });
        }
        setActive(null);
        setBatch(null);
        // One refresh for the whole batch, in the background: the rows have already gone.
        void invalidateFolders(queryClient);
        const restored = total - failed.length;
        if (restored > 0) void refreshSharing(queryClient);
        if (failed.length) {
            // Several, and some didn't come back: that stays on the page, not in a toast.
            cue('error');
            setPartial({ restored, total, failed, moved });
            return;
        }
        cue('success');
        toast.add({
            type: 'success',
            title:
                restored === 1
                    ? moved.length
                        ? `Restored “${items[0]!.node.name}” to My files`
                        : `Restored “${items[0]!.node.name}” to ${folderName(items[0]!.ancestors.at(-1))}`
                    : `${restored} items restored`,
            description: moved.length
                ? `${moved.length === 1 ? 'One went' : `${moved.length} went`} to My files, because ${moved.length === 1 ? 'its folder is' : 'their folders are'} still in the Trash.`
                : undefined,
        });
    }

    /*
     * Deletes the picked rows forever, in batch requests; anything inside a picked
     * folder goes with it, so it is not asked for twice. The count is of the rows
     * picked that are gone, those inside a deleted folder included.
     */
    async function purgeMany(items: TrashItem[]) {
        if (working) return;
        const pickedIds = new Set(items.map((item) => item.node.id));
        const sent = items.filter((item) => !underAny(item, pickedIds)).length;
        const total = items.length;
        let done = 0;
        const requests = Math.ceil(sent / MAX_TRASH_BATCH);
        setBatch({ verb: 'Deleting', done, total, requests });
        const { gone, error } = await purgeTrashRows(items, (ids) => {
            for (const id of ids) drop(id);
            done += ids.length;
            setBatch({ verb: 'Deleting', done, total, requests });
        });
        setBatch(null);
        // One refresh for the whole batch, in the background: the rows have already gone.
        void invalidateFolders(queryClient);
        const all = gone.length === total;
        cue(all ? 'droplet' : 'error');
        toast.add({
            type: all ? 'success' : 'error',
            title: !all
                ? gone.length === 0
                    ? total === 1
                        ? `Couldn’t delete “${items[0]!.node.name}”`
                        : 'Couldn’t delete them'
                    : `${gone.length} of ${total} deleted forever`
                : total === 1
                  ? `Deleted “${items[0]!.node.name}” forever`
                  : `${total} items deleted forever`,
            description: all ? 'Their space frees up in a moment.' : driveError(error),
        });
    }

    /* Empties the Trash a batch at a time until the server reports nothing left. */
    async function emptyAll() {
        if (working) return;
        setPartial(null);
        const total = rows.length;
        setEmptying({ gone: 0, total });
        try {
            // A folder's contents go with it, so the server can count more than the rows.
            await emptyTrashAll(queryClient, userId, (purged) =>
                setEmptying({ gone: Math.min(purged, total), total }),
            );
            cue('droplet');
            toast.add({
                type: 'success',
                title: 'Trash emptied',
                description: 'Their space frees up in a moment.',
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'The Trash couldn’t be emptied',
                description: driveError(error),
            });
        } finally {
            setEmptying(null);
            await invalidateFolders(queryClient);
        }
    }

    async function restore(item: TrashItem) {
        if (working) return;
        setActive({ id: item.node.id, verb: 'restoring' });
        try {
            const target = item.parentTrashed ? root.data?.folder : undefined;
            if (item.parentTrashed && !target) throw new Error('My files isn’t open yet.');
            const restored = await driveClient.restore(item.node, target);
            cue('success');
            toast.add({
                type: 'success',
                title: item.parentTrashed
                    ? `Restored “${item.node.name}” to My files`
                    : `Restored “${item.node.name}” to ${folderName(item.ancestors.at(-1))}`,
                description: item.parentTrashed
                    ? `Its folder “${folderName(item.ancestors.at(-1))}” is in the Trash too.`
                    : undefined,
            });
            await invalidateFolders(queryClient, restored.parentId, item.node.parentId);
            void refreshSharing(queryClient);
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: `Couldn’t restore “${item.node.name}”`,
                description: driveError(error),
            });
            await invalidateFolders(queryClient);
        } finally {
            setActive(null);
        }
    }

    /* Delete forever: the server purges the node now; anything inside follows in the background. */
    async function purge(item: TrashItem) {
        if (working) return;
        setActive({ id: item.node.id, verb: 'deleting' });
        try {
            await driveClient.purge(item.node);
            drop(item.node.id);
            cue('droplet');
            toast.add({
                type: 'success',
                title: `Deleted “${item.node.name}” forever`,
                description: 'Its space frees up in a moment.',
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: `Couldn’t delete “${item.node.name}”`,
                description: driveError(error),
            });
        } finally {
            setActive(null);
            await invalidateFolders(queryClient);
        }
    }

    const words =
        confirm?.kind === 'one'
            ? {
                  title: `Delete “${confirm.item.node.name}” forever?`,
                  text:
                      confirm.item.node.kind === 'folder'
                          ? 'Everything inside goes too. It can’t be restored after this.'
                          : 'It can’t be restored after this.',
                  action: 'Delete forever',
              }
            : confirm?.kind === 'many'
              ? {
                    title:
                        picked.length === 1
                            ? `Delete “${picked[0]?.node.name ?? ''}” forever?`
                            : `Delete ${picked.length} items forever?`,
                    text: picked.some((item) => item.node.kind === 'folder')
                        ? 'Everything inside the folders goes too. They can’t be restored after this.'
                        : 'They can’t be restored after this.',
                    action: 'Delete forever',
                }
              : {
                    title: section ? `Empty ${section}’ Trash?` : 'Empty the Trash?',
                    text: `All ${rows.length} ${rows.length === 1 ? 'item is' : 'items are'} deleted for good. This can’t be undone.${section ? ' The family folders’ Trash isn’t touched.' : ''}`,
                    action: section ? `Empty ${section}’ Trash` : 'Empty Trash',
                };

    return (
        <div
            ref={listRef}
            // Columns by the list's own width, as the file lists' (LIST_COLUMN in file-list.tsx):
            // the name column keeps at least 320px; Was in goes first (its words move under the
            // name), then Size, then the action labels, then Trashed.
            className={cn(
                '@container/list relative flex flex-col',
                !followed && 'flex-1',
                marquee && 'select-none',
            )}
        >
            <MarqueeBox marquee={marquee} />
            <PageHeader
                title="Trash"
                description="Items stay here for 30 days, then they’re deleted for good. They count towards your storage until then."
            >
                {rows.length > 0 && (
                    <Button
                        variant="outline"
                        disabled={working}
                        onClick={() => setConfirm({ kind: 'empty' })}
                    >
                        {emptying ? <Spinner /> : <Trash2Icon />}
                        {emptying
                            ? `Emptying… ${emptying.gone} of ${emptying.total}`
                            : // Above both sections, it says which Trash it empties.
                              section
                              ? `Empty ${section}’ Trash`
                              : 'Empty Trash'}
                    </Button>
                )}
            </PageHeader>
            {(emptying || (batch && batch.requests > 1)) && (
                <Progress
                    label={
                        emptying
                            ? 'Emptying the Trash…'
                            : batch!.verb === 'Restoring'
                              ? 'Restoring…'
                              : 'Deleting forever…'
                    }
                    done={emptying ? emptying.gone : batch!.done}
                    total={emptying ? emptying.total : batch!.total}
                />
            )}
            {partial && (
                <PartialBanner
                    partial={partial}
                    busy={working}
                    onRetry={() => void restoreMany(partial.failed.map((entry) => entry.item))}
                    onDismiss={() => setPartial(null)}
                />
            )}
            {section && (
                <h2 className="px-5 pb-2 text-lg font-bold tracking-[-0.01em] sm:px-8">
                    {section}
                </h2>
            )}
            {trash.isPending && <SkeletonRows />}
            {trash.isError && (
                <EmptyState
                    title="The Trash couldn’t be opened"
                    body="Check your connection and try again. Nothing in it has been deleted."
                >
                    <Button variant="outline" onClick={() => void trash.refetch()}>
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </EmptyState>
            )}
            {trash.data && rows.length === 0 && (
                <EmptyState
                    title="Trash is empty"
                    body="Items you move to the Trash stay here for 30 days."
                />
            )}
            {rows.length > 0 && (
                <table
                    aria-label="Trash"
                    aria-multiselectable="true"
                    className="w-full table-fixed border-collapse"
                >
                    <thead>
                        <tr className="h-10 border-b border-rule text-xs font-semibold text-muted-foreground">
                            <th scope="col" className="pl-5 text-left sm:pl-8">
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
                        {rows.map((item) => {
                            const isSelected = selected.has(item.node.id);
                            const parent = item.ancestors.at(-1);
                            const location = item.ancestors.map(folderName).join(' › ');
                            // The folder it was in: a link back to it, unless it is gone or in the Trash too.
                            const whereFolder =
                                item.parentTrashed || !parent ? (
                                    <span className="font-semibold">{folderName(parent)}</span>
                                ) : (
                                    <Link
                                        {...(parent.id === rootId
                                            ? ({ to: '/app/drive' } as const)
                                            : ({
                                                  to: '/app/drive/f/$folderId',
                                                  params: { folderId: parent.id },
                                              } as const))}
                                        className="font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                                    >
                                        {folderName(parent)}
                                    </Link>
                                );
                            const rowBusy = active?.id === item.node.id ? active.verb : null;
                            const rowFailed = failedIds.has(item.node.id);
                            return (
                                <ContextMenu
                                    key={item.node.id}
                                    onOpenChange={(open) => {
                                        // A right-click on a row outside the selection acts on that row alone.
                                        if (open && !isSelected) select(item.node.id);
                                    }}
                                >
                                    <ContextMenuTrigger
                                        render={
                                            <tr
                                                aria-selected={isSelected}
                                                data-node-id={item.node.id}
                                            />
                                        }
                                        className={cn(
                                            'group/row h-14 cursor-default border-b border-rule select-none',
                                            isSelected ? 'bg-accent' : 'hover:bg-muted',
                                            focused === item.node.id &&
                                                !isSelected &&
                                                'ring-1 ring-ring ring-inset',
                                        )}
                                    >
                                        <td className="min-w-0 p-0">
                                            <span className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-3 pl-5 sm:pl-8 md:grid-cols-[2.5rem_minmax(0,1fr)] md:gap-x-4">
                                                <span
                                                    className={cn(
                                                        'row-span-2',
                                                        // Two lines while Was in sits under the name.
                                                        !rowFailed && TRASH_COLUMN.whereSpan,
                                                    )}
                                                >
                                                    <SelectableMark
                                                        name={item.node.name}
                                                        checked={isSelected}
                                                        revealed={coarse && picked.length > 0}
                                                        onToggle={() => toggle(item.node.id)}
                                                    >
                                                        <FileMark
                                                            node={item.node}
                                                            size={mobile ? 'row' : 'list'}
                                                        />
                                                    </SelectableMark>
                                                </span>
                                                <span className="truncate text-[14px] font-medium md:text-[15px]">
                                                    {item.node.name}
                                                </span>
                                                {rowFailed ? (
                                                    <span className="col-start-2 truncate text-[13px] font-semibold text-destructive">
                                                        Couldn’t be restored
                                                    </span>
                                                ) : (
                                                    // Where it was, on screens with no room for the column.
                                                    <span
                                                        className={cn(
                                                            TRASH_COLUMN.whereLine,
                                                            'truncate text-[13px] text-muted-foreground',
                                                        )}
                                                        title={location}
                                                    >
                                                        Was in {whereFolder}
                                                        {item.parentTrashed &&
                                                            ', also in the Trash'}
                                                    </span>
                                                )}
                                            </span>
                                        </td>
                                        <td
                                            className={cn(
                                                TRASH_COLUMN.where,
                                                'min-w-0 pr-4 text-[13px]',
                                            )}
                                        >
                                            <span
                                                className="flex min-w-0 flex-col"
                                                title={location}
                                            >
                                                <span className="truncate">{whereFolder}</span>
                                                {item.parentTrashed && (
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
                                            {formatWhen(item.node.trashedAt)}
                                        </td>
                                        <td
                                            className={cn(
                                                TRASH_COLUMN.size,
                                                'pr-2 text-right text-[13px] text-muted-foreground tabular-nums',
                                            )}
                                        >
                                            {item.node.kind === 'folder' ? (
                                                '–'
                                            ) : !item.node.currentVersion ? (
                                                <span title="This upload didn’t finish, so nothing was stored.">
                                                    –
                                                </span>
                                            ) : (
                                                formatBytes(nodeSize(item.node))
                                            )}
                                        </td>
                                        <td className="pr-3 text-right sm:pr-5">
                                            {rowBusy ? (
                                                <output className="inline-flex items-center gap-2 pr-2 text-[13px] text-muted-foreground">
                                                    <Spinner />
                                                    <span className={TRASH_COLUMN.actionLabel}>
                                                        {rowBusy === 'restoring'
                                                            ? 'Restoring…'
                                                            : 'Deleting forever…'}
                                                    </span>
                                                </output>
                                            ) : (
                                                <span
                                                    className={cn(
                                                        'flex justify-end gap-1 transition-opacity group-focus-within/row:opacity-100 group-hover/row:opacity-100',
                                                        coarse || isSelected
                                                            ? 'opacity-100'
                                                            : 'opacity-0',
                                                    )}
                                                >
                                                    <Button
                                                        variant="outline"
                                                        disabled={working}
                                                        aria-label={
                                                            item.parentTrashed
                                                                ? `Restore “${item.node.name}” to My files`
                                                                : `Restore “${item.node.name}”`
                                                        }
                                                        title={
                                                            item.parentTrashed
                                                                ? `Its folder “${folderName(parent)}” is in the Trash too.`
                                                                : undefined
                                                        }
                                                        onClick={() => void restore(item)}
                                                    >
                                                        <RotateCcwIcon />
                                                        <span className={TRASH_COLUMN.actionLabel}>
                                                            {item.parentTrashed
                                                                ? 'Restore to My files'
                                                                : 'Restore'}
                                                        </span>
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        aria-label={`Delete “${item.node.name}” forever`}
                                                        title="Delete forever"
                                                        className="text-destructive hover:bg-destructive-soft hover:text-destructive"
                                                        disabled={working}
                                                        onClick={() =>
                                                            setConfirm({ kind: 'one', item })
                                                        }
                                                    >
                                                        <Trash2Icon />
                                                    </Button>
                                                </span>
                                            )}
                                        </td>
                                    </ContextMenuTrigger>
                                    <ContextMenuContent>
                                        <ContextMenuItem
                                            disabled={working}
                                            onClick={() =>
                                                isSelected && picked.length > 1
                                                    ? void restoreMany(picked)
                                                    : void restore(item)
                                            }
                                        >
                                            {isSelected && picked.length > 1
                                                ? `Restore ${picked.length} items`
                                                : item.parentTrashed
                                                  ? 'Restore to My files'
                                                  : 'Restore'}
                                            <ContextMenuShortcut>
                                                {keyLabel('Enter')}
                                            </ContextMenuShortcut>
                                        </ContextMenuItem>
                                        <ContextMenuSeparator />
                                        <ContextMenuItem
                                            variant="destructive"
                                            disabled={working}
                                            onClick={() =>
                                                setConfirm(
                                                    isSelected && picked.length > 1
                                                        ? { kind: 'many' }
                                                        : { kind: 'one', item },
                                                )
                                            }
                                        >
                                            Delete forever
                                            <ContextMenuShortcut>
                                                {keyLabel('Backspace')}
                                            </ContextMenuShortcut>
                                        </ContextMenuItem>
                                    </ContextMenuContent>
                                </ContextMenu>
                            );
                        })}
                    </tbody>
                </table>
            )}
            {picked.length > 0 && (
                <SelectionBar
                    label={
                        batch
                            ? `${batch.verb} ${batch.done} of ${batch.total}`
                            : `${picked.length} selected`
                    }
                    onClear={batch ? undefined : clear}
                >
                    <SelectionAction
                        icon={RotateCcwIcon}
                        label="Restore"
                        disabled={working}
                        onClick={() => void restoreMany(picked)}
                    />
                    <SelectionAction
                        icon={Trash2Icon}
                        label="Delete forever"
                        disabled={working}
                        onClick={() => setConfirm({ kind: 'many' })}
                    />
                    {!allPicked && (
                        <SelectionAction
                            icon={ListChecksIcon}
                            label="Select all"
                            className="max-sm:hidden"
                            disabled={working}
                            onClick={selectAll}
                        />
                    )}
                </SelectionBar>
            )}
            <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>{words.title}</AlertDialogTitle>
                        <AlertDialogDescription>{words.text}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            onClick={() => {
                                const target = confirm;
                                setConfirm(null);
                                if (target?.kind === 'empty') void emptyAll();
                                else if (target?.kind === 'many') void purgeMany(picked);
                                else if (target?.kind === 'one') void purge(target.item);
                            }}
                        >
                            {words.action}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

/*
 * The Trash list's columns by its own width (see the list's comment): the name column keeps
 * at least 320px beside 128px of icon actions (on touch, Restore 48px and Delete forever 44px).
 * Was in goes first (its words move under the name, `whereLine`, and the mark spans both lines,
 * `whereSpan`), then Size, then the action labels (the actions widen to 256px, which "Restore to
 * My files" and Delete forever need on touch), then Trashed.
 */
const TRASH_COLUMN = {
    where: 'hidden @min-[66rem]/list:table-cell',
    whereLine: '@min-[66rem]/list:hidden',
    whereSpan: '@min-[66rem]/list:row-span-1',
    trashed: 'hidden @min-[37rem]/list:table-cell',
    size: 'hidden @min-[51rem]/list:table-cell',
    actionsWide: '@min-[45rem]/list:w-64',
    actionLabel: '@max-[45rem]/list:sr-only',
} as const;

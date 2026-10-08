import type { DriveNode, TrashItem } from '@hushos/drive/client';
import { useHotkey } from '@tanstack/react-hotkeys';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { ListChecksIcon, RotateCcwIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
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
    trashQueryOptions,
} from '@/lib/drive';
import { cue } from '@/lib/sounds';
import { emptyTrashAll } from '@/lib/trash';

/*
 * Everything with its own trashed_at, newest first. It reads and selects as Files
 * does: click, Mod-click, Shift-click, a box drawn on empty space, arrows. Restore
 * puts an item back where it was; when that place is itself in the Trash, it goes
 * to My files instead, which is a move and a restore in one request. Deleting
 * forever always asks first, and each row leaves the list as its own request ends.
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

export function TrashView() {
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
    /* A batch under way: what it is doing, and how far. */
    const [batch, setBatch] = useState<{
        verb: 'Restoring' | 'Deleting';
        done: number;
        total: number;
    } | null>(null);
    const rows = useMemo(() => trash.data ?? [], [trash.data]);
    const ids = useMemo(() => rows.map((item) => item.node.id), [rows]);
    const listRef = useRef<HTMLDivElement>(null);
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
     * Restores the picked rows. Shallowest first, so a folder comes back before what
     * was trashed inside it; an item whose trashed ancestors all came back in this
     * batch goes home, one whose ancestor is still in the Trash goes to My files.
     */
    async function restoreMany(items: TrashItem[]) {
        if (working) return;
        setPartial(null);
        const ordered = [...items].sort((a, b) => a.ancestors.length - b.ancestors.length);
        const back = new Set<string>();
        const failed: PartialRestore['failed'] = [];
        const moved: TrashItem[] = [];
        setBatch({ verb: 'Restoring', done: 0, total: ordered.length });
        for (const [index, item] of ordered.entries()) {
            const trashedAbove = item.ancestors.filter((ancestor) => ancestor.trashedAt);
            const home = trashedAbove.every((ancestor) => back.has(ancestor.id));
            setActive({ id: item.node.id, verb: 'restoring' });
            try {
                const target = home ? undefined : root.data?.folder;
                if (!home && !target) throw new Error('My files isn’t open yet.');
                await driveClient.restore(item.node, target);
                back.add(item.node.id);
                if (!home) moved.push(item);
                drop(item.node.id);
            } catch (error) {
                failed.push({ item, reason: driveError(error) });
            }
            setBatch({ verb: 'Restoring', done: index + 1, total: ordered.length });
        }
        setActive(null);
        setBatch(null);
        await invalidateFolders(queryClient);
        const restored = ordered.length - failed.length;
        if (failed.length) {
            // Several, and some didn't come back: that stays on the page, not in a toast.
            cue('error');
            setPartial({ restored, total: ordered.length, failed, moved });
            return;
        }
        cue('success');
        toast.add({
            type: 'success',
            title:
                restored === 1
                    ? moved.length
                        ? `Restored “${ordered[0]!.node.name}” to My files`
                        : `Restored “${ordered[0]!.node.name}” to ${folderName(ordered[0]!.ancestors.at(-1))}`
                    : `${restored} items restored`,
            description: moved.length
                ? `${moved.length === 1 ? 'One went' : `${moved.length} went`} to My files, because ${moved.length === 1 ? 'its folder is' : 'their folders are'} still in the Trash.`
                : undefined,
        });
    }

    /* Deletes the picked rows forever; anything inside a picked folder goes with it, so it is not asked for twice. */
    async function purgeMany(items: TrashItem[]) {
        if (working) return;
        const picked = new Set(items.map((item) => item.node.id));
        const tops = items.filter((item) => !underAny(item, picked));
        let failed = 0;
        setBatch({ verb: 'Deleting', done: 0, total: tops.length });
        for (const [index, item] of tops.entries()) {
            setActive({ id: item.node.id, verb: 'deleting' });
            try {
                await driveClient.purge(item.node);
                drop(item.node.id);
                for (const inner of items)
                    if (underAny(inner, new Set([item.node.id]))) drop(inner.node.id);
            } catch {
                failed++;
            }
            setBatch({ verb: 'Deleting', done: index + 1, total: tops.length });
        }
        setActive(null);
        setBatch(null);
        await invalidateFolders(queryClient);
        cue(failed ? 'error' : 'droplet');
        toast.add({
            type: failed ? 'error' : 'success',
            title: failed
                ? `${failed} of ${tops.length} couldn’t be deleted`
                : items.length === 1
                  ? `Deleted “${items[0]!.node.name}” forever`
                  : `${items.length} items deleted forever`,
            description: failed
                ? 'Check your connection and try again.'
                : 'Their space frees up in a moment.',
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
                    title: 'Empty the Trash?',
                    text: `All ${rows.length} ${rows.length === 1 ? 'item is' : 'items are'} deleted for good. This can’t be undone.`,
                    action: 'Empty Trash',
                };

    return (
        <div
            ref={listRef}
            className={cn('relative flex flex-1 flex-col', marquee && 'select-none')}
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
                            : 'Empty Trash'}
                    </Button>
                )}
            </PageHeader>
            {(batch || emptying) && (
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
            {trash.isPending && <SkeletonRows />}
            {trash.isError && (
                <EmptyState
                    icon={TriangleAlertIcon}
                    tone="danger"
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
                    icon={Trash2Icon}
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
                                <span className="flex items-center gap-4">
                                    <span className="w-10 shrink-0" />
                                    Name
                                </span>
                            </th>
                            <th scope="col" className="hidden w-[22%] text-left md:table-cell">
                                Was in
                            </th>
                            <th scope="col" className="hidden w-36 text-left sm:table-cell">
                                Trashed
                            </th>
                            <th scope="col" className="hidden w-24 pr-2 text-right lg:table-cell">
                                Size
                            </th>
                            <th scope="col" className="w-28 pr-3 sm:w-64 sm:pr-5">
                                <span className="sr-only">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((item) => {
                            const isSelected = selected.has(item.node.id);
                            const parent = item.ancestors.at(-1);
                            const location = item.ancestors.map(folderName).join(' › ');
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
                                            <span className="grid min-w-0 grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-4 pl-5 sm:pl-8">
                                                <span
                                                    className={cn(
                                                        'row-span-2',
                                                        !rowFailed && 'md:row-span-1',
                                                    )}
                                                >
                                                    <SelectableMark
                                                        name={item.node.name}
                                                        checked={isSelected}
                                                        revealed={coarse && picked.length > 0}
                                                        onToggle={() => toggle(item.node.id)}
                                                    >
                                                        <FileMark node={item.node} size="list" />
                                                    </SelectableMark>
                                                </span>
                                                <span className="truncate text-[15px] font-medium">
                                                    {item.node.name}
                                                </span>
                                                {rowFailed ? (
                                                    <span className="col-start-2 truncate text-[13px] font-semibold text-destructive">
                                                        Couldn’t be restored
                                                    </span>
                                                ) : (
                                                    // Where it was, on screens with no room for the column.
                                                    <span className="truncate text-[13px] text-muted-foreground md:hidden">
                                                        Was in {folderName(parent)}
                                                        {item.parentTrashed &&
                                                            ', also in the Trash'}
                                                    </span>
                                                )}
                                            </span>
                                        </td>
                                        <td className="hidden min-w-0 pr-4 text-[13px] md:table-cell">
                                            <span
                                                className="flex min-w-0 flex-col"
                                                title={location}
                                            >
                                                {item.parentTrashed || !parent ? (
                                                    <span className="truncate font-semibold">
                                                        {folderName(parent)}
                                                    </span>
                                                ) : (
                                                    <Link
                                                        {...(parent.id === rootId
                                                            ? ({ to: '/app/drive' } as const)
                                                            : ({
                                                                  to: '/app/drive/f/$folderId',
                                                                  params: { folderId: parent.id },
                                                              } as const))}
                                                        className="truncate font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                                                    >
                                                        {folderName(parent)}
                                                    </Link>
                                                )}
                                                {item.parentTrashed && (
                                                    <span className="text-muted-foreground">
                                                        Also in the Trash
                                                    </span>
                                                )}
                                            </span>
                                        </td>
                                        <td className="hidden text-[13px] text-muted-foreground tabular-nums sm:table-cell">
                                            {formatWhen(item.node.trashedAt)}
                                        </td>
                                        <td className="hidden pr-2 text-right text-[13px] text-muted-foreground tabular-nums lg:table-cell">
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
                                                    <span className="max-sm:sr-only">
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
                                                        size="sm"
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
                                                        <span className="max-sm:sr-only">
                                                            {item.parentTrashed
                                                                ? 'Restore to My files'
                                                                : 'Restore'}
                                                        </span>
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="icon-sm"
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

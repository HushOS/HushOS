import type { DriveNode, TrashItem } from '@hushos/drive/client';
import { useHotkey } from '@tanstack/react-hotkeys';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { type MouseEvent, type PointerEvent, useRef, useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { useDrive } from '@/components/drive/drive-shell';
import { FileMark } from '@/components/drive/file-mark';
import { useCoarsePointer } from '@/components/drive/folder-view';
import { PendingLabel, Spinner } from '@/components/motion';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
    driveClient,
    driveError,
    folderQueryOptions,
    formatWhen,
    invalidateFolders,
    trashQueryOptions,
} from '@/lib/drive';
import { cue } from '@/lib/sounds';
import { emptyTrashAll } from '@/lib/trash';

/*
 * Everything with its own trashed_at, newest first. Restore puts it back where it
 * was; when that place is itself in the trash, it goes to the top folder instead,
 * which is a move and a restore in one request. Rows can be picked and restored or
 * deleted together; each leaves the list as its own request finishes.
 */

/* Whether an ancestor of `item` is among `ids`: its fate then follows that ancestor's. */
function underAny(item: TrashItem, ids: Set<string>) {
    return item.ancestors.some((ancestor) => ids.has(ancestor.id));
}
export function TrashView() {
    const { rootId, userId } = useDrive();
    const queryClient = useQueryClient();
    const trash = useQuery(trashQueryOptions);
    const root = useQuery(folderQueryOptions(rootId));
    const [busy, setBusy] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<TrashItem | 'all' | null>(null);
    const [emptying, setEmptying] = useState<number | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [confirmingMany, setConfirmingMany] = useState(false);
    /* A batch under way: what it is doing, and how far. */
    const [batch, setBatch] = useState<{
        verb: 'Restoring' | 'Deleting';
        done: number;
        total: number;
    } | null>(null);
    const rows = trash.data ?? [];
    // Only rows still in the trash count: one restored or deleted elsewhere drops out of the selection.
    const picked = rows.filter((item) => selected.has(item.node.id));
    const allPicked = rows.length > 0 && picked.length === rows.length;

    function toggle(id: string) {
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    /* Where a Shift range starts, and the row the arrows move from: as in Files. */
    const [anchor, setAnchor] = useState<string | null>(null);
    const [focused, setFocused] = useState<string | null>(null);
    const coarsePointer = useCoarsePointer();
    const tableRef = useRef<HTMLTableElement>(null);

    /*
     * A click on a row, as Files takes it: alone it picks that row, with Mod it adds or
     * removes it, with Shift it stretches from the last one picked; on a touch screen a
     * tap adds or removes, since there is no modifier to hold.
     */
    function select(
        id: string,
        event?: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean },
    ) {
        setFocused(id);
        if (event?.shiftKey && anchor !== null) {
            const from = rows.findIndex((item) => item.node.id === anchor);
            const to = rows.findIndex((item) => item.node.id === id);
            if (from !== -1 && to !== -1) {
                const [start, end] = from < to ? [from, to] : [to, from];
                setSelected(new Set(rows.slice(start, end + 1).map((item) => item.node.id)));
                return;
            }
        }
        setAnchor(id);
        if (coarsePointer || event?.metaKey || event?.ctrlKey) toggle(id);
        else setSelected(new Set([id]));
    }

    /*
     * Dragging down or up the list from a row picks every row it passes, as a file
     * list does; a press that never leaves its row stays a click.
     */
    const dragFrom = useRef<string | null>(null);
    function onRowPointerDown(event: PointerEvent, id: string) {
        if (event.pointerType !== 'mouse' || event.button !== 0) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey) return;
        if (
            event.target instanceof Element &&
            event.target.closest('button, a, input, [role=checkbox]')
        )
            return;
        if (batch || busy) return;
        dragFrom.current = id;
        const end = () => {
            dragFrom.current = null;
            window.removeEventListener('pointerup', end);
        };
        window.addEventListener('pointerup', end);
    }
    function onRowPointerEnter(event: PointerEvent, id: string) {
        const from = dragFrom.current;
        if (from === null || (event.buttons & 1) === 0) return;
        const start = rows.findIndex((item) => item.node.id === from);
        const at = rows.findIndex((item) => item.node.id === id);
        if (start === -1 || at === -1) return;
        const [low, high] = start < at ? [start, at] : [at, start];
        setAnchor(from);
        setFocused(id);
        setSelected(new Set(rows.slice(low, high + 1).map((item) => item.node.id)));
    }

    function onRowClick(event: MouseEvent, id: string) {
        // The row's own buttons and its checkbox do their own thing.
        if (
            event.target instanceof Element &&
            event.target.closest('button, a, input, [role=checkbox]')
        )
            return;
        if (batch || busy) return;
        select(id, event);
    }

    /* Arrows move the one selected row; with Shift they stretch the selection, as in Files. */
    function moveFocus(delta: number, extend = false) {
        if (!rows.length) return;
        const index = focused ? rows.findIndex((item) => item.node.id === focused) : -1;
        const next = rows[Math.min(rows.length - 1, Math.max(0, index + delta))]!;
        select(next.node.id, extend ? { shiftKey: true } : undefined);
        tableRef.current
            ?.querySelector(`[data-trash-id="${next.node.id}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }

    // Keys work while nothing else has them: no dialog open, nothing under way.
    const keys = confirming === null && !confirmingMany && batch === null && busy === null;
    useHotkey('ArrowDown', () => moveFocus(1), { enabled: keys });
    useHotkey('ArrowUp', () => moveFocus(-1), { enabled: keys });
    useHotkey('Shift+ArrowDown', () => moveFocus(1, true), { enabled: keys });
    useHotkey('Shift+ArrowUp', () => moveFocus(-1, true), { enabled: keys });
    useHotkey('Mod+A', () => setSelected(new Set(rows.map((item) => item.node.id))), {
        enabled: keys,
        ignoreInputs: true,
    });
    useHotkey(
        'Escape',
        () => {
            setSelected(new Set());
            setFocused(null);
        },
        { enabled: keys },
    );
    // In the trash the delete key deletes forever, so it always asks first.
    useHotkey('Backspace', () => picked.length > 0 && setConfirmingMany(true), { enabled: keys });
    useHotkey('Delete', () => picked.length > 0 && setConfirmingMany(true), { enabled: keys });

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
     * batch goes home, one whose ancestor is still in the trash goes to the top folder.
     */
    async function restoreMany(items: TrashItem[]) {
        if (busy || batch) return;
        const ordered = [...items].sort((a, b) => a.ancestors.length - b.ancestors.length);
        const back = new Set<string>();
        let failed = 0;
        let toTop = 0;
        setBatch({ verb: 'Restoring', done: 0, total: ordered.length });
        for (const [index, item] of ordered.entries()) {
            const trashedAbove = item.ancestors.filter((ancestor) => ancestor.trashedAt);
            const home = trashedAbove.every((ancestor) => back.has(ancestor.id));
            try {
                const target = home ? undefined : root.data?.folder;
                if (!home && !target) throw new Error('The top folder is not open yet.');
                await driveClient.restore(item.node, target);
                back.add(item.node.id);
                if (!home) toTop++;
                drop(item.node.id);
            } catch {
                failed++;
            }
            setBatch({ verb: 'Restoring', done: index + 1, total: ordered.length });
        }
        setBatch(null);
        await invalidateFolders(queryClient);
        const restored = ordered.length - failed;
        cue(failed ? 'error' : 'success');
        toast.add({
            type: failed ? 'error' : 'success',
            title: failed
                ? `Restored ${restored} of ${ordered.length}; ${failed} could not be restored`
                : restored === 1
                  ? '1 item restored'
                  : `${restored} items restored`,
            description: toTop
                ? `${toTop === 1 ? 'One went' : `${toTop} went`} to the top folder: ${toTop === 1 ? 'its folder is' : 'their folders are'} still in the trash.`
                : undefined,
        });
    }

    /* Deletes the picked rows forever; anything inside a picked folder goes with it, so it is not asked for twice. */
    async function purgeMany(items: TrashItem[]) {
        if (busy || batch) return;
        const ids = new Set(items.map((item) => item.node.id));
        const tops = items.filter((item) => !underAny(item, ids));
        let failed = 0;
        setBatch({ verb: 'Deleting', done: 0, total: tops.length });
        for (const [index, item] of tops.entries()) {
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
        setBatch(null);
        await invalidateFolders(queryClient);
        cue(failed ? 'error' : 'droplet');
        toast.add({
            type: failed ? 'error' : 'success',
            title: failed
                ? `${failed} of ${tops.length} could not be deleted`
                : items.length === 1
                  ? '1 item deleted forever'
                  : `${items.length} items deleted forever`,
            description: failed ? undefined : 'Their storage is released as the deletion finishes.',
        });
    }

    // Enter acts on the selection as it opens in Files: here that is bringing it back.
    useHotkey(
        'Enter',
        (event) => {
            if (event.target instanceof Element && event.target.closest('a, button')) return;
            if (picked.length > 0) void restoreMany(picked);
        },
        { enabled: keys, preventDefault: false },
    );

    /* Delete forever: the server purges the node now; anything inside follows in the background. */
    async function purge(item: TrashItem) {
        if (busy) return;
        setBusy(item.node.id);
        try {
            await driveClient.purge(item.node);
            cue('droplet');
            toast.add({
                type: 'success',
                title: `“${item.node.name}” deleted forever`,
                description: 'Its storage is released as the deletion finishes.',
            });
        } catch (error) {
            cue('error');
            toast.add({ type: 'error', title: 'Could not delete', description: driveError(error) });
        } finally {
            setBusy(null);
            await invalidateFolders(queryClient);
        }
    }

    /* Empties the trash a batch at a time until the server reports nothing left. */
    async function emptyAll() {
        if (busy) return;
        setBusy('all');
        setEmptying(0);
        let purged = 0;
        try {
            purged = await emptyTrashAll(queryClient, userId, setEmptying);
            cue('droplet');
            toast.add({
                type: 'success',
                title: purged === 1 ? 'Trash emptied: 1 item' : `Trash emptied: ${purged} items`,
            });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not empty the trash',
                description: driveError(error),
            });
        } finally {
            setBusy(null);
            setEmptying(null);
            await invalidateFolders(queryClient);
        }
    }

    async function restore(item: TrashItem) {
        if (busy) return;
        setBusy(item.node.id);
        try {
            const target: DriveNode | undefined = item.parentTrashed
                ? root.data?.folder
                : undefined;
            if (item.parentTrashed && !target) throw new Error('The top folder is not open yet.');
            const restored = await driveClient.restore(item.node, target);
            cue('success');
            toast.add({
                type: 'success',
                title: `“${item.node.name}” restored`,
                description: item.parentTrashed
                    ? 'Its folder is still in the trash, so it went to the top folder.'
                    : undefined,
            });
            await invalidateFolders(queryClient, restored.parentId, item.node.parentId);
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not restore',
                description: driveError(error),
            });
            await invalidateFolders(queryClient);
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="flex flex-col">
            <PageHeader
                eyebrow="Drive"
                title="Trash"
                description="Items stay here for 30 days and count against your storage. Deleting forever cannot be undone."
            >
                {picked.length > 0 || batch ? (
                    <div
                        role="toolbar"
                        aria-label="Selection"
                        className="flex h-9 items-center gap-1 rounded-md bg-accent px-2 text-accent-foreground"
                    >
                        <span className="mr-1 pl-1 text-sm font-medium tabular-nums">
                            {batch
                                ? `${batch.verb} ${batch.done} of ${batch.total}`
                                : `${picked.length} selected`}
                        </span>
                        {batch ? (
                            <Spinner />
                        ) : (
                            <>
                                <Button
                                    variant="ghost"
                                    size="xs"
                                    onClick={() => void restoreMany(picked)}
                                >
                                    <RotateCcwIcon />
                                    Restore
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="xs"
                                    onClick={() => setConfirmingMany(true)}
                                >
                                    <Trash2Icon />
                                    Delete forever
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="xs"
                                    onClick={() => setSelected(new Set())}
                                >
                                    Clear
                                </Button>
                            </>
                        )}
                    </div>
                ) : (
                    trash.data &&
                    trash.data.length > 0 && (
                        <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() => setConfirming('all')}
                        >
                            <Trash2Icon />
                            <PendingLabel
                                pending={emptying !== null}
                                idle="Empty trash"
                                busy={emptying ? `Emptying · ${emptying}` : 'Emptying'}
                            />
                        </Button>
                    )
                )}
            </PageHeader>
            {trash.isPending && (
                <div className="flex items-center justify-center py-24 text-muted-foreground">
                    <Spinner />
                </div>
            )}
            {trash.isError && (
                <div className="px-5 py-6 sm:px-8">
                    <Alert variant="destructive" className="max-w-xl">
                        <AlertTitle>The trash could not be opened</AlertTitle>
                        <AlertDescription>{driveError(trash.error)}</AlertDescription>
                    </Alert>
                </div>
            )}
            {trash.data && trash.data.length === 0 && (
                <p className="px-5 py-12 text-sm text-muted-foreground sm:px-8">
                    The trash is empty.
                </p>
            )}
            {trash.data && trash.data.length > 0 && (
                <table
                    ref={tableRef}
                    aria-label="Trash"
                    aria-multiselectable="true"
                    className="w-full table-fixed border-collapse select-none"
                >
                    <thead>
                        <tr className="border-b border-rule">
                            <th scope="col" className="w-10 py-2.5 pl-5 sm:w-13 sm:pl-8">
                                <Checkbox
                                    aria-label={
                                        allPicked
                                            ? 'Clear the selection'
                                            : 'Select everything in the trash'
                                    }
                                    checked={allPicked}
                                    indeterminate={picked.length > 0 && !allPicked}
                                    disabled={batch !== null || busy !== null}
                                    onCheckedChange={() =>
                                        setSelected(
                                            allPicked
                                                ? new Set()
                                                : new Set(rows.map((item) => item.node.id)),
                                        )
                                    }
                                />
                            </th>
                            <th
                                scope="col"
                                className="eyebrow py-2.5 pl-2 text-left text-muted-foreground"
                            >
                                Name
                            </th>
                            <th
                                scope="col"
                                className="eyebrow hidden py-2.5 text-left text-muted-foreground sm:table-cell"
                            >
                                Was in
                            </th>
                            <th
                                scope="col"
                                className="eyebrow hidden w-40 py-2.5 text-left text-muted-foreground sm:table-cell"
                            >
                                Trashed
                            </th>
                            <th scope="col" className="w-44 pr-5 sm:w-64 sm:pr-8">
                                <span className="sr-only">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {trash.data.map((item) => {
                            const location = item.ancestors
                                .map((ancestor) => ancestor.name)
                                .join(' › ');
                            return (
                                <tr
                                    key={item.node.id}
                                    data-trash-id={item.node.id}
                                    aria-selected={selected.has(item.node.id)}
                                    onClick={(event) => onRowClick(event, item.node.id)}
                                    onPointerDown={(event) => onRowPointerDown(event, item.node.id)}
                                    onPointerEnter={(event) =>
                                        onRowPointerEnter(event, item.node.id)
                                    }
                                    className="h-[46px] border-b border-rule hover:bg-muted aria-selected:bg-accent/60"
                                >
                                    <td className="py-2 pl-5 sm:pl-8">
                                        <Checkbox
                                            aria-label={`Select “${item.node.name}”`}
                                            checked={selected.has(item.node.id)}
                                            disabled={batch !== null || busy !== null}
                                            onCheckedChange={() => {
                                                // The box always adds or removes, whatever the pointer.
                                                setAnchor(item.node.id);
                                                setFocused(item.node.id);
                                                toggle(item.node.id);
                                            }}
                                        />
                                    </td>
                                    <td className="py-2 pl-2">
                                        <div className="flex min-w-0 items-center gap-3 text-sm font-medium">
                                            <FileMark node={item.node} />
                                            <span className="truncate">{item.node.name}</span>
                                        </div>
                                    </td>
                                    <td className="hidden truncate py-2 pr-4 text-sm text-muted-foreground sm:table-cell">
                                        {location}
                                        {item.parentTrashed && ' (also in trash)'}
                                    </td>
                                    <td className="hidden py-2 text-sm text-muted-foreground tabular-nums sm:table-cell">
                                        {formatWhen(item.node.trashedAt)}
                                    </td>
                                    <td className="py-1.5 pr-5 text-right sm:pr-8">
                                        <div className="flex justify-end gap-1.5">
                                            <Button
                                                variant="outline"
                                                size="xs"
                                                disabled={busy !== null || batch !== null}
                                                onClick={() => void restore(item)}
                                            >
                                                <RotateCcwIcon />
                                                <PendingLabel
                                                    pending={busy === item.node.id}
                                                    idle={
                                                        item.parentTrashed
                                                            ? 'Restore to top'
                                                            : 'Restore'
                                                    }
                                                    busy="Restoring"
                                                />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="xs"
                                                aria-label={`Delete “${item.node.name}” forever`}
                                                disabled={busy !== null || batch !== null}
                                                onClick={() => setConfirming(item)}
                                            >
                                                <Trash2Icon />
                                                <span className="max-sm:sr-only">
                                                    Delete forever
                                                </span>
                                            </Button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            <AlertDialog
                open={confirming !== null}
                onOpenChange={(open) => !open && setConfirming(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {confirming === 'all'
                                ? 'Empty the trash?'
                                : `Delete “${confirming?.node.name ?? ''}” forever?`}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {confirming === 'all'
                                ? 'Everything in the trash is deleted permanently, including everything inside trashed folders. This cannot be undone.'
                                : confirming?.node.kind === 'folder'
                                  ? 'The folder and everything inside it are deleted permanently. This cannot be undone.'
                                  : 'The file and its earlier version are deleted permanently. This cannot be undone.'}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                const target = confirming;
                                setConfirming(null);
                                if (target === 'all') void emptyAll();
                                else if (target) void purge(target);
                            }}
                        >
                            <Trash2Icon />
                            {confirming === 'all' ? 'Empty trash' : 'Delete forever'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            <AlertDialog open={confirmingMany} onOpenChange={setConfirmingMany}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {picked.length === 1
                                ? `Delete “${picked[0]?.node.name ?? ''}” forever?`
                                : `Delete ${picked.length} items forever?`}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {picked.some((item) => item.node.kind === 'folder')
                                ? 'They are deleted permanently, including everything inside the folders. This cannot be undone.'
                                : 'They are deleted permanently, with their earlier versions. This cannot be undone.'}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                setConfirmingMany(false);
                                void purgeMany(picked);
                            }}
                        >
                            <Trash2Icon />
                            Delete forever
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

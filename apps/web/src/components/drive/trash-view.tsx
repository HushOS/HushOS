import type { DriveNode, TrashItem } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileIcon, FolderIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { useDrive } from '@/components/drive/drive-shell';
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
 * which is a move and a restore in one request.
 */
export function TrashView() {
    const { rootId, userId } = useDrive();
    const queryClient = useQueryClient();
    const trash = useQuery(trashQueryOptions);
    const root = useQuery(folderQueryOptions(rootId));
    const [busy, setBusy] = useState<string | null>(null);
    const [confirming, setConfirming] = useState<TrashItem | 'all' | null>(null);
    const [emptying, setEmptying] = useState<number | null>(null);

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
                {trash.data && trash.data.length > 0 && (
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
                <table aria-label="Trash" className="w-full table-fixed border-collapse">
                    <thead>
                        <tr className="border-b">
                            <th
                                scope="col"
                                className="eyebrow py-2.5 pl-5 text-left font-medium text-muted-foreground sm:pl-8"
                            >
                                Name
                            </th>
                            <th
                                scope="col"
                                className="eyebrow hidden py-2.5 text-left font-medium text-muted-foreground sm:table-cell"
                            >
                                Was in
                            </th>
                            <th
                                scope="col"
                                className="eyebrow hidden w-32 py-2.5 text-left font-medium text-muted-foreground sm:table-cell"
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
                            const Icon = item.node.kind === 'folder' ? FolderIcon : FileIcon;
                            const location = item.ancestors
                                .map((ancestor) => ancestor.name)
                                .join(' › ');
                            return (
                                <tr key={item.node.id} className="border-b">
                                    <td className="py-2.5 pl-5 sm:pl-8">
                                        <div className="flex min-w-0 items-center gap-3 text-sm">
                                            <Icon
                                                aria-hidden="true"
                                                className={`size-4 shrink-0 ${item.node.kind === 'folder' ? 'text-primary' : 'text-muted-foreground'}`}
                                            />
                                            <span className="truncate">{item.node.name}</span>
                                        </div>
                                    </td>
                                    <td className="hidden truncate py-2.5 pr-4 font-mono text-xs text-muted-foreground sm:table-cell">
                                        {location}
                                        {item.parentTrashed && ' (also in trash)'}
                                    </td>
                                    <td className="hidden py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">
                                        {formatWhen(item.node.trashedAt)}
                                    </td>
                                    <td className="py-1.5 pr-5 text-right sm:pr-8">
                                        <div className="flex justify-end gap-1.5">
                                            <Button
                                                variant="outline"
                                                size="xs"
                                                disabled={busy !== null}
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
                                                disabled={busy !== null}
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
        </div>
    );
}

import type { DriveNode } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRightIcon, FolderIcon } from 'lucide-react';
import { useState } from 'react';
import { PendingLabel, Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    copyInto,
    driveClient,
    driveError,
    folderQueryOptions,
    invalidateFolders,
    sortNodes,
} from '@/lib/drive';
import { cue } from '@/lib/sounds';

/*
 * A folder picker that browses from the root, for moving or copying. A move
 * offers neither the item itself nor its current folder; the server refuses a
 * move into a descendant anyway, and reports it as a cycle if a person gets
 * there. A copy may land in the same folder, under a "(copy)" name.
 */
export function MoveDialog({
    nodes,
    rootId,
    mode = 'move',
    open,
    onOpenChange,
}: {
    nodes: DriveNode[];
    rootId: string;
    mode?: 'move' | 'copy';
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                <MovePicker nodes={nodes} rootId={rootId} mode={mode} onOpenChange={onOpenChange} />
            </DialogContent>
        </Dialog>
    );
}

function MovePicker({
    nodes,
    rootId,
    mode,
    onOpenChange,
}: {
    nodes: DriveNode[];
    rootId: string;
    mode: 'move' | 'copy';
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const [folderId, setFolderId] = useState(rootId);
    const [pending, setPending] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState('');
    const listing = useQuery(folderQueryOptions(folderId));
    const moving = new Set(nodes.map((node) => node.id));
    const currentParent = nodes[0]?.parentId ?? null;
    const sameParent = nodes.every((node) => node.parentId === currentParent);
    const destination = listing.data?.folder;
    const disabled =
        !destination ||
        moving.has(destination.id) ||
        (mode === 'move' && sameParent && destination.id === currentParent);

    async function submit() {
        if (!destination) return;
        setPending(true);
        setProgress(0);
        setError('');
        try {
            if (mode === 'copy') await copyInto(queryClient, nodes, destination, setProgress);
            else {
                for (const node of nodes) await driveClient.move(node, destination);
                await invalidateFolders(queryClient, currentParent, destination.id);
            }
            cue('success');
            onOpenChange(false);
        } catch (error) {
            cue('error');
            setError(driveError(error));
            await invalidateFolders(queryClient, currentParent, destination.id);
        } finally {
            setPending(false);
        }
    }

    const verb = mode === 'copy' ? 'Copy' : 'Move';
    const label = nodes.length === 1 ? `“${nodes[0]!.name}”` : `${nodes.length} items`;
    return (
        <>
            <DialogHeader>
                <DialogTitle>
                    {verb} {label}
                </DialogTitle>
                <DialogDescription>
                    {mode === 'copy'
                        ? 'Choose a folder. A copy shares the stored bytes with the original but counts against your storage on its own.'
                        : 'Choose a folder. Moving rewraps one key; nothing is re-uploaded.'}
                </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col border bg-card">
                <nav
                    aria-label="Location"
                    className="flex min-h-10 flex-wrap items-center gap-1 border-b px-2 font-mono text-xs"
                >
                    {listing.data ? (
                        [...listing.data.ancestors, listing.data.folder].map(
                            (crumb, index, all) => (
                                <span key={crumb.id} className="flex items-center gap-1">
                                    {index > 0 && (
                                        <ChevronRightIcon className="size-3 text-muted-foreground/60" />
                                    )}
                                    <button
                                        type="button"
                                        className={`max-w-48 truncate px-1 py-0.5 hover:bg-muted ${index === all.length - 1 ? 'text-foreground' : 'text-muted-foreground'}`}
                                        onClick={() => setFolderId(crumb.id)}
                                    >
                                        {crumb.name}
                                    </button>
                                </span>
                            ),
                        )
                    ) : (
                        <span className="px-1 text-muted-foreground">…</span>
                    )}
                </nav>
                <div className="max-h-72 overflow-y-auto">
                    {listing.isPending && (
                        <div className="flex h-24 items-center justify-center text-muted-foreground">
                            <Spinner />
                        </div>
                    )}
                    {listing.isError && (
                        <p className="px-3 py-4 font-mono text-xs text-destructive">
                            {driveError(listing.error)}
                        </p>
                    )}
                    {listing.data &&
                        (() => {
                            const folders = sortNodes(listing.data.children).filter(
                                (child) => child.kind === 'folder',
                            );
                            if (!folders.length)
                                return (
                                    <p className="px-3 py-4 font-mono text-xs text-muted-foreground">
                                        No folders here.
                                    </p>
                                );
                            return (
                                <ul>
                                    {folders.map((folder) => {
                                        const blocked = moving.has(folder.id);
                                        return (
                                            <li key={folder.id}>
                                                <button
                                                    type="button"
                                                    disabled={blocked}
                                                    onClick={() => setFolderId(folder.id)}
                                                    className="flex h-10 w-full items-center gap-2.5 px-3 text-left text-sm hover:bg-muted disabled:opacity-40"
                                                >
                                                    <FolderIcon className="size-4 text-primary" />
                                                    <span className="truncate">{folder.name}</span>
                                                    <ChevronRightIcon className="ml-auto size-3.5 text-muted-foreground/60" />
                                                </button>
                                            </li>
                                        );
                                    })}
                                </ul>
                            );
                        })()}
                </div>
            </div>
            {error && (
                <p role="alert" className="font-mono text-[11px] text-destructive">
                    {error}
                </p>
            )}
            <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                    Cancel
                </Button>
                <Button onClick={() => void submit()} disabled={pending || disabled}>
                    <PendingLabel
                        pending={pending}
                        idle={
                            !destination
                                ? verb
                                : destination.parentId === null
                                  ? `${verb} to top folder`
                                  : `${verb} to “${destination.name}”`
                        }
                        busy={
                            mode === 'copy'
                                ? progress > 0
                                    ? `Copying (${progress})`
                                    : 'Copying'
                                : 'Moving'
                        }
                    />
                </Button>
            </DialogFooter>
        </>
    );
}

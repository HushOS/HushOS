import type { DriveNode } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { FileMark } from '@/components/drive/file-mark';
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
            <DialogContent className="sm:max-w-[520px]">
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
    const placeName = (folder: DriveNode) => (folder.parentId === null ? 'My files' : folder.name);
    const already = mode === 'move' && sameParent && destination?.id === currentParent;
    const trail = listing.data ? [...listing.data.ancestors, listing.data.folder] : [];
    return (
        <>
            <DialogHeader>
                <DialogTitle>
                    {verb} {label}
                </DialogTitle>
                <DialogDescription render={<nav aria-label="Location" />}>
                    <span className="flex flex-wrap items-center gap-1">
                        {trail.length === 0 && '…'}
                        {trail.map((crumb, index) => (
                            <span key={crumb.id} className="flex items-center gap-1">
                                {index > 0 && (
                                    <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                                )}
                                {index === trail.length - 1 ? (
                                    <span
                                        aria-current="location"
                                        className="font-semibold text-foreground"
                                    >
                                        {placeName(crumb)}
                                    </span>
                                ) : (
                                    <button
                                        type="button"
                                        className="cursor-pointer font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                                        onClick={() => setFolderId(crumb.id)}
                                    >
                                        {placeName(crumb)}
                                    </button>
                                )}
                            </span>
                        ))}
                    </span>
                </DialogDescription>
            </DialogHeader>
            <div className="flex h-[260px] flex-col overflow-y-auto rounded-xl border border-rule">
                {listing.isPending && (
                    <div className="m-auto text-muted-foreground">
                        <Spinner />
                    </div>
                )}
                {listing.isError && (
                    <p className="m-auto px-4 text-center text-sm text-destructive">
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
                                <p className="m-auto text-sm text-muted-foreground">
                                    No folders in here.
                                </p>
                            );
                        return folders.map((folder) => {
                            const blocked = moving.has(folder.id);
                            return (
                                <button
                                    key={folder.id}
                                    type="button"
                                    disabled={blocked}
                                    title={
                                        blocked
                                            ? `${verb === 'Move' ? 'Moving' : 'Copying'} this one`
                                            : undefined
                                    }
                                    onClick={() => setFolderId(folder.id)}
                                    className="flex h-14 w-full shrink-0 cursor-pointer items-center gap-3 border-b border-rule px-3 text-left last:border-0 hover:bg-muted disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
                                >
                                    <FileMark kind="folder" name={folder.name} />
                                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                                        {folder.name}
                                    </span>
                                    <ChevronRightIcon
                                        className="size-4 shrink-0 text-muted-foreground"
                                        aria-hidden="true"
                                    />
                                </button>
                            );
                        });
                    })()}
            </div>
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            )}
            <DialogFooter>
                {mode === 'copy' && (
                    <p className="mr-auto text-[13px] text-muted-foreground max-sm:order-last">
                        Copies count towards your storage.
                    </p>
                )}
                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                    Cancel
                </Button>
                <Button onClick={() => void submit()} disabled={pending || disabled}>
                    <PendingLabel
                        pending={pending}
                        idle={already ? 'Already here' : `${verb} here`}
                        busy={
                            mode === 'copy'
                                ? progress > 0
                                    ? `Copying… ${progress}`
                                    : 'Copying…'
                                : 'Moving…'
                        }
                    />
                </Button>
            </DialogFooter>
        </>
    );
}

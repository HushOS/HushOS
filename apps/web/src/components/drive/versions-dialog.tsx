import type { DriveNode } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { PendingLabel, Spinner } from '@/components/motion';
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
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { downloadNodes } from '@/lib/downloads';
import {
    driveClient,
    driveError,
    driveKeys,
    formatBytes,
    formatWhen,
    invalidateFolders,
} from '@/lib/drive';
import { cue } from '@/lib/sounds';

/*
 * A file's versions: the current one and the one it displaced. The earlier
 * version can be downloaded as it was, restored (the two swap, nothing is
 * purged) or discarded now rather than after 30 days.
 */
export function VersionsDialog({
    node,
    open,
    onOpenChange,
}: {
    node: DriveNode | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-lg">
                {node && <VersionList node={node} onOpenChange={onOpenChange} />}
            </DialogContent>
        </Dialog>
    );
}

function VersionList({
    node,
    onOpenChange,
}: {
    node: DriveNode;
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const [pending, setPending] = useState<'restore' | 'discard' | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const versions = useQuery({
        queryKey: [...driveKeys.all, 'versions', node.id],
        queryFn: () => driveClient.versions(node),
        staleTime: 0,
    });

    async function refresh() {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: [...driveKeys.all, 'versions', node.id] }),
            invalidateFolders(queryClient, node.parentId),
        ]);
    }
    async function restore(versionId: string) {
        setPending('restore');
        try {
            await driveClient.restoreVersion(node, versionId);
            cue('success');
            toast.add({
                type: 'success',
                title: `Earlier version of “${node.name}” restored`,
                description: 'The version it replaced is kept as the earlier version.',
            });
            onOpenChange(false);
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not restore',
                description: driveError(error),
            });
        } finally {
            setPending(null);
            await refresh();
        }
    }
    async function discard(versionId: string) {
        setPending('discard');
        try {
            await driveClient.discardVersion(node, versionId);
            cue('droplet');
            toast.add({ type: 'success', title: `Earlier version of “${node.name}” deleted` });
        } catch (error) {
            cue('error');
            toast.add({ type: 'error', title: 'Could not delete', description: driveError(error) });
        } finally {
            setPending(null);
            await refresh();
        }
    }

    return (
        <>
            <DialogHeader>
                <DialogTitle>Versions of “{node.name}”</DialogTitle>
                <DialogDescription>
                    A file keeps its current version and the one it replaced. The earlier version
                    counts against your storage until it is deleted, after 30 days or now.
                </DialogDescription>
            </DialogHeader>
            <div className="border-y border-rule">
                {versions.isPending && (
                    <div className="flex h-24 items-center justify-center text-muted-foreground">
                        <Spinner />
                    </div>
                )}
                {versions.isError && (
                    <p className="py-4 text-sm text-destructive">{driveError(versions.error)}</p>
                )}
                {versions.data && (
                    <ul className="divide-y divide-rule">
                        {versions.data.map((version) => (
                            <li
                                key={version.id}
                                className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3"
                            >
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-semibold">
                                        {version.current ? 'Current version' : 'Earlier version'}
                                    </p>
                                    <p className="text-xs text-muted-foreground tabular-nums">
                                        {version.content
                                            ? formatBytes(version.content.plaintextSize)
                                            : 'Size unavailable'}{' '}
                                        · {formatWhen(version.readyAt ?? version.createdAt)}
                                        {version.objectStatus === 'missing' && ' · unavailable'}
                                    </p>
                                </div>
                                <div className="flex items-center gap-1">
                                    <Button
                                        variant="ghost"
                                        size="xs"
                                        aria-label={`Download ${version.current ? 'current' : 'earlier'} version`}
                                        disabled={version.objectStatus !== 'ready'}
                                        onClick={() =>
                                            void downloadNodes([
                                                { ...node, currentVersion: version },
                                            ])
                                        }
                                    >
                                        <DownloadIcon />
                                        <span className="max-sm:sr-only">Download</span>
                                    </Button>
                                    {!version.current && (
                                        <>
                                            <Button
                                                variant="ghost"
                                                size="xs"
                                                aria-label="Restore earlier version"
                                                disabled={
                                                    pending !== null ||
                                                    version.objectStatus !== 'ready'
                                                }
                                                onClick={() => void restore(version.id)}
                                            >
                                                <RotateCcwIcon />
                                                <PendingLabel
                                                    pending={pending === 'restore'}
                                                    idle="Restore"
                                                    busy="Restoring"
                                                />
                                            </Button>
                                            <Button
                                                variant="ghost"
                                                size="xs"
                                                aria-label="Delete earlier version"
                                                disabled={pending !== null}
                                                onClick={() => setConfirming(version.id)}
                                            >
                                                <Trash2Icon />
                                                <span className="max-sm:sr-only">Delete</span>
                                            </Button>
                                        </>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
            <AlertDialog
                open={confirming !== null}
                onOpenChange={(open) => !open && setConfirming(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete the earlier version?</AlertDialogTitle>
                        <AlertDialogDescription>
                            The earlier version of “{node.name}” is deleted permanently and its
                            space is freed. The current version is not touched. This cannot be
                            undone.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            onClick={() => {
                                const target = confirming;
                                setConfirming(null);
                                if (target) void discard(target);
                            }}
                        >
                            <Trash2Icon />
                            Delete version
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

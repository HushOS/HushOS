import type { DriveNode } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DownloadIcon, EyeIcon, RotateCcwIcon, Trash2Icon } from 'lucide-react';
import { useState } from 'react';
import { FileMark } from '@/components/drive/file-mark';
import { Preview } from '@/components/drive/preview';
import { Spinner } from '@/components/motion';
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
    DialogFooter,
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
    formatDay,
    formatTime,
    formatWhen,
    invalidateFolders,
} from '@/lib/drive';
import { cue } from '@/lib/sounds';

/* "at 14:08" for today, "on 3 Sept" before. */
const replacedWhen = (iso: string) =>
    new Date(iso).toDateString() === new Date().toDateString()
        ? `at ${formatTime(iso)}`
        : `on ${formatDay(iso)}`;

/*
 * A file's versions: the current one and the one it displaced. The earlier
 * version can be opened in the viewer, downloaded as it was, restored (the two
 * swap, nothing is purged) or discarded now rather than after 30 days.
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
            <DialogContent className="sm:max-w-[600px]">
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
    // Read once when the dialog opens: "deleted in N days" doesn't need to tick.
    const [openedAt] = useState(() => Date.now());
    const [pending, setPending] = useState<'restore' | 'discard' | null>(null);
    const [confirming, setConfirming] = useState<string | null>(null);
    const [viewing, setViewing] = useState(false);
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
                description: 'The one it replaced is now the earlier version.',
            });
            onOpenChange(false);
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t restore the earlier version',
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
            toast.add({
                type: 'error',
                title: 'Couldn’t delete the earlier version',
                description: driveError(error),
            });
        } finally {
            setPending(null);
            await refresh();
        }
    }

    const current = versions.data?.find((version) => version.current);
    const earlier = versions.data?.find((version) => !version.current);
    // The earlier version goes 30 days after it was replaced, that is, after the current one landed.
    const replacedAt = current ? Date.parse(current.readyAt ?? current.createdAt) : NaN;
    const daysLeft = Number.isFinite(replacedAt)
        ? Math.max(0, 30 - Math.floor((openedAt - replacedAt) / 86_400_000))
        : null;
    // The node as of one version: its content (size, thumbnail) must be that version's, not the current one's.
    const asOf = (version: NonNullable<typeof current>): DriveNode => ({
        ...node,
        currentVersion: version,
        content: version.content,
    });
    const sizeOf = (version: NonNullable<typeof current>) =>
        version.content ? formatBytes(version.content.plaintextSize) : 'Size unknown';
    return (
        <>
            <DialogHeader>
                <DialogTitle>Versions of “{node.name}”</DialogTitle>
                <DialogDescription>
                    When you replace a file, the version it replaced stays here for 30 days.
                </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col rounded-xl border border-rule">
                {versions.isPending && (
                    <div className="flex h-[136px] items-center justify-center text-muted-foreground">
                        <Spinner />
                    </div>
                )}
                {versions.isError && (
                    <p className="px-3 py-5 text-sm text-destructive">
                        {driveError(versions.error)}
                    </p>
                )}
                {current && (
                    <div className="flex min-h-[68px] items-center gap-3 border-b border-rule px-3 py-2 last:border-0">
                        <FileMark node={node} size="list" />
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span className="text-[15px] font-semibold">Current version</span>
                            <span className="text-[13px] text-muted-foreground tabular-nums">
                                {formatWhen(current.readyAt ?? current.createdAt)} ·{' '}
                                {sizeOf(current)}
                                {current.objectStatus === 'missing' && ' · missing'}
                            </span>
                        </span>
                        <Button
                            variant="outline"
                            size="sm"
                            aria-label="Download current version"
                            disabled={current.objectStatus !== 'ready'}
                            onClick={() => void downloadNodes([asOf(current)])}
                        >
                            <DownloadIcon />
                            <span className="max-sm:sr-only">Download</span>
                        </Button>
                    </div>
                )}
                {versions.data &&
                    (earlier ? (
                        <div className="flex min-h-[68px] flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
                            <FileMark node={node} size="list" className="opacity-70" />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="text-[15px] font-semibold">Earlier version</span>
                                <span className="text-[13px] text-muted-foreground tabular-nums">
                                    {formatWhen(earlier.readyAt ?? earlier.createdAt)} ·{' '}
                                    {sizeOf(earlier)}
                                    {earlier.objectStatus === 'missing'
                                        ? ' · missing'
                                        : daysLeft !== null &&
                                          ` · deleted in ${daysLeft} ${daysLeft === 1 ? 'day' : 'days'}`}
                                </span>
                            </span>
                            <span className="flex items-center gap-1">
                                <Button
                                    variant="outline"
                                    size="sm"
                                    aria-label="Restore earlier version"
                                    disabled={pending !== null || earlier.objectStatus !== 'ready'}
                                    onClick={() => void restore(earlier.id)}
                                >
                                    {pending === 'restore' ? <Spinner /> : <RotateCcwIcon />}
                                    {pending === 'restore' ? 'Restoring…' : 'Restore'}
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="Preview earlier version"
                                    title="Preview"
                                    disabled={earlier.objectStatus !== 'ready'}
                                    onClick={() => setViewing(true)}
                                >
                                    <EyeIcon />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="Download earlier version"
                                    title="Download"
                                    disabled={earlier.objectStatus !== 'ready'}
                                    onClick={() => void downloadNodes([asOf(earlier)])}
                                >
                                    <DownloadIcon />
                                </Button>
                                <Button
                                    variant="ghost"
                                    size="icon-sm"
                                    aria-label="Delete earlier version"
                                    title="Delete"
                                    className="text-destructive hover:bg-destructive-soft hover:text-destructive"
                                    disabled={pending !== null}
                                    onClick={() => setConfirming(earlier.id)}
                                >
                                    <Trash2Icon />
                                </Button>
                            </span>
                        </div>
                    ) : (
                        <p className="px-3 py-5 text-sm text-muted-foreground">
                            No earlier version. When you replace this file, the old one waits here
                            for 30 days.
                        </p>
                    ))}
            </div>
            <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Done
                </Button>
            </DialogFooter>
            {earlier && (
                <Preview
                    files={[]}
                    current={viewing ? asOf(earlier) : null}
                    onChange={(next) => !next && setViewing(false)}
                    onDownload={(version) => void downloadNodes([version])}
                    version={{
                        meta: `Earlier version · ${formatWhen(earlier.readyAt ?? earlier.createdAt)} · ${sizeOf(earlier)}`,
                        banner: `Replaced ${replacedWhen(current?.readyAt ?? current?.createdAt ?? earlier.createdAt)}${
                            daysLeft !== null
                                ? `; it stays ${daysLeft} more ${daysLeft === 1 ? 'day' : 'days'}.`
                                : '.'
                        }`,
                        restoring: pending === 'restore',
                        onRestore: () => void restore(earlier.id),
                    }}
                />
            )}
            <AlertDialog
                open={confirming !== null}
                onOpenChange={(open) => !open && setConfirming(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Delete the earlier version?</AlertDialogTitle>
                        <AlertDialogDescription>
                            It’s deleted for good and its space is freed. The current version isn’t
                            touched.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            onClick={() => {
                                const target = confirming;
                                setConfirming(null);
                                if (target) void discard(target);
                            }}
                        >
                            Delete version
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

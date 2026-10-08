import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { useState } from 'react';
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
import { driveError, formatBytes } from '@/lib/drive';
import { formatQuota, formatSpace, storageQueryOptions } from '@/lib/queries';
import { cue } from '@/lib/sounds';
import { removeEarlierVersions, storageBreakdownQueryOptions } from '@/lib/storage';

/*
 * How much room is left and what is using it: files, earlier versions and the
 * trash, each with the way to clear it. When the breakdown can't be read (a
 * locked device opens no Drive), the meter shows the total alone.
 */

const tone = {
    files: 'bg-primary',
    versions: 'bg-[color-mix(in_oklab,var(--primary)_45%,var(--card))]',
    trash: 'bg-muted-foreground',
} as const;

function Swatch({ kind }: { kind: keyof typeof tone }) {
    return <span className={cn('size-2.5 shrink-0 rounded-full', tone[kind])} aria-hidden="true" />;
}

export function StorageMeter({
    used,
    quota,
    parts,
    className,
}: {
    used: number;
    quota: number;
    parts: { files: number; versions: number; trash: number } | null;
    className?: string;
}) {
    // Anything at all gets a sliver, so a few kilobytes of trash still shows.
    const width = (n: number) => (n <= 0 ? '0%' : `${Math.max(0.8, (n / quota) * 100)}%`);
    return (
        <>
            {/* The segments are drawn for the eye; the meter itself is read out. */}
            <meter
                className="sr-only"
                min={0}
                max={quota}
                value={used}
                aria-label={`Storage used: ${formatSpace(used)} of ${formatQuota(quota)}`}
            />
            <span
                aria-hidden="true"
                className={cn(
                    'flex w-full gap-[2px] overflow-hidden rounded-full bg-rule',
                    className,
                )}
            >
                {parts ? (
                    <>
                        <span className={tone.files} style={{ width: width(parts.files) }} />
                        <span className={tone.versions} style={{ width: width(parts.versions) }} />
                        <span className={tone.trash} style={{ width: width(parts.trash) }} />
                    </>
                ) : (
                    <span className="rounded-full bg-primary" style={{ width: width(used) }} />
                )}
            </span>
        </>
    );
}

export function StorageCard({ userId }: { userId: string }) {
    const queryClient = useQueryClient();
    const storage = useQuery(storageQueryOptions);
    const breakdown = useQuery(storageBreakdownQueryOptions(queryClient, userId));
    const [asking, setAsking] = useState(false);
    const [removing, setRemoving] = useState(false);
    if (!storage.data)
        return (
            <div className="h-[168px] animate-pulse rounded-xl border border-rule bg-muted/40" />
        );
    const used = Number(storage.data.usedBytes);
    const quota = Number(storage.data.quotaBytes);
    const trash = breakdown.data ? Number(breakdown.data.trashBytes) : null;
    const versions = breakdown.data ? Number(breakdown.data.supersededBytes) : null;
    const parts =
        trash !== null && versions !== null
            ? { files: Math.max(0, used - trash - versions), versions, trash }
            : null;

    async function remove() {
        setRemoving(true);
        try {
            const purged = await removeEarlierVersions(queryClient, userId);
            cue('droplet');
            toast.add({
                type: 'success',
                title: purged === 1 ? 'Earlier version removed' : 'Earlier versions removed',
                description: 'Their space frees up in a moment.',
            });
            setAsking(false);
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t remove the earlier versions',
                description: driveError(cause),
            });
        } finally {
            setRemoving(false);
        }
    }

    return (
        <div className="flex flex-col gap-4 rounded-xl border border-rule p-5">
            <p className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-[28px] leading-none font-extrabold tracking-[-0.03em] tabular-nums">
                    {formatSpace(used)}
                </span>
                <span className="text-[15px] text-muted-foreground">
                    of {formatQuota(quota)} used
                </span>
            </p>
            <StorageMeter used={used} quota={quota} parts={parts} className="h-2.5" />
            {parts && (
                <dl className="grid gap-4 text-sm sm:grid-cols-3">
                    <div className="flex flex-col gap-1">
                        <dt className="flex items-center gap-2 font-semibold">
                            <Swatch kind="files" />
                            Files
                        </dt>
                        <dd className="text-muted-foreground tabular-nums">
                            {formatBytes(parts.files)}
                        </dd>
                    </div>
                    <div className="flex flex-col gap-1">
                        <dt className="flex items-center gap-2 font-semibold">
                            <Swatch kind="versions" />
                            Earlier versions
                        </dt>
                        <dd className="flex items-center gap-2 text-muted-foreground tabular-nums">
                            {formatBytes(parts.versions)}
                            {parts.versions > 0 && (
                                <button
                                    type="button"
                                    onClick={() => setAsking(true)}
                                    className="cursor-pointer font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                                >
                                    Remove
                                </button>
                            )}
                        </dd>
                    </div>
                    <div className="flex flex-col gap-1">
                        <dt className="flex items-center gap-2 font-semibold">
                            <Swatch kind="trash" />
                            Trash
                        </dt>
                        <dd className="flex items-center gap-2 text-muted-foreground tabular-nums">
                            {formatBytes(parts.trash)}
                            <Link
                                to="/app/trash"
                                className="font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                            >
                                Open trash
                            </Link>
                        </dd>
                    </div>
                </dl>
            )}
            <p className="text-[13px] text-muted-foreground">
                Trash and earlier versions count until they’re removed. Trash empties itself after
                30 days.
            </p>
            <AlertDialog open={asking} onOpenChange={(open) => !removing && setAsking(open)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove earlier versions?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Every file keeps its current version. The{' '}
                            {formatBytes(parts?.versions ?? 0)} of earlier versions is deleted and
                            can’t be restored.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            disabled={removing}
                            onClick={() => void remove()}
                        >
                            {removing ? 'Removing…' : 'Remove earlier versions'}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

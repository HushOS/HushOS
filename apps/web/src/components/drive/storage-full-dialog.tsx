import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { HistoryIcon, SparklesIcon, Trash2Icon, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { billingQueryOptions, catalogueQueryOptions } from '@/lib/billing';
import { driveClient, driveError, formatBytes, invalidateFolders } from '@/lib/drive';
import { formatQuota, storageQueryOptions, useBillingEnabled } from '@/lib/queries';
import { cue } from '@/lib/sounds';
import { onTransferEvent, transfers, useTransfers } from '@/lib/transfers';

/*
 * When an upload is refused for lack of room, this offers the ways out in one
 * place: a bigger plan where one is on sale, emptying the trash, and dropping
 * files' earlier versions, each with the bytes it would free. Freeing space
 * retries the refused uploads; nothing is deleted without a click here.
 */

const OVER_QUOTA = 'over-quota';

/* "Make room" on a refused upload opens the dialog again after it was closed. */
const openers = new Set<() => void>();
export function openStorageFull() {
    for (const open of openers) open();
}

export function StorageFullDialog() {
    const [open, setOpen] = useState(false);
    const [working, setWorking] = useState<'trash' | 'versions' | null>(null);
    const queryClient = useQueryClient();
    const state = useTransfers();
    const refused = state.uploads.filter(
        (item) => item.status === 'failed' && item.errorCode === OVER_QUOTA,
    );
    const needed = refused.reduce((sum, item) => sum + item.total, 0);

    useEffect(() => {
        const open = () => {
            void queryClient.invalidateQueries({ queryKey: storageQueryOptions.queryKey });
            setOpen(true);
        };
        openers.add(open);
        return () => {
            openers.delete(open);
        };
    }, [queryClient]);

    useEffect(
        () =>
            onTransferEvent((event) => {
                if (event.type !== 'failed' || event.item.errorCode !== OVER_QUOTA) return;
                // The figures shown must be the server's now, not the sidebar's cached copy.
                void queryClient.invalidateQueries({ queryKey: storageQueryOptions.queryKey });
                setOpen(true);
            }),
        [queryClient],
    );

    const storage = useQuery({ ...storageQueryOptions, enabled: open });
    const breakdown = useQuery({
        queryKey: ['drive', 'storage', 'breakdown'],
        queryFn: () => driveClient.storageBreakdown(),
        enabled: open,
        staleTime: 0,
    });
    const billing = useBillingEnabled();
    const catalogue = useQuery({ ...catalogueQueryOptions, enabled: open && billing });
    const summary = useQuery({ ...billingQueryOptions, enabled: open && billing });
    const current =
        summary.data?.subscription && !summary.data.subscription.endedAt
            ? summary.data.subscription
            : null;
    // The smallest plan with more room than this one: what "Get more room" leads to.
    const bigger = billing
        ? catalogue.data?.plans
              .filter(
                  (plan) => BigInt(plan.quotaBytes) > (current ? BigInt(current.quotaBytes) : 0n),
              )
              .sort((a, b) => (BigInt(a.quotaBytes) < BigInt(b.quotaBytes) ? -1 : 1))[0]
        : undefined;
    const canUpgrade = Boolean(bigger);
    const navigate = useNavigate();
    const again =
        refused.length === 1 ? `Uploading “${refused[0]!.name}” again.` : 'Uploading them again.';
    const trashBytes = BigInt(breakdown.data?.trashBytes ?? '0');
    const supersededBytes = BigInt(breakdown.data?.supersededBytes ?? '0');

    async function retryRefused() {
        await queryClient.invalidateQueries({ queryKey: storageQueryOptions.queryKey });
        for (const item of refused) await transfers.retry(item.id);
    }

    async function emptyTrash() {
        setWorking('trash');
        try {
            let purged = 0;
            for (;;) {
                const step = await driveClient.emptyTrash();
                purged += step.purged;
                if (step.remaining === 0 || step.purged === 0) break;
            }
            cue('droplet');
            toast.add({
                type: 'success',
                title: 'Trash emptied',
                description: again,
            });
            await invalidateFolders(queryClient);
            setOpen(false);
            await retryRefused();
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'The Trash couldn’t be emptied',
                description: driveError(error),
            });
        } finally {
            setWorking(null);
        }
    }

    async function discardVersions() {
        setWorking('versions');
        try {
            let purged = 0;
            for (;;) {
                const step = await driveClient.discardSupersededVersions();
                purged += step.purged;
                if (step.remaining === 0 || step.purged === 0) break;
            }
            cue('droplet');
            toast.add({
                type: 'success',
                title: purged === 1 ? 'Earlier version removed' : 'Earlier versions removed',
                description: again,
            });
            await invalidateFolders(queryClient);
            setOpen(false);
            await retryRefused();
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t remove the earlier versions',
                description: driveError(error),
            });
        } finally {
            setWorking(null);
        }
    }

    const available = storage.data ? BigInt(storage.data.availableBytes) : null;
    const nothingToFree = breakdown.data && trashBytes === 0n && supersededBytes === 0n;

    return (
        <Dialog open={open} onOpenChange={(value) => !working && setOpen(value)}>
            <DialogContent className="sm:max-w-[500px]">
                <DialogHeader>
                    <DialogTitle>Not enough room</DialogTitle>
                    <DialogDescription>
                        {refused.length === 1
                            ? `“${refused[0]!.name}” needs ${formatBytes(needed)}`
                            : `${refused.length} files need ${formatBytes(needed)} together`}
                        {available !== null && `, and ${formatBytes(available)} is free`}. Trash and
                        earlier versions count until they’re removed.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-2">
                    {bigger && (
                        <Way
                            icon={SparklesIcon}
                            label="Get more room"
                            detail={`${bigger.name.replace(/\s*\((monthly|yearly|annual)\)\s*$/i, '')} is ${formatQuota(bigger.quotaBytes)}`}
                            primary
                            disabled={working !== null}
                            onClick={() => {
                                setOpen(false);
                                void navigate({ to: '/app/billing' });
                            }}
                        />
                    )}
                    <Way
                        icon={Trash2Icon}
                        label="Empty trash"
                        detail={
                            working === 'trash'
                                ? 'Emptying…'
                                : breakdown.isPending
                                  ? ''
                                  : trashBytes === 0n
                                    ? 'Nothing in it'
                                    : `Frees ${formatBytes(trashBytes)}`
                        }
                        disabled={working !== null || breakdown.isPending || trashBytes === 0n}
                        onClick={() => void emptyTrash()}
                    />
                    <Way
                        icon={HistoryIcon}
                        label="Remove earlier versions"
                        detail={
                            working === 'versions'
                                ? 'Removing…'
                                : breakdown.isPending
                                  ? ''
                                  : supersededBytes === 0n
                                    ? 'None'
                                    : `Frees ${formatBytes(supersededBytes)}`
                        }
                        disabled={working !== null || breakdown.isPending || supersededBytes === 0n}
                        onClick={() => void discardVersions()}
                    />
                    {nothingToFree && !canUpgrade && (
                        <p className="text-sm text-muted-foreground">
                            Nothing in the trash or earlier versions to remove. Move files you don’t
                            need to the trash, empty it, then try again.
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button
                        variant="outline"
                        disabled={working !== null}
                        onClick={() => setOpen(false)}
                    >
                        Not now
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* One way out: what it does, and what it frees. */
function Way({
    icon: Icon,
    label,
    detail,
    primary,
    disabled,
    onClick,
}: {
    icon: LucideIcon;
    label: string;
    detail: string;
    primary?: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={cn(
                'flex h-14 w-full cursor-pointer items-center gap-3 rounded-md border px-4 text-left outline-none focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60',
                primary
                    ? 'border-primary bg-accent text-accent-foreground'
                    : 'border-rule enabled:hover:bg-muted',
            )}
        >
            <Icon className="size-[18px] shrink-0" aria-hidden="true" />
            <span className="flex-1 text-[15px] font-semibold">{label}</span>
            <span
                className={cn(
                    'text-sm tabular-nums',
                    primary ? 'text-accent-foreground' : 'text-muted-foreground',
                )}
            >
                {detail}
            </span>
        </button>
    );
}

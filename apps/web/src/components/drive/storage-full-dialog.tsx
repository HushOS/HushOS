import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRightIcon, HistoryIcon, Trash2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PendingLabel } from '@/components/motion';
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
import { storageQueryOptions, useBillingEnabled } from '@/lib/queries';
import { cue } from '@/lib/sounds';
import { onTransferEvent, transfers, useTransfers } from '@/lib/transfers';

/*
 * When an upload is refused for lack of room, this offers the ways out in one
 * place: a bigger plan where one is on sale, emptying the trash, and dropping
 * files' earlier versions, each with the bytes it would free. Freeing space
 * retries the refused uploads; nothing is deleted without a click here.
 */

const OVER_QUOTA = 'over-quota';

export function StorageFullDialog() {
    const [open, setOpen] = useState(false);
    const [working, setWorking] = useState<'trash' | 'versions' | null>(null);
    const queryClient = useQueryClient();
    const state = useTransfers();
    const refused = state.uploads.filter(
        (item) => item.status === 'failed' && item.errorCode === OVER_QUOTA,
    );
    const needed = refused.reduce((sum, item) => sum + item.total, 0);

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
    const canUpgrade = Boolean(
        billing &&
        catalogue.data?.plans.some(
            (plan) => BigInt(plan.quotaBytes) > (current ? BigInt(current.quotaBytes) : 0n),
        ),
    );
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
                title: purged === 1 ? 'Trash emptied: 1 item' : `Trash emptied: ${purged} items`,
                description: 'Retrying the uploads that did not fit.',
            });
            await invalidateFolders(queryClient);
            setOpen(false);
            await retryRefused();
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not empty the trash',
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
                title:
                    purged === 1
                        ? 'Removed 1 earlier version'
                        : `Removed ${purged} earlier versions`,
                description: 'Retrying the uploads that did not fit.',
            });
            await invalidateFolders(queryClient);
            setOpen(false);
            await retryRefused();
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not remove earlier versions',
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
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Not enough storage</DialogTitle>
                    <DialogDescription>
                        {refused.length === 1
                            ? `“${refused[0]!.name}” needs ${formatBytes(needed)}`
                            : `${refused.length} files need ${formatBytes(needed)} together`}
                        {available !== null && ` and ${formatBytes(available)} is free`}. Trash and
                        earlier versions of files count against your storage until they are removed.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-2">
                    {canUpgrade && (
                        <Button
                            render={<Link to="/app/billing" />}
                            className="justify-between"
                            onClick={() => setOpen(false)}
                        >
                            <span>Upgrade your plan</span>
                            <ArrowUpRightIcon />
                        </Button>
                    )}
                    <Button
                        variant="outline"
                        className="justify-between"
                        disabled={working !== null || breakdown.isPending || trashBytes === 0n}
                        onClick={() => void emptyTrash()}
                    >
                        <span className="flex items-center gap-2">
                            <Trash2Icon />
                            <PendingLabel
                                pending={working === 'trash'}
                                idle="Empty trash"
                                busy="Emptying"
                            />
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                            {breakdown.isPending
                                ? '…'
                                : trashBytes === 0n
                                  ? 'Empty'
                                  : `Frees ${formatBytes(trashBytes)}`}
                        </span>
                    </Button>
                    <Button
                        variant="outline"
                        className="justify-between"
                        disabled={working !== null || breakdown.isPending || supersededBytes === 0n}
                        onClick={() => void discardVersions()}
                    >
                        <span className="flex items-center gap-2">
                            <HistoryIcon />
                            <PendingLabel
                                pending={working === 'versions'}
                                idle="Remove earlier versions of files"
                                busy="Removing"
                            />
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                            {breakdown.isPending
                                ? '…'
                                : supersededBytes === 0n
                                  ? 'None'
                                  : `Frees ${formatBytes(supersededBytes)}`}
                        </span>
                    </Button>
                    {nothingToFree && !canUpgrade && (
                        <p className="text-sm text-muted-foreground">
                            There is nothing to free. Move some files to the trash and empty it,
                            then upload again.
                        </p>
                    )}
                </div>
                <DialogFooter>
                    <Button
                        variant="ghost"
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

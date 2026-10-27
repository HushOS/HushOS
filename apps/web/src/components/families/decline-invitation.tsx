import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { PendingLabel } from '@/components/motion';
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
import { afterFamilyChange, familyContext } from '@/lib/families';
import { familySynced } from '@/lib/families-keys';
import { groupsApi } from '@/lib/groups/api';
import { errorCopy } from '@/lib/groups/copy';
import { wipeGroup } from '@/lib/groups/sync';
import { cue } from '@/lib/sounds';

/*
 * Backing out of a family someone accepted an invitation to and isn't let in to yet: a quiet
 * control, asked once. The server's leave (route 20) withdraws a waiting membership outright;
 * this device then forgets what it kept of the family for the join, as leaving does. They can
 * be invited again, and meanwhile they may create a family of their own.
 */
export function DeclineInvitation({
    userId,
    groupId,
    family,
    onDeclined,
    className,
}: {
    userId: string;
    groupId: string;
    family: string;
    onDeclined?: () => void | Promise<void>;
    className?: string;
}) {
    const queryClient = useQueryClient();
    const [open, setOpen] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    async function decline() {
        setBusy(true);
        setError('');
        try {
            await groupsApi.leave(groupId);
            // Whatever the join kept on this device goes; a wipe that fails changes nothing the
            // person can act on, since they hold no family keys yet.
            const ctx = familyContext(userId);
            await ctx.lock(groupId, () => wipeGroup(ctx, groupId)).catch(() => {});
            familySynced(groupId, { status: 'wiped' });
            cue('droplet');
            toast.add({ type: 'success', title: `You declined the invitation to ${family}` });
            setOpen(false);
            await afterFamilyChange(queryClient, userId);
            await onDeclined?.();
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family }));
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Button
                variant="ghost"
                className={className}
                aria-label={`Decline invitation to ${family}`}
                onClick={() => setOpen(true)}
            >
                Decline invitation
            </Button>
            <AlertDialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Decline the invitation to {family}?</AlertDialogTitle>
                        <AlertDialogDescription>You can be invited again.</AlertDialogDescription>
                    </AlertDialogHeader>
                    {error && (
                        <p role="alert" className="text-sm text-destructive">
                            {error}
                        </p>
                    )}
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
                        <Button disabled={busy} onClick={() => void decline()}>
                            <PendingLabel
                                pending={busy}
                                idle="Decline invitation"
                                busy="Declining"
                            />
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

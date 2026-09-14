import { LockKeyholeIcon } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
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
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { UnlockDevice } from '@/components/unlock-device';
import { authClient } from '@/lib/auth-client';
import { cue } from '@/lib/sounds';

/*
 * The device control in the app header: unlocked, it offers to lock this device
 * behind a confirmation; locked, it opens the unlock form in a dialog. The label
 * names the action; the square carries the current state in colour.
 */
export function DeviceControl({
    user,
    onUnlocked,
}: {
    user: { id: string; email: string };
    onUnlocked?: () => void | Promise<void>;
}) {
    const unlockedUser = useStore(authClient.store, (state) => state.unlockedUserId);
    const restoring = useStore(authClient.store, (state) => state.restoring);
    const unlocked = unlockedUser === user.id;
    const [open, setOpen] = useState(false);
    const [locking, setLocking] = useState(false);

    async function lock() {
        setLocking(true);
        // Close before the state flips: the same `open` would otherwise carry over
        // to the unlock dialog the button shows once the device is locked.
        setOpen(false);
        try {
            await authClient.lock();
            cue('droplet');
        } catch {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not lock this device',
                description: 'Saved device access could not be removed. Try signing out.',
            });
        } finally {
            setLocking(false);
        }
    }

    // "this" drops out on narrow screens so the header keeps to one line.
    const verb = unlocked ? 'Lock' : restoring ? 'Opening' : 'Unlock';
    const trigger = (
        <button
            type="button"
            disabled={restoring}
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={open}
            title={unlocked ? 'This device is unlocked' : 'This device is locked'}
            data-cuelume-hover="tick"
            className="eyebrow flex h-full cursor-pointer items-center gap-2.5 border-l px-4 whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:hover:bg-transparent"
        >
            <span
                aria-hidden="true"
                className={`size-2.5 transition-colors duration-300 ${unlocked ? 'bg-success' : restoring ? 'bg-warning' : 'bg-ink'}`}
            />
            <span>
                {/* No swap animation here: the label changes twice in quick succession
                    while access is restored, and exiting copies were left behind. */}
                {verb}
                {!restoring && (
                    <>
                        <span className="max-sm:hidden"> this</span> device
                    </>
                )}
            </span>
        </button>
    );

    if (unlocked)
        return (
            <>
                {trigger}
                <AlertDialog open={open} onOpenChange={setOpen}>
                    <AlertDialogContent>
                        <AlertDialogHeader>
                            <AlertDialogTitle>Lock this device?</AlertDialogTitle>
                            <AlertDialogDescription>
                                Your account key is removed from this browser and uploads in
                                progress pause. You will enter your password to open your files here
                                again.
                            </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                            <AlertDialogCancel disabled={locking}>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => void lock()} disabled={locking}>
                                <LockKeyholeIcon />
                                {locking ? 'Locking' : 'Lock device'}
                            </AlertDialogAction>
                        </AlertDialogFooter>
                    </AlertDialogContent>
                </AlertDialog>
            </>
        );
    return (
        <>
            {trigger}
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Unlock this device</DialogTitle>
                        <DialogDescription>
                            Your files are encrypted with keys only you hold. Enter your password to
                            open them here.
                        </DialogDescription>
                    </DialogHeader>
                    <UnlockDevice
                        user={user}
                        className="border bg-card"
                        onUnlocked={async () => {
                            setOpen(false);
                            await onUnlocked?.();
                        }}
                    />
                </DialogContent>
            </Dialog>
        </>
    );
}

import { LockKeyholeIcon, LockKeyholeOpenIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
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
 * The account menu asks for the same dialog the header button opens, so locking
 * has one confirmation and one implementation wherever it is started from.
 */
const openers = new Set<() => void>();
export function openDeviceDialog() {
    for (const open of openers) open();
}

/*
 * The device control in the app header: unlocked, it offers to lock this device
 * behind a confirmation; locked, it opens the unlock form in a dialog. The label
 * names the action; the padlock carries the current state.
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
    useEffect(() => {
        const opener = () => setOpen(true);
        openers.add(opener);
        return () => void openers.delete(opener);
    }, []);

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
            className="flex h-8 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default disabled:hover:bg-transparent"
        >
            {unlocked ? (
                <LockKeyholeOpenIcon aria-hidden="true" className="size-4 text-success" />
            ) : (
                <LockKeyholeIcon
                    aria-hidden="true"
                    className={`size-4 ${restoring ? 'text-warning' : 'text-foreground'}`}
                />
            )}
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
                        className="rounded-md border border-rule"
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

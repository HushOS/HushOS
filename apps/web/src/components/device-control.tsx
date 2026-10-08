import { LockKeyholeIcon } from 'lucide-react';
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
 * The account menu and the command palette ask for the same dialogs, so locking
 * has one confirmation and one implementation wherever it is started from.
 */
const openers = new Set<() => void>();
export function openDeviceDialog() {
    for (const open of openers) open();
}

/* Locks at once, without asking: for a choice the person has already made, like "Lock instead". */
export async function lockDevice() {
    try {
        await authClient.lock();
        cue('droplet');
        toast.add({ title: 'HushOS is locked on this browser' });
    } catch {
        cue('error');
        toast.add({
            type: 'error',
            title: 'Couldn’t lock HushOS here',
            description: 'Try signing out instead.',
        });
    }
}

/*
 * The lock and unlock dialogs. Unlocked, it asks before locking HushOS on this
 * browser; locked, it opens the unlock form. Nothing is drawn until asked.
 */
export function DeviceControl({
    user,
    onUnlocked,
}: {
    user: { id: string; email: string };
    onUnlocked?: () => void | Promise<void>;
}) {
    const unlockedUser = useStore(authClient.store, (state) => state.unlockedUserId);
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
        // to the unlock dialog once the device is locked.
        setOpen(false);
        await lockDevice();
        setLocking(false);
    }

    if (unlocked)
        return (
            <AlertDialog open={open} onOpenChange={setOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Lock HushOS on this browser?</AlertDialogTitle>
                        <AlertDialogDescription>
                            You’ll need your password to open your files here again. Uploads in
                            progress pause until you unlock.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={locking}>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => void lock()} disabled={locking}>
                            <LockKeyholeIcon />
                            {locking ? 'Locking…' : 'Lock'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        );
    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent className="sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle>Unlock HushOS</DialogTitle>
                    <DialogDescription>
                        Enter your password to open your files on this browser.
                    </DialogDescription>
                </DialogHeader>
                <UnlockDevice
                    user={user}
                    onCancel={() => setOpen(false)}
                    onUnlocked={async () => {
                        setOpen(false);
                        await onUnlocked?.();
                    }}
                />
            </DialogContent>
        </Dialog>
    );
}

import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { FingerprintWords } from '@/components/fingerprint-words';
import { Spinner } from '@/components/motion';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { authClient } from '@/lib/auth-client';
import { ownFingerprintQueryOptions } from '@/lib/contacts';

/*
 * What others check when they add this person: their twelve words, read aloud
 * from here. A dialog rather than a section of People, so it is one click away
 * however many people are listed, and from the account menu or the command
 * palette on any page while someone waits on a call.
 *
 * The words come from the unlocked keys, so locking closes it (and it does not
 * come back by itself on the next unlock), and each opening reads them afresh:
 * after the keys are replaced, the old words are never shown, even briefly.
 */
export function OwnWordsDialog({
    userId,
    open,
    onOpenChange,
}: {
    userId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const unlocked = useStore(authClient.store, (state) => state.unlockedUserId) === userId;
    useEffect(() => {
        if (open && !unlocked) onOpenChange(false);
    }, [open, unlocked, onOpenChange]);
    const own = useQuery({
        ...ownFingerprintQueryOptions(userId),
        enabled: open && unlocked,
        // Stale at once, so every opening reads them again: the dialog stays mounted between
        // openings, and a mount-time refetch alone would answer from the first reading.
        staleTime: 0,
    });
    return (
        <Dialog open={open && unlocked} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[560px]">
                <DialogHeader>
                    <DialogTitle>Your twelve words</DialogTitle>
                    <DialogDescription>
                        When someone adds you, they’ll ask you to read these. They’re the same on
                        all your devices.
                    </DialogDescription>
                </DialogHeader>
                <div className="min-h-36">
                    {own.isFetching || own.isPending ? (
                        <output className="flex items-center gap-2 text-sm">
                            <Spinner className="size-4 text-muted-foreground" />
                            <span className="sr-only">Opening your words</span>
                        </output>
                    ) : own.isError ? (
                        <p role="alert" className="text-sm text-destructive">
                            {own.error instanceof Error ? own.error.message : 'Couldn’t open it.'}
                        </p>
                    ) : (
                        <FingerprintWords fingerprint={own.data} />
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}

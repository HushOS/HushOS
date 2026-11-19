import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/components/ui/toast';
import { answerInterrupted, useInterruptedRuns } from '@/lib/interrupted-runs';

/*
 * A run a closed tab left behind (lib/interrupted-runs.ts), one at a time: delete what it made,
 * or keep it. Asked once the drive is open; the row carries ids only, so the question names how
 * many items, not which.
 */
export function InterruptedRuns() {
    const queryClient = useQueryClient();
    const rows = useInterruptedRuns();
    // The row answered: the dialog's closing must not answer it a second time.
    const answered = useRef<string | null>(null);
    const row = rows[0];
    if (!row) return null;
    const count = row.nodeIds.length;
    async function answer(choice: 'delete' | 'keep') {
        if (answered.current === row!.id) return;
        answered.current = row!.id;
        const outcome = await answerInterrupted(queryClient, row!, choice).catch(
            () => 'left' as const,
        );
        const unfinished = outcome === 'left' || outcome === 'busy' || outcome === 'not-recorded';
        if (unfinished)
            toast.add({
                type: 'error',
                title:
                    choice === 'delete'
                        ? 'Not everything it made could be deleted. You’ll be asked again next time.'
                        : 'This couldn’t be recorded. You’ll be asked again next time.',
            });
    }
    return (
        // Closed only by an answer: each button says which.
        <AlertDialog open>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {count === 1
                            ? 'Saving a file was interrupted. Delete what was made?'
                            : `Saving ${count} files was interrupted. Delete what was made?`}
                    </AlertDialogTitle>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogCancel onClick={() => void answer('keep')}>
                        Keep it
                    </AlertDialogCancel>
                    <AlertDialogAction variant="destructive" onClick={() => void answer('delete')}>
                        Delete
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
}

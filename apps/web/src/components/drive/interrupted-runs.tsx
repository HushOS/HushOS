import { useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
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
import { toast } from '@/components/ui/toast';
import { answerInterrupted, useInterruptedRuns } from '@/lib/drive/runs/interrupted-runs';

/*
 * A run a closed tab left behind (lib/drive/runs/interrupted-runs.ts), one at a time: delete what it made,
 * or keep it. Asked once the drive is open; the row carries ids only, so the question names how
 * many items, not which.
 */
export function InterruptedRuns() {
    const queryClient = useQueryClient();
    const rows = useInterruptedRuns();
    // An answer on its way: a second click waits for it. Only while it is in flight, so a row the
    // journal offers again (after `busy` or `left`) can be answered again.
    const inFlight = useRef<string | null>(null);
    const row = rows[0];
    if (!row) return null;
    const count = row.nodeIds.length;
    // Offered again for a folder whose creation was uncertain and which turned up: its count was taken then.
    const folder = row.holds !== undefined || row.uncounted === true;
    async function answer(choice: 'delete' | 'keep') {
        if (inFlight.current === row!.id) return;
        inFlight.current = row!.id;
        try {
            const outcome = await answerInterrupted(queryClient, row!, choice).catch(
                () => 'left' as const,
            );
            if (outcome === 'no-access')
                toast.add({
                    type: 'error',
                    title: 'You can no longer change that folder, so what was made may still be there.',
                });
            else if (outcome === 'left' || outcome === 'busy' || outcome === 'not-recorded')
                toast.add({
                    type: 'error',
                    title:
                        choice === 'delete'
                            ? 'Not everything it made could be deleted. You’ll be asked again next time.'
                            : 'This couldn’t be recorded. You’ll be asked again next time.',
                });
        } finally {
            inFlight.current = null;
        }
    }
    return (
        // Closed only by an answer: each button says which.
        <AlertDialog open>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        {folder
                            ? 'Making a folder was interrupted. Delete what was made?'
                            : count === 1
                              ? 'Saving a file was interrupted. Delete what was made?'
                              : `Saving ${count} files was interrupted. Delete what was made?`}
                    </AlertDialogTitle>
                    {/* A folder found after it was asked about may hold more now: deleting it deletes that too. */}
                    {folder && (
                        <AlertDialogDescription>
                            {row.uncounted
                                ? 'What it holds couldn’t be counted. Deleting it deletes everything in it.'
                                : row.holds === 1
                                  ? 'It holds 1 item now, which would be deleted with it.'
                                  : `It holds ${row.holds} items now, which would be deleted with it.`}
                        </AlertDialogDescription>
                    )}
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

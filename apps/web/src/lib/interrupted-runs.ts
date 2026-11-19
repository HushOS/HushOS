import type { RunRow } from '@hushos/drive/journal';
import type { QueryClient } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { authClient } from '@/lib/auth-client';
import { onSignedOutElsewhere } from '@/lib/device-data';
import { forgetOnLeaving } from '@/lib/tool-run-rows';

/*
 * Runs a closed tab left behind (docs/file-tools-design.md, section 3, "Cancellation and failure
 * leave nothing"): each open asks the run journal for them once the drive is open, and the
 * person answers Delete what was made or Keep it. The save path itself loads only for the look,
 * so the drive shell does not grow by it.
 */

let rows: readonly RunRow[] = [];
const listeners = new Set<() => void>();
function set(next: readonly RunRow[]) {
    rows = next;
    for (const listener of listeners) listener();
}

/* Moves on at every forget (a lock, a sign-out, another account): a look begun before one is never published after it. */
let unlock = 0;
/* Once a drive open: the rows to offer, settled ones handled quietly by the save path. */
export async function lookForInterrupted(queryClient: QueryClient) {
    const at = unlock;
    try {
        const { interruptedSaveRuns } = await import('@/lib/save-runs');
        const found = await interruptedSaveRuns(queryClient);
        if (at === unlock) set(found);
    } catch {
        // Nothing to offer this time; the next open looks again.
    }
}

/* The person's answer to the first row offered: it leaves the list either way, and a failure is said. */
export async function answerInterrupted(
    queryClient: QueryClient,
    row: RunRow,
    choice: 'delete' | 'keep',
) {
    set(rows.filter((other) => other.id !== row.id));
    const { cleanUpSaveRun, keepSaveRun } = await import('@/lib/save-runs');
    return choice === 'delete' ? cleanUpSaveRun(queryClient, row) : keepSaveRun(queryClient, row);
}

/* A sign-out: nothing of this account's is offered to the next. */
export function forgetInterrupted() {
    unlock++;
    set([]);
}

export function useInterruptedRuns() {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        },
        () => rows,
        () => rows,
    );
}

// Nothing of this account's offered while locked, or to the next account, or after another tab signs out.
forgetOnLeaving(authClient.store, onSignedOutElsewhere, forgetInterrupted);

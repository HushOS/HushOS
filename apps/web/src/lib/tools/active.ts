/*
 * Every tool run of the tab, running or waiting, so a lock or a sign-out ends them all: no
 * worker parsing decrypted bytes, and no result waiting for upload, outlives the unlock
 * (owner, 2026-10-27: nothing survives sign-out). Kept apart from run.ts so the drive shell
 * can end runs without loading the harness.
 */
const runs = new Set<() => void>();

export function trackToolRun(cancel: () => void) {
    runs.add(cancel);
    return () => void runs.delete(cancel);
}

export function cancelAllToolRuns() {
    // Newest first: the running run is the oldest, so every waiting one is gone before it ends and none starts.
    for (const cancel of [...runs].reverse()) cancel();
}

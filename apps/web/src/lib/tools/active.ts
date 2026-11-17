/*
 * Every tool run of the tab that still holds anything: running, waiting, or done with results
 * not yet released to the upload. A lock or a sign-out ends them all: a run going or waiting is
 * cancelled, and a run that is done drops the results it still holds (their buffers detached,
 * their room in the budget back), so no worker parses decrypted bytes and no plaintext waits
 * in the page past the unlock (owner, 2026-10-27: nothing survives sign-out). Kept apart from
 * run.ts so the drive shell can end runs without loading the harness.
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

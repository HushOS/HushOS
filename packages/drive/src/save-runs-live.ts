/*
 * The runs live in this page (packages/drive/src/save-runs.ts), apart from the
 * engine that makes them: what the app shell reaches at every lock, sign-out
 * and unload (lockRuns, abandonRuns, resultsWaiting) without loading the save
 * path itself, which comes in with the first editor or tool that saves.
 */

/* A run as the page holds it while it lives. */
export type LiveRunHandle = {
    readonly id: string;
    waiting(): number;
    abandon(): void;
    lock(): Promise<unknown>;
};

/* Runs live in this page: a result still waiting to upload asks before the page unloads. */
export const liveRuns = new Set<LiveRunHandle>();

export function resultsWaiting() {
    for (const run of liveRuns) if (run.waiting() > 0) return true;
    return false;
}

/*
 * A sign-out (here or in another tab): every run in this page stops at once.
 * Its pending results are rejected and their bytes let go; nothing is written
 * to the journal (the sign-out deletes it) and nothing is asked of the server
 * (the uploads were already dropped and released by the queue).
 */
export function abandonRuns() {
    // A Set may lose the entry being visited: each run removes itself as it ends.
    for (const run of liveRuns) run.abandon();
}

let locks = 0;
/* Moved on by every lock: a run still starting (not yet live, so lockRuns can't reach it) checks it. */
export function lockGeneration() {
    return locks;
}

/*
 * The device locked (the app's explicit lock, not only an upload's worker
 * finding out): every run in this page stops and cleans up, a result paused or
 * completing included, rather than hold its plaintext until someone unlocks or
 * report a save afterwards.
 */
export function lockRuns() {
    locks += 1;
    return Promise.all([...liveRuns].map((run) => run.lock()));
}

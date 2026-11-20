/*
 * Editors with unsaved text, so locking writes their drafts first (lib/drafts.ts): a lock drops
 * the editor's text, and its draft is what brings it back after the unlock. Imports nothing, so
 * the lock control carries none of the editor's code.
 */
const flushers = new Set<() => Promise<void>>();

/* Registers an open editor's flush; the returned function unregisters it. */
export function flushBeforeLock(flush: () => Promise<void>) {
    flushers.add(flush);
    return () => {
        flushers.delete(flush);
    };
}

/* Writes every open editor's draft, never waiting longer than `ms`: a lock is never held up for long. */
export async function flushDrafts(ms = 1_500) {
    if (flushers.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
        Promise.allSettled([...flushers].map((flush) => flush())),
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

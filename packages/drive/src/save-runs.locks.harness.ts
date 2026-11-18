import type { SaveRunDeps } from './save-runs';

/*
 * A run's lock as Web Locks keep it, shared by every "tab" a test makes from it: a held lock is
 * granted to no one else until it is released; `hold` waits for it (a live run), `exclusive`
 * takes it only if it is free (a recovery), and `isLive` says whether it is held.
 */
export function runLocks(): Pick<SaveRunDeps, 'hold' | 'exclusive' | 'isLive'> & {
    held: Set<string>;
} {
    const held = new Set<string>();
    const waiting = new Map<string, Array<() => void>>();
    const release = (id: string) => {
        held.delete(id);
        waiting.get(id)?.shift()?.();
    };
    return {
        held,
        hold: async (id) => {
            while (held.has(id)) {
                const queue = waiting.get(id) ?? [];
                waiting.set(id, queue);
                await new Promise<void>((resolve) => queue.push(resolve));
            }
            held.add(id);
            return () => release(id);
        },
        exclusive: async (id, work) => {
            if (held.has(id)) return null;
            held.add(id);
            try {
                return await work();
            } finally {
                release(id);
            }
        },
        isLive: async (id) => held.has(id),
    };
}

/* A lock that is always free: a test of one tab whose runs are not live. */
export const freeLock: SaveRunDeps['exclusive'] = (_id, work) => work();

import { useSyncExternalStore } from 'react';

/*
 * A dropped file whose name already exists in its destination waits here for
 * the person's answer: replace the file (a new version), keep both under
 * another name, or skip it. The dialog answers one prompt at a time; "apply to
 * all" carries the same answer to the rest of the drop.
 */

export type CollisionPrompt = {
    id: number;
    fileName: string;
    folderName: string;
    /* A free name to offer for "keep both". */
    suggested: string;
    /* Names already taken in the folder, so an edited name can be refused before upload. */
    taken: Set<string>;
    /* How many other collisions in this drop still wait after this one. */
    remaining: number;
};

export type CollisionDecision =
    | { action: 'replace'; all: boolean }
    | { action: 'keep'; name: string; all: boolean }
    | { action: 'skip'; all: boolean };

type Pending = { prompt: CollisionPrompt; resolve: (decision: CollisionDecision) => void };

let queue: Pending[] = [];
let sequence = 0;
const listeners = new Set<() => void>();
function notify() {
    for (const listener of listeners) listener();
}

/* Asks and waits; prompts are answered in the order they were asked. */
export function askCollision(prompt: Omit<CollisionPrompt, 'id'>) {
    return new Promise<CollisionDecision>((resolve) => {
        queue = [...queue, { prompt: { ...prompt, id: ++sequence }, resolve }];
        notify();
    });
}

export function answerCollision(id: number, decision: CollisionDecision) {
    const pending = queue.find((entry) => entry.prompt.id === id);
    if (!pending) return;
    queue = queue.filter((entry) => entry !== pending);
    notify();
    pending.resolve(decision);
}

const EMPTY: CollisionPrompt | null = null;
/* The prompt at the head of the queue, for the dialog. */
export function useCollisionPrompt() {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => queue[0]?.prompt ?? EMPTY,
        () => EMPTY,
    );
}

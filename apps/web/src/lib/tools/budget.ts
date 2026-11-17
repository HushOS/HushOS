import { TOOL_BUDGET_BYTES } from './protocol';

/*
 * The produced-plaintext budget: what tools handed on and the upload has not yet taken. One
 * for the tab (`toolBudget`), not one per run: a run that is done leaves its results counted
 * until the save path releases them, so the next run cannot add another 512 MiB on top. The
 * result that crosses the limit is taken; the next is held back until releases bring the
 * total under it again.
 */
export class PlaintextBudget {
    #waiting = 0;
    #waiters = new Set<() => void>();

    constructor(readonly limit = TOOL_BUDGET_BYTES) {}

    get waiting() {
        return this.#waiting;
    }

    get full() {
        return this.#waiting >= this.limit;
    }

    take(bytes: number) {
        this.#waiting += bytes;
    }

    release(bytes: number) {
        this.#waiting = Math.max(0, this.#waiting - bytes);
        if (this.full) return;
        const waiters = [...this.#waiters];
        this.#waiters.clear();
        for (const waiter of waiters) waiter();
    }

    /* Calls `onRoom` once there is room (at once if there is); returns what stops waiting. */
    whenRoom(onRoom: () => void): () => void {
        if (!this.full) {
            onRoom();
            return () => {};
        }
        const waiter = () => onRoom();
        this.#waiters.add(waiter);
        return () => this.#waiters.delete(waiter);
    }
}

/* The tab's budget, which every run shares. */
export const toolBudget = new PlaintextBudget();

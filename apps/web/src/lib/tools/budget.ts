import { TOOL_BUDGET_BYTES } from './protocol';

/*
 * The produced-plaintext budget of one run: what the tool handed on and the upload has not
 * yet taken. The save path releases each result as its upload finishes with the bytes. The
 * result that crosses the limit is taken; the next is held back until releases bring the
 * total under it again, so a run holds at most the limit plus one result.
 */
export class PlaintextBudget {
    #waiting = 0;
    #closed: Error | null = null;
    #waiters: { resolve: () => void; reject: (error: Error) => void }[] = [];

    constructor(readonly limit = TOOL_BUDGET_BYTES) {}

    get waiting() {
        return this.#waiting;
    }

    get full() {
        return this.#waiting >= this.limit;
    }

    take(bytes: number) {
        if (this.#closed) throw this.#closed;
        this.#waiting += bytes;
    }

    release(bytes: number) {
        this.#waiting = Math.max(0, this.#waiting - bytes);
        if (this.full) return;
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const waiter of waiters) waiter.resolve();
    }

    /* Settles once there is room; rejects if the run ends first. */
    whenRoom(): Promise<void> {
        if (this.#closed) return Promise.reject(this.#closed);
        if (!this.full) return Promise.resolve();
        return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
    }

    /* The run ended: nothing is waiting any more, and whoever waits for room is told why. */
    close(reason: Error) {
        this.#closed = reason;
        this.#waiting = 0;
        const waiters = this.#waiters;
        this.#waiters = [];
        for (const waiter of waiters) waiter.reject(reason);
    }
}

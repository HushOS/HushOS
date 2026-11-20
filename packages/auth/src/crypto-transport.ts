import type { CryptoRequests, CryptoResults } from '@hushos/crypto';

// The auth coordinator depends on this boundary, not Worker or a UI framework.
// Native shells can supply an IPC/JSI bridge to a crypto implementation.
export type RequestOptions = {
    /* Called for every progress message the operation posts (transfers). */
    onProgress?: (progress: unknown) => void;
    /* Lock the device if the worker is silent for this long. Progress resets it. */
    idleTimeoutMs?: number;
    /* Buffers moved to the worker rather than copied: they are detached here once sent. */
    transfer?: Transferable[];
    /*
     * Asked for just before a lock (an editor's last draft, sealed as the key goes): a lock lets this
     * request finish, never longer than LOCK_DRAIN_MS, before the worker goes. Nothing new is taken.
     */
    drainOnLock?: boolean;
};

/* How long a lock waits for requests asked for just before it (drainOnLock) before the worker goes. */
export const LOCK_DRAIN_MS = 1_000;

export interface CryptoTransport {
    request<K extends keyof CryptoRequests>(
        operation: K,
        input: CryptoRequests[K],
        options?: RequestOptions,
    ): Promise<CryptoResults[K]>;
    lock(): void;
    /* Called when the transport closes itself (worker error, unanswered call). */
    onLock(listener: () => void): void;
}

type WorkerMessage = {
    id: number;
    result?: unknown;
    error?: string;
    /* The worker refused without changing anything, and kept its keys. */
    kept?: boolean;
    /* The saved unlock does not open with the device key it was given (SavedAccessError). */
    invalid?: boolean;
    progress?: unknown;
};

export function createBrowserCryptoTransport(createWorker: () => Worker): CryptoTransport {
    const worker = createWorker();
    let sequence = 0;
    let closed = false;
    const pending = new Map<
        number,
        {
            resolve: (value: unknown) => void;
            reject: (error: Error) => void;
            onProgress?: (progress: unknown) => void;
            drain: boolean;
            arm: () => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    const listeners = new Set<() => void>();
    /* The worker goes, once what may still finish (draining) has, or LOCK_DRAIN_MS has passed. */
    let terminated = false;
    function terminate() {
        if (terminated) return;
        terminated = true;
        worker.terminate();
        for (const task of pending.values()) {
            clearTimeout(task.timer);
            task.reject(new Error('Your account was locked. Please try again.'));
        }
        pending.clear();
    }
    function lock() {
        if (closed) return;
        closed = true;
        // Everything but a request asked for just before the lock is refused now; the worker
        // answers those it already took in order, then goes.
        for (const [id, task] of pending)
            if (!task.drain) {
                clearTimeout(task.timer);
                task.reject(new Error('Your account was locked. Please try again.'));
                pending.delete(id);
            }
        if (pending.size === 0) terminate();
        else {
            // The worker stops its own ordinary work too (queued operations refused, uploads
            // aborted), so only the draft seal runs while it drains.
            try {
                worker.postMessage({ id: 0, operation: 'lockBegins' });
            } catch {
                terminate();
            }
            setTimeout(terminate, LOCK_DRAIN_MS);
        }
        for (const listener of listeners) listener();
        listeners.clear();
    }
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
        const task = pending.get(event.data.id);
        if (!task) return;
        if ('progress' in event.data && event.data.result === undefined && !event.data.error) {
            task.onProgress?.(event.data.progress);
            task.arm();
            return;
        }
        pending.delete(event.data.id);
        clearTimeout(task.timer);
        // Locked, and the last request it waited for has answered: the worker goes now.
        if (closed && pending.size === 0) queueMicrotask(terminate);
        if (event.data.error)
            task.reject(
                Object.assign(
                    new Error(event.data.error),
                    event.data.kept ? { kept: true } : {},
                    event.data.invalid ? { invalid: true } : {},
                ),
            );
        else task.resolve(event.data.result);
    };
    worker.onerror = () => {
        lock();
        terminate();
    };
    return {
        lock,
        onLock(listener) {
            if (closed) listener();
            else listeners.add(listener);
        },
        request<K extends keyof CryptoRequests>(
            operation: K,
            input: CryptoRequests[K],
            options: RequestOptions = {},
        ) {
            if (closed) return Promise.reject(new Error('Your account is locked.'));
            const id = ++sequence;
            const idle = options.idleTimeoutMs ?? 60_000;
            return new Promise<CryptoResults[K]>((resolve, reject) => {
                const task = {
                    resolve: (value: unknown) => resolve(value as CryptoResults[K]),
                    reject,
                    drain: options.drainOnLock === true,
                    onProgress: options.onProgress,
                    timer: setTimeout(lock, idle),
                    arm() {
                        clearTimeout(task.timer);
                        task.timer = setTimeout(lock, idle);
                    },
                };
                pending.set(id, task);
                try {
                    worker.postMessage({ id, operation, input }, options.transfer ?? []);
                } catch {
                    lock();
                }
            });
        },
    };
}

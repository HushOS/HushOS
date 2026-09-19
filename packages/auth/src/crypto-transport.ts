import type { CryptoRequests, CryptoResults } from '@hushos/crypto';

// The auth coordinator depends on this boundary, not Worker or a UI framework.
// Native shells can supply an IPC/JSI bridge to a crypto implementation.
export type RequestOptions = {
    /* Called for every progress message the operation posts (transfers). */
    onProgress?: (progress: unknown) => void;
    /* Lock the device if the worker is silent for this long. Progress resets it. */
    idleTimeoutMs?: number;
};

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

type WorkerMessage = { id: number; result?: unknown; error?: string; progress?: unknown };

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
            arm: () => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    const listeners = new Set<() => void>();
    function lock() {
        if (closed) return;
        closed = true;
        worker.terminate();
        for (const task of pending.values()) {
            clearTimeout(task.timer);
            task.reject(new Error('Your account was locked. Please try again.'));
        }
        pending.clear();
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
        if (event.data.error) task.reject(new Error(event.data.error));
        else task.resolve(event.data.result);
    };
    worker.onerror = lock;
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
                    onProgress: options.onProgress,
                    timer: setTimeout(lock, idle),
                    arm() {
                        clearTimeout(task.timer);
                        task.timer = setTimeout(lock, idle);
                    },
                };
                pending.set(id, task);
                try {
                    worker.postMessage({ id, operation, input });
                } catch {
                    lock();
                }
            });
        },
    };
}

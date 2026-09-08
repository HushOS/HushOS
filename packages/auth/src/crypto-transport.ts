import type { CryptoRequests, CryptoResults } from '@hushos/crypto';

// The auth coordinator depends on this boundary, not Worker or a UI framework.
// Native shells can supply an IPC/JSI bridge to a crypto implementation.
export interface CryptoTransport {
    request<K extends keyof CryptoRequests>(
        operation: K,
        input: CryptoRequests[K],
    ): Promise<CryptoResults[K]>;
    lock(): void;
}

export function createBrowserCryptoTransport(createWorker: () => Worker): CryptoTransport {
    const worker = createWorker();
    let sequence = 0;
    let closed = false;
    const pending = new Map<
        number,
        {
            resolve: (value: unknown) => void;
            reject: (error: Error) => void;
            timer: ReturnType<typeof setTimeout>;
        }
    >();
    function lock() {
        if (closed) return;
        closed = true;
        worker.terminate();
        for (const task of pending.values()) {
            clearTimeout(task.timer);
            task.reject(new Error('Your account was locked. Please try again.'));
        }
        pending.clear();
    }
    worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
        const task = pending.get(event.data.id);
        if (!task) return;
        pending.delete(event.data.id);
        clearTimeout(task.timer);
        if (event.data.error) task.reject(new Error(event.data.error));
        else task.resolve(event.data.result);
    };
    worker.onerror = lock;
    return {
        lock,
        request<K extends keyof CryptoRequests>(operation: K, input: CryptoRequests[K]) {
            if (closed) return Promise.reject(new Error('Your account is locked.'));
            const id = ++sequence;
            return new Promise<CryptoResults[K]>((resolve, reject) => {
                const timer = setTimeout(lock, 60_000);
                pending.set(id, {
                    resolve: (value) => resolve(value as CryptoResults[K]),
                    reject,
                    timer,
                });
                try {
                    worker.postMessage({ id, operation, input });
                } catch {
                    lock();
                }
            });
        },
    };
}

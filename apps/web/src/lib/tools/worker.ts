import {
    RANGE_READ_MAX,
    TOOL_FAILED,
    type RangeAnswer,
    type RangeRequest,
    type ToPage,
    type ToWorker,
} from './protocol';

/*
 * The worker's side of a tool run: imported by each tools worker (archive, PDF, image),
 * which calls `serveTool` once with its work. The worker holds no keys and reads its
 * sources only through the page; whatever it produces is transferred to the page, and the
 * next result waits until the page has room for it. It never ends itself: the page
 * terminates it when the run is over, which also frees its WebAssembly heap.
 */

/* A refusal the tool understood, in the person's words. Any other error becomes TOOL_FAILED. */
export class ToolError extends Error {}

export type RangeSource = {
    size: number;
    read(offset: number, length: number): Promise<Uint8Array>;
};

export type ToolContext = {
    sources: RangeSource[];
    progress: (done: number, total?: number | null) => void;
    /* Hands a result to the page, transferred; settles once the page has room for the next. */
    produce: (name: string, bytes: Uint8Array, mime?: string | null) => Promise<void>;
};

type Scope = {
    postMessage(message: ToPage, transfer?: Transferable[]): void;
    onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

function rangeSource(size: number, port: MessagePort): RangeSource {
    let next = 0;
    const pending = new Map<
        number,
        { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }
    >();
    port.onmessage = (event: MessageEvent<RangeAnswer>) => {
        const answer = event.data;
        const waiter = pending.get(answer.id);
        if (!waiter) return;
        pending.delete(answer.id);
        if (answer.type === 'data') waiter.resolve(new Uint8Array(answer.bytes));
        else waiter.reject(new Error(answer.message));
    };
    return {
        size,
        read(offset, length) {
            const end = Math.min(size, offset + length);
            if (offset < 0 || end <= offset) return Promise.resolve(new Uint8Array(0));
            if (end - offset > RANGE_READ_MAX)
                return Promise.reject(new Error('The read was too long.'));
            const id = next++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                const request: RangeRequest = { type: 'read', id, offset, length: end - offset };
                port.postMessage(request);
            });
        },
    };
}

export function serveTool<I, R>(
    work: (input: I, context: ToolContext) => Promise<R>,
    scope: Scope = self as unknown as Scope,
) {
    let nextOutput = 0;
    const accepted = new Map<number, () => void>();
    let started = false;
    scope.onmessage = (event) => {
        const msg = event.data;
        if (msg.type === 'accepted') {
            accepted.get(msg.id)?.();
            accepted.delete(msg.id);
            return;
        }
        if (msg.type !== 'start' || started) return;
        started = true;
        const context: ToolContext = {
            sources: msg.sources.map((source) => rangeSource(source.size, source.port)),
            progress(done, total = null) {
                scope.postMessage({ type: 'progress', done, total });
            },
            produce(name, bytes, mime = null) {
                const id = nextOutput++;
                // Transferred whole: a view onto a larger buffer is cut out first.
                const buffer =
                    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
                        ? (bytes.buffer as ArrayBuffer)
                        : bytes.slice().buffer;
                const room = new Promise<void>((resolve) => accepted.set(id, resolve));
                scope.postMessage({ type: 'output', id, name, mime, bytes: buffer }, [buffer]);
                return room;
            },
        };
        work(msg.input as I, context).then(
            (result) => scope.postMessage({ type: 'done', result }),
            (error: unknown) =>
                scope.postMessage({
                    type: 'fail',
                    message: error instanceof ToolError ? error.message : TOOL_FAILED,
                }),
        );
    };
}

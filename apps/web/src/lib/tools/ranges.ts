import type { FileReader } from '@hushos/drive/downloads';
import { RANGE_READ_MAX, READS_IN_FLIGHT, type RangeAnswer, type RangeRequest } from './protocol';

/*
 * The page's end of a source's range port. The worker asks for a range; the page reads it
 * from the source and transfers it, keeping nothing. A Drive file is read through the
 * download engine's `FileReader` in its tool mode (sources.ts), which fetches and decrypts
 * the 8 MiB chunks a range covers, as the media player's ranges are (`serveMedia` in
 * lib/previews.ts); a small file the page already holds is read from memory.
 */

export type RangeReader = Pick<FileReader, 'size' | 'read'> & {
    /* Each read returns bytes nobody else holds, so they can be transferred without a copy. */
    fresh?: boolean;
    /* Lets go of what the source holds (the download reader's chunks, its key in the crypto worker). */
    close?: () => void | Promise<void>;
};

/* A reader over bytes already in memory: a small file read whole, a result fed to the next tool. */
export function memoryReader(bytes: Uint8Array): RangeReader {
    return {
        size: bytes.byteLength,
        async read(offset, length) {
            const start = Math.min(Math.max(0, offset), bytes.byteLength);
            return bytes.subarray(start, Math.min(bytes.byteLength, start + Math.max(0, length)));
        },
    };
}

/*
 * What a run lets its worker have asked for and not yet received, across all its sources:
 * at most READS_IN_FLIGHT reads and RANGE_READ_MAX bytes. A worker asking for more is not
 * pacing itself as worker.ts does, and its run fails.
 */
export function readAllowance() {
    let reads = 0;
    let bytes = 0;
    return {
        take(length: number) {
            if (reads + 1 > READS_IN_FLIGHT || bytes + length > RANGE_READ_MAX) return false;
            reads++;
            bytes += length;
            return true;
        },
        give(length: number) {
            reads--;
            bytes -= length;
        },
    };
}

export type ServeHooks = {
    /* Marks a read as a wait on the page, so the watchdog leaves it out; returns its end. */
    hold?: () => () => void;
    allowance?: ReturnType<typeof readAllowance>;
    /* The worker broke a rule: the run fails. */
    onAbuse?: () => void;
};

function validRequest(data: unknown): data is RangeRequest {
    const msg = data as RangeRequest | null;
    return (
        msg?.type === 'read' &&
        Number.isSafeInteger(msg.id) &&
        Number.isSafeInteger(msg.offset) &&
        Number.isSafeInteger(msg.length) &&
        msg.offset >= 0 &&
        msg.length >= 0
    );
}

/*
 * Answers range reads on `port` from `reader` until the returned stop is called. A read
 * that is malformed, longer than RANGE_READ_MAX or past the run's allowance is never
 * started: it is answered with a failure, and the run is told (`onAbuse`).
 */
export function serveRanges(port: MessagePort, reader: RangeReader, hooks: ServeHooks = {}) {
    let stopped = false;
    port.onmessage = (event: MessageEvent) => {
        const data: unknown = event.data;
        if (stopped) return;
        if (!validRequest(data)) {
            const id = (data as { id?: unknown } | null)?.id;
            if (Number.isSafeInteger(id))
                answer({ type: 'fail', id: id as number, message: 'The read was not valid.' });
            hooks.onAbuse?.();
            return;
        }
        if (
            data.length > RANGE_READ_MAX ||
            (hooks.allowance && !hooks.allowance.take(data.length))
        ) {
            answer({ type: 'fail', id: data.id, message: 'The read was too long.' });
            hooks.onAbuse?.();
            return;
        }
        const release = hooks.hold?.();
        reader
            .read(data.offset, data.length)
            .then((bytes) => {
                // Stopped meanwhile: nothing is copied or sent.
                if (stopped) return;
                // A copy unless the reader's bytes are its own: a memory reader's are a view onto the file.
                const owned =
                    reader.fresh &&
                    bytes.byteOffset === 0 &&
                    bytes.byteLength === bytes.buffer.byteLength &&
                    bytes.buffer instanceof ArrayBuffer
                        ? bytes
                        : bytes.slice();
                const buffer = owned.buffer as ArrayBuffer;
                answer({ type: 'data', id: data.id, bytes: buffer }, [buffer]);
            })
            .catch((error: unknown) =>
                answer({
                    type: 'fail',
                    id: data.id,
                    message: error instanceof Error ? error.message : 'The read failed.',
                }),
            )
            .finally(() => {
                hooks.allowance?.give(data.length);
                release?.();
            });
    };
    function answer(msg: RangeAnswer, transfer: Transferable[] = []) {
        if (!stopped) port.postMessage(msg, transfer);
    }
    return () => {
        stopped = true;
        port.onmessage = null;
        port.close();
    };
}

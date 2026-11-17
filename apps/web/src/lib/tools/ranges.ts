import type { FileReader } from '@hushos/drive/downloads';
import { RANGE_READ_MAX, type RangeAnswer, type RangeRequest } from './protocol';

/*
 * The page's end of a source's range port. The worker asks for a range; the page reads it
 * from the source and transfers a copy, keeping nothing. A Drive file is read through the
 * download engine's `FileReader` (downloads.ts), which fetches and decrypts the 8 MiB chunks
 * a range covers, as the media player's ranges are (`serveMedia` in lib/previews.ts); a
 * small file the page already holds is read from memory.
 */

export type RangeReader = Pick<FileReader, 'size' | 'read'>;

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
 * Answers range reads on `port` from `reader` until the returned stop is called. `hold`
 * marks each read as a wait on the page, so the watchdog leaves it out. A read longer than
 * RANGE_READ_MAX is refused rather than allocated: the worker parses hostile files, and its
 * asks are bounded here, not trusted.
 */
export function serveRanges(port: MessagePort, reader: RangeReader, hold?: () => () => void) {
    let stopped = false;
    port.onmessage = (event: MessageEvent) => {
        const data: unknown = event.data;
        if (stopped) return;
        if (!validRequest(data)) {
            const id = (data as { id?: unknown } | null)?.id;
            if (Number.isSafeInteger(id))
                answer({ type: 'fail', id: id as number, message: 'The read was not valid.' });
            return;
        }
        if (data.length > RANGE_READ_MAX) {
            answer({ type: 'fail', id: data.id, message: 'The read was too long.' });
            return;
        }
        const release = hold?.();
        reader
            .read(data.offset, data.length)
            .then((bytes) => {
                // A copy: the reader's bytes may be a view onto a chunk it keeps, or the file itself.
                const copy = bytes.slice();
                answer({ type: 'data', id: data.id, bytes: copy.buffer }, [copy.buffer]);
            })
            .catch((error: unknown) =>
                answer({
                    type: 'fail',
                    id: data.id,
                    message: error instanceof Error ? error.message : 'The read failed.',
                }),
            )
            .finally(() => release?.());
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

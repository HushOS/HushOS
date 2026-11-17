import type { DriveNode } from '@hushos/drive/client';
import { downloads } from '@/lib/downloads';
import type { RangeReader } from './ranges';

/*
 * A Drive file as a tool's source: the download engine's reader in its tool mode (the file's
 * last chunk and its padding fetched once, at most four times the object fetched in all), two
 * chunks cached, each read's bytes freshly made so they move to the worker without a copy.
 * The run closes it when it ends, which drops its chunks and its key in the crypto worker.
 */
export function driveSource(node: DriveNode): RangeReader {
    const reader = downloads.openReader(node, 2, { tool: true });
    return {
        size: reader.size,
        fresh: true,
        read: (offset, length) => reader.read(offset, length),
        close: () => reader.close(),
    };
}

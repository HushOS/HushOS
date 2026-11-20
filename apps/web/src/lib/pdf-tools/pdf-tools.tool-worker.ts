import { serveTool, ToolError, type RangeSource } from '@/lib/tools/worker';
import { inspectAll } from './inspect';
import { buildPdf, PdfRefused, readPdf, type SourcePdf } from './structure';
import type { PdfToolsInput, PdfToolsSummary } from './protocol';

/*
 * The PDF tools worker for Edit pages (docs/file-tools-design.md, feature (c)): @cantoo/pdf-lib over
 * PDFs read through the page. A tools worker: its file is `*.tool-worker.ts`, so it runs under a
 * policy that names no source (no fetch, no import, no worker of its own), bundled as one file,
 * holding no keys.
 *
 * - `inspect` reads each PDF in turn and says what it is: its pages ("w h r" each), its warnings, or
 *   why it is refused. It produces nothing, and one PDF refused doesn't stop the others.
 * - `build` reads every PDF, then makes each output in turn from the pages planned for it and hands
 *   it back under its name. A refused PDF stops the run with `<reason>:<index>`; an output past
 *   256 MiB with `too-large:<output>`.
 */

/* Each read at most this much, so progress comes as the file arrives and the watchdog hears of it. */
const PIECE = 8 * 1024 * 1024;

async function readWhole(source: RangeSource, onPiece: () => void) {
    const bytes = new Uint8Array(source.size);
    for (let offset = 0; offset < source.size;) {
        const piece = await source.read(offset, Math.min(PIECE, source.size - offset));
        if (piece.byteLength === 0) throw new ToolError('damaged');
        bytes.set(piece, offset);
        offset += piece.byteLength;
        onPiece();
    }
    return bytes;
}

serveTool<PdfToolsInput, PdfToolsSummary>(async (input, context) => {
    const files = context.sources.length;
    let done = 0;
    const tick = (total: number) => context.progress(done, total);

    async function open(index: number, total: number, maxPages?: number) {
        const source = context.sources[index]!;
        let bytes: Uint8Array | null = await readWhole(source, () => tick(total));
        // Read whole: its reader goes now, its chunks and key with it.
        source.close?.();
        try {
            return await readPdf(bytes, { onProgress: () => tick(total), maxPages });
        } finally {
            bytes = null;
        }
    }

    if (input.kind === 'inspect') {
        const sources = await inspectAll(files, (index, maxPages) => open(index, files, maxPages), {
            onDone: () => {
                done++;
                tick(files);
            },
        });
        return { sources };
    }

    const pages = input.outputs.reduce((sum, output) => sum + output.pages.length, 0);
    const total = files + pages;
    const sources: SourcePdf[] = [];
    for (let index = 0; index < files; index++) {
        try {
            sources.push(await open(index, total));
        } catch (error) {
            if (error instanceof PdfRefused) throw new ToolError(`${error.reason}:${index}`);
            throw error;
        }
        done++;
        tick(total);
    }
    for (const [index, output] of input.outputs.entries()) {
        let made: Uint8Array;
        try {
            made = await buildPdf(sources, output.pages, {
                onPage: () => {
                    done++;
                    tick(total);
                },
            });
        } catch (error) {
            if (error instanceof PdfRefused) throw new ToolError(`${error.reason}:${index}`);
            throw error;
        }
        await context.produce(output.name, made, 'application/pdf');
    }
    return { outputs: input.outputs.length };
});

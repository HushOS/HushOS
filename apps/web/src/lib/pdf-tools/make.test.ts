import type { DriveNode } from '@hushos/drive/client';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, test, vi } from 'vitest';

/*
 * What Edit pages signs its results with: the weakest of every PDF the worker was given, never only the
 * PDFs a result's pages were planned from. The page can't tell which PDF a worker's bytes came from, so a
 * result signed from a verified PDF alone could carry an unverified one's content. Split PDFs and images
 * alike; the save run and the workers are stand-ins that record what each result is signed with.
 */

const run = vi.hoisted(() => ({
    file: vi.fn(async (_result: { sources: { node: { id: string } }[] }) => ({})),
    folder: vi.fn(async (_name: string, _options: { sources: { node: { id: string } }[] }) => ({
        id: 'images-folder',
        kind: 'folder',
        workspaceId: 'w1',
    })),
    version: vi.fn(),
    cancel: vi.fn(async () => ({ message: 'Cancelled.', cleanup: 'deleted' })),
}));
vi.mock('@/lib/drive/runs/save-runs', () => ({
    startSaveRun: async () => run,
    RunStopped: class extends Error {},
    SaveRefused: class extends Error {},
}));
vi.mock('@hushos/drive/save-runs', () => ({ endRun: async () => true }));
vi.mock('@/components/drive/dialogs/storage-full-dialog', () => ({ openStorageFull: vi.fn() }));
vi.mock('@/lib/drive/drive', () => ({ nodeSize: () => 1000 }));
const rows = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('@/lib/drive/runs/tool-run-rows', () => ({
    toolRunRows: {
        add: () => ({
            update: (patch: { line?: string }) => patch.line && rows.lines.push(patch.line),
        }),
    },
}));
vi.mock('@/lib/tools/sources', () => ({ driveSource: () => ({}) }));
vi.mock('@/lib/viewers/pdf-assets', () => ({ pdfAssetFiles: async () => ({}) }));
/* A worker that hands back every result it was asked for, by name, then is done. */
vi.mock('@/lib/tools/run', () => ({
    ToolCancelled: class extends Error {},
    startToolRun: (options: {
        input: { outputs?: { name: string }[]; names?: string[] };
        onOutput: (output: unknown) => void;
    }) => {
        const pdf = options.input.outputs?.map((output) => output.name);
        const names = pdf ?? options.input.names ?? [];
        const result = Promise.resolve().then(() => {
            for (const name of names)
                options.onOutput({
                    name,
                    mime: pdf ? 'application/pdf' : 'image/png',
                    bytes: new ArrayBuffer(4),
                    size: 4,
                    release: () => {},
                });
            return {};
        });
        return {
            result,
            cancel: () => {},
            getState: () => ({ status: 'running', done: 0, total: null }),
            subscribe: () => () => {},
        };
    },
}));

const folder = { id: 'f1', kind: 'folder', workspaceId: 'w1' } as unknown as DriveNode;
const pdf = (id: string) =>
    ({
        id,
        kind: 'file',
        name: `${id}.pdf`,
        parentId: 'f1',
        workspaceId: 'w1',
    }) as unknown as DriveNode;
const verified = pdf('verified');
const unverified = pdf('unverified');
const signers = (call: { sources: { node: { id: string } }[] }) =>
    call.sources.map((source) => source.node.id).sort();

beforeEach(() => {
    run.file.mockClear();
    run.folder.mockClear();
    rows.lines.length = 0;
});

test('split PDFs whose pages are all from one PDF are signed as the weakest of both PDFs read', async () => {
    const { savePdfPages } = await import('./make');
    const page = (index: number) => ({ source: 0, page: index, rotate: 0 as const });
    await savePdfPages(new QueryClient(), {
        folder,
        folderName: 'Docs',
        sources: [verified, unverified],
        kind: 'files',
        outputs: [
            { name: 'verified (page 1).pdf', pages: [page(0)], thumbnail: null },
            { name: 'verified (page 2).pdf', pages: [page(1)], thumbnail: null },
        ],
    });
    expect(rows.lines.at(-1)).toBe('Saved in Docs');
    expect(run.file).toHaveBeenCalledTimes(2);
    for (const [call] of run.file.mock.calls)
        expect(signers(call)).toEqual(['unverified', 'verified']);
});

test('images of one PDF’s pages are signed as the weakest of every PDF read, and so is their folder', async () => {
    const { savePdfPages } = await import('./make');
    await savePdfPages(new QueryClient(), {
        folder,
        folderName: 'Docs',
        sources: [verified, unverified],
        kind: 'images',
        pages: [{ source: 0, page: 0, rotate: 0 }],
        sizes: [{ width: 612, height: 792, rotate: 0 }],
        format: 'png',
        dpi: 150,
        imagesFolder: 'verified (images)',
        names: ['page 001.png'],
    });
    expect(rows.lines.at(-1)).toBe('Saved in Docs');
    expect(signers(run.folder.mock.calls[0]![1])).toEqual(['unverified', 'verified']);
    expect(run.file).toHaveBeenCalledTimes(1);
    expect(signers(run.file.mock.calls[0]![0])).toEqual(['unverified', 'verified']);
});

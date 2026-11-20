import type { DriveNode } from '@hushos/drive/client';
import { THUMBNAIL_MAX_BYTES } from '@hushos/drive/protocol';
import { endRun, type PlannedResult, type SaveRun } from '@hushos/drive/save-runs';
import type { QueryClient } from '@tanstack/react-query';
import { openStorageFull } from '@/components/drive/dialogs/storage-full-dialog';
import { nodeSize } from '@/lib/drive/drive';
import { RunStopped, SaveRefused, startSaveRun } from '@/lib/drive/runs/save-runs';
import { toolRunRows, type RunRow } from '@/lib/drive/runs/tool-run-rows';
import { TOOL_FAILED } from '@/lib/tools/protocol';
import {
    startToolRun,
    ToolCancelled,
    type ToolOutput,
    type ToolRun,
    type ToolRunState,
} from '@/lib/tools/run';
import { driveSource } from '@/lib/tools/sources';
import {
    IMAGES_MAX_PAGES,
    PDF_MAX_BYTES,
    PDF_TOOLS_MAX_FILES,
    PDF_TOOLS_MAX_PAGES,
    parsePages,
    type PageInfo,
    type PagePlan,
    type PdfFlags,
    type PdfToolsInput,
    type PdfToolsSummary,
    type RenderInput,
    type RenderSummary,
} from './protocol';
import { THUMBNAIL } from '@/lib/images-pdf/protocol';
import { MIXED_FOLDERS } from './names';
import { imagesPlan, OutputLedger, OutputMismatch, sourcesFor } from './outputs';

/*
 * Edit pages on the page (docs/file-tools-design.md, feature (c)).
 *
 * - **Inspecting** is a viewer's look in the PDF tools worker (pdf-lib), beside any run: each PDF's
 *   pages, its warnings, or why it is refused. The dialog draws thumbnails with pdf.js meanwhile.
 * - **Saving** is a save run (room checked and its record written before anything is made), then a
 *   tool run: pdf-lib builds each output from the pages planned for it, which is saved as a new
 *   version of the one PDF (stale when someone else saved first: nothing is published) or as new
 *   files under the next free names, each signed as the weakest of the PDFs its pages came from.
 * - **Save as images** is a save run that makes the "<name> (images)" folder first, then a tool run
 *   in the page renderer (pdf.js), each page's image saved into that folder as it comes.
 *
 * Each runs as a row in the transfers panel; Cancel, a refusal, a lock or a sign-out leaves nothing
 * (the save run deletes what it published; a new version that landed is kept, and said so).
 */

export function pdfToolsWorker() {
    return new Worker(new URL('./pdf-tools.tool-worker.ts', import.meta.url), {
        type: 'module',
        name: 'pdf-tools',
    });
}

export function pdfRenderWorker() {
    return new Worker(new URL('./pdf-render.worker.ts', import.meta.url), {
        type: 'module',
        name: 'pdf-render',
    });
}

export type Inspected =
    | { ok: true; pages: PageInfo[]; flags: PdfFlags }
    | { ok: false; reason: 'encrypted' | 'damaged' | 'too-many-pages' };

/*
 * What each PDF is, read by pdf-lib in the tools worker. `cancel` stops the look (the dialog closed).
 * The worker's summary is checked here, entry by entry; anything out of shape fails the look.
 */
export function inspectPdfs(nodes: readonly DriveNode[]) {
    const run = startToolRun<PdfToolsInput, PdfToolsSummary>({
        label: `Reading ${nodes.length === 1 ? 'a PDF' : `${nodes.length} PDFs`}`,
        worker: pdfToolsWorker,
        input: { kind: 'inspect' },
        sources: nodes.map(driveSource),
        viewer: true,
        maxOutputs: 1,
        maxTotalBytes: 1,
        refusals: { 'too-many-pages-together': TOO_MANY_TOGETHER },
    });
    const result = run.result.then((summary): Inspected[] => {
        const sources = (summary as { sources?: unknown }).sources;
        if (!Array.isArray(sources) || sources.length !== nodes.length)
            throw new Error(TOOL_FAILED);
        return sources.map((source: Record<string, unknown>) => {
            if (source?.ok === false) {
                const reason = source.reason;
                if (reason !== 'encrypted' && reason !== 'damaged' && reason !== 'too-many-pages')
                    throw new Error(TOOL_FAILED);
                return { ok: false, reason };
            }
            const pages = parsePages(source?.pages);
            const flags = [source?.signed, source?.outline, source?.form];
            if (source?.ok !== true || !pages || flags.some((flag) => typeof flag !== 'boolean'))
                throw new Error(TOOL_FAILED);
            return {
                ok: true,
                pages,
                flags: {
                    signed: source.signed as boolean,
                    outline: source.outline as boolean,
                    form: source.form as boolean,
                },
            };
        });
    });
    return { result, cancel: () => run.cancel() };
}

export const TOO_MANY_TOGETHER = `These PDFs have more than ${PDF_TOOLS_MAX_PAGES.toLocaleString('en')} pages together, too many to edit here.`;

/* The person's words for a refused PDF: one alone, or one of several by its name. */
export function refusalWords(
    reason: 'encrypted' | 'damaged' | 'too-many-pages',
    name: string | null,
): string {
    if (reason === 'encrypted')
        return name
            ? `“${name}” has a password. Remove it in another app, then try again.`
            : 'This PDF has a password. Remove it in another app, then try again.';
    if (reason === 'too-many-pages')
        return `${name ? `“${name}”` : 'This PDF'} has more than ${PDF_TOOLS_MAX_PAGES.toLocaleString('en')} pages, too many to edit here.`;
    return name
        ? `“${name}” is damaged, or isn’t something HushOS can read.`
        : 'This PDF is damaged, or isn’t something HushOS can read.';
}

/* The person's words for each refusal the workers may send, by PDF and by output. */
export function buildRefusals(
    sources: readonly string[],
    outputs: readonly string[],
): Record<string, string> {
    const words: Record<string, string> = {};
    sources.forEach((name, index) => {
        const named = sources.length > 1 ? name : null;
        for (const reason of ['encrypted', 'damaged', 'too-many-pages'] as const)
            words[`${reason}:${index}`] = refusalWords(reason, named);
    });
    outputs.forEach((name, index) => {
        words[`too-large:${index}`] =
            `“${name}” would be larger than 256 MB. Split it into smaller files.`;
    });
    return words;
}

export type PdfOutput = {
    name: string;
    pages: PagePlan[];
    /* Its first page drawn small, when the dialog could; saved as the file's thumbnail. */
    thumbnail: Uint8Array | null;
};

export type PdfPagesJob = {
    folder: DriveNode;
    /* The folder as the person knows it ("My files" for their own top folder). */
    folderName: string;
    sources: DriveNode[];
} & (
    | /* A new version of the one PDF, from the version the dialog read. */ {
          kind: 'version';
          output: PdfOutput;
          startedFrom: string | null;
      }
    | /* New files: one (edited, or merged) or one a range (split). */ {
          kind: 'files';
          outputs: PdfOutput[];
      }
    | {
          kind: 'images';
          pages: PagePlan[];
          /* The pages' sizes, as inspected, for the room estimate. */
          sizes: PageInfo[];
          format: 'png' | 'jpeg';
          dpi: 150 | 300;
          /* The new folder's name, "<name> (images)"; the next free one in the folder. */
          imagesFolder: string;
          names: string[];
      }
);

/* What a version that lost a race says: nothing published, and what to do. */
export const STALE = (name: string) =>
    `Someone saved a newer version of “${name}” first, so nothing was saved. Edit its pages again.`;

const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

/* The PDFs a set of pages came from, as the save path signs them (the weakest of them). */
function sourcesOf(job: PdfPagesJob, pages: readonly PagePlan[]) {
    return sourcesFor(job.sources, pages);
}

function titleOf(job: PdfPagesJob) {
    const first = job.sources[0]!.name;
    if (job.kind === 'images') return `Saving ${first} as images`;
    if (job.kind === 'version') return `Saving ${first}`;
    if (job.outputs.length === 1) return `Making ${job.outputs[0]!.name}`;
    return `Splitting ${first}`;
}

/*
 * Starts the save; its row in the transfers panel says how it goes. Resolves once it has ended,
 * however it ended; never throws.
 */
export async function savePdfPages(queryClient: QueryClient, job: PdfPagesJob) {
    let cancelled = false;
    let save: SaveRun | null = null;
    let tool: { cancel(): void } | null = null;
    const images = job.kind === 'images';
    const row = toolRunRows.add(
        {
            title: titleOf(job),
            cancelQuestion: images ? 'Stop saving the images?' : 'Stop saving the pages?',
            cancelWarning: 'What was made so far is deleted.',
            phase: 'making',
            line: 'Starting',
            progress: null,
            uploadId: null,
        },
        () => {
            if (cancelled) return;
            cancelled = true;
            row.update({ phase: 'stopping', line: 'Stopping' });
            tool?.cancel();
            void save?.cancel();
        },
    );
    const total = job.sources.reduce((sum, node) => sum + (nodeSize(node) ?? 0), 0);
    // Set when a worker hands back what it wasn't asked for: the save stops, as a failure.
    let mismatch = false;
    try {
        if (job.sources.length === 0 || job.sources.length > PDF_TOOLS_MAX_FILES)
            throw new Error(TOOL_FAILED);
        if (
            job.sources.some(
                (node) =>
                    node.parentId !== job.folder.id || node.workspaceId !== job.folder.workspaceId,
            )
        )
            throw new Error(MIXED_FOLDERS);
        const saving: Promise<unknown>[] = [];
        // Every save that failed is heard where it settles, below; none is left unheard meanwhile.
        const track = <T>(promise: Promise<T>) => {
            saving.push(promise);
            promise.catch(() => {});
            return promise;
        };
        let stale = false;
        if (job.kind === 'images') {
            if (job.pages.length === 0 || job.pages.length > IMAGES_MAX_PAGES)
                throw new Error(TOOL_FAILED);
            // Every page's size first: one too large to draw is refused before anything is reserved or made.
            const results: PlannedResult[] = imagesPlan(job.pages, job.sizes, job.dpi).map(
                // A guess, as conversion's is: a PNG of a page is rarely more than a byte a pixel.
                (size) => ({
                    size: Math.ceil(size.width * size.height * (job.format === 'png' ? 1 : 0.3)),
                }),
            );
            save = await startSaveRun(queryClient, { targets: [job.folder], results });
            if (cancelled) throw new ToolCancelled();
            const run = save;
            const into = await run.folder(job.imagesFolder, {
                into: job.folder,
                sources: sourcesOf(job, job.pages),
            });
            if (cancelled) throw new ToolCancelled();
            let thumbnail: Uint8Array | null = null;
            const count = job.pages.length;
            const mime = job.format === 'png' ? 'image/png' : 'image/jpeg';
            const ledger = new OutputLedger(job.names, mime);
            const render = startToolRun<RenderInput, RenderSummary>({
                label: titleOf(job),
                worker: pdfRenderWorker,
                input: {
                    pages: job.pages,
                    format: job.format,
                    dpi: job.dpi,
                    names: job.names,
                    thumbnail: { edge: 512, maxBytes: THUMBNAIL_MAX_BYTES },
                },
                sources: job.sources.map(driveSource),
                maxOutputs: count * 2,
                maxTotalBytes: count * (PDF_MAX_BYTES + THUMBNAIL_MAX_BYTES),
                refusals: renderRefusals(
                    job.sources.map((node) => node.name),
                    count,
                ),
                onOutput: (output) => {
                    if (output.name === THUMBNAIL) {
                        if (output.mime === 'image/webp' && output.size <= THUMBNAIL_MAX_BYTES)
                            thumbnail = new Uint8Array(output.bytes).slice();
                        output.release();
                        return;
                    }
                    let index: number;
                    try {
                        index = ledger.take(output.name, output.mime);
                    } catch {
                        output.release();
                        mismatch = true;
                        tool?.cancel();
                        return;
                    }
                    const own = thumbnail;
                    thumbnail = null;
                    void track(
                        run
                            .file({
                                name: output.name,
                                bytes: new Uint8Array(output.bytes),
                                mime,
                                // Signed by its own PDF, never the weakest of every PDF in the run.
                                sources: sourcesOf(job, [job.pages[index]!]),
                                thumbnail: own,
                                into,
                            })
                            .finally(() => output.release()),
                    );
                },
            });
            tool = render;
            await follow(render, row, () => cancelled, count, 'page');
            ledger.complete();
        } else {
            const outputs = job.kind === 'version' ? [job.output] : job.outputs;
            const pageCount = outputs.reduce((sum, output) => sum + output.pages.length, 0);
            if (pageCount === 0 || outputs.some((output) => output.pages.length === 0))
                throw new Error(TOOL_FAILED);
            const results: PlannedResult[] = outputs.map((output) => ({
                // Each output's share of the sources, by its pages; a whole PDF is all of them.
                sourcesSize: Math.max(1, Math.ceil((total * output.pages.length) / pageCount)),
            }));
            save = await startSaveRun(queryClient, {
                targets: [job.kind === 'version' ? job.sources[0]! : job.folder],
                results,
            });
            if (cancelled) throw new ToolCancelled();
            const run = save;
            const names = outputs.map((output) => output.name);
            const ledger = new OutputLedger(names, 'application/pdf');
            const build = startToolRun<PdfToolsInput, PdfToolsSummary>({
                label: titleOf(job),
                worker: pdfToolsWorker,
                input: {
                    kind: 'build',
                    outputs: outputs.map(({ name, pages }) => ({ name, pages })),
                },
                sources: job.sources.map(driveSource),
                maxOutputs: outputs.length,
                maxTotalBytes: outputs.length * PDF_MAX_BYTES,
                refusals: buildRefusals(
                    job.sources.map((node) => node.name),
                    names,
                ),
                onOutput: (output: ToolOutput) => {
                    // In order, each named as asked, a PDF: anything else stops the save.
                    let index: number;
                    try {
                        index = ledger.take(output.name, output.mime);
                    } catch {
                        output.release();
                        mismatch = true;
                        tool?.cancel();
                        return;
                    }
                    const planned = outputs[index]!;
                    const bytes = new Uint8Array(output.bytes);
                    if (job.kind === 'version') {
                        const file = job.sources[0]!;
                        void track(
                            run
                                .version({
                                    file,
                                    folder: job.folder,
                                    startedFrom: job.startedFrom,
                                    bytes,
                                    sources: sourcesOf(job, planned.pages),
                                    mime: 'application/pdf',
                                    thumbnail: planned.thumbnail,
                                })
                                .then((saved) => {
                                    if (saved.status === 'stale') stale = true;
                                })
                                .finally(() => output.release()),
                        );
                        return;
                    }
                    void track(
                        run
                            .file({
                                name: planned.name,
                                bytes,
                                mime: 'application/pdf',
                                sources: sourcesOf(job, planned.pages),
                                thumbnail: planned.thumbnail,
                                into: job.folder,
                                onQueued: (uploadId) =>
                                    outputs.length === 1 ? row.update({ uploadId }) : undefined,
                            })
                            .finally(() => output.release()),
                    );
                },
            });
            tool = build;
            await follow(build, row, () => cancelled, pageCount, 'page', job.sources.length);
            ledger.complete();
        }
        row.update({ phase: 'saving', line: 'Saving', progress: null });
        await Promise.all(saving);
        if (stale) {
            await endRun(save);
            row.update({ phase: 'failed', line: STALE(job.sources[0]!.name), progress: null });
            return;
        }
        // Saved either way: a record this device wouldn't retire only means the next open asks about it.
        const retired = await endRun(save);
        const where =
            job.kind === 'version' ? 'Saved as a new version' : `Saved in ${job.folderName}`;
        row.update({
            phase: 'done',
            line: retired ? where : `${where}. You may be asked about it next time.`,
            progress: null,
        });
    } catch (error) {
        tool?.cancel();
        const stopped = save ? await save.cancel().catch(() => null) : null;
        if (error instanceof SaveRefused && error.reason === 'no-room' && error.room)
            openStorageFull();
        row.update({
            phase: 'failed',
            line: failureWords(mismatch ? new OutputMismatch() : error, stopped, cancelled),
            progress: null,
        });
    }
}

/* Follows a tool run in its row until it ends; rejects as it does. */
async function follow(
    run: ToolRun<unknown>,
    row: { update: (patch: Partial<Omit<RunRow, 'id'>>) => void },
    cancelled: () => boolean,
    count: number,
    unit: 'page',
    reading = 0,
) {
    const show = (state: ToolRunState) => {
        if (cancelled()) return;
        if (state.status === 'waiting')
            row.update({ phase: 'waiting', line: `Waiting for ${lower(state.behind)} to finish` });
        if (state.status === 'running') {
            const done = Math.max(0, Math.min(count, state.done - reading));
            row.update({
                phase: 'making',
                line: `${done} of ${count} ${count === 1 ? unit : `${unit}s`}`,
                progress: { value: state.done, max: state.total ?? count + reading },
            });
        }
    };
    show(run.getState());
    const stop = run.subscribe(show);
    try {
        await run.result;
    } finally {
        stop();
    }
}

function renderRefusals(sources: readonly string[], pages: number): Record<string, string> {
    const words: Record<string, string> = {};
    sources.forEach((name, index) => {
        words[`damaged:${index}`] = refusalWords('damaged', sources.length > 1 ? name : null);
    });
    for (let index = 0; index < pages; index++)
        words[`too-many-pixels:${index}`] =
            `Page ${index + 1} is too large to save as an image at this resolution. Choose 150 dpi, or fewer pages.`;
    return words;
}

function failureWords(error: unknown, stopped: RunStopped | null, cancelled: boolean) {
    if (error instanceof OutputMismatch)
        return stopped?.cleanup === 'left' ? stopped.message : TOOL_FAILED;
    if (error instanceof RunStopped) return error.message;
    if (error instanceof SaveRefused) return error.message;
    // The run's clean-up says it all when it couldn't finish, or when the run was asked to stop.
    if (stopped && (cancelled || error instanceof ToolCancelled || stopped.cleanup === 'left'))
        return stopped.message;
    if (cancelled || error instanceof ToolCancelled) return 'Cancelled. Nothing was saved.';
    return error instanceof Error && error.message ? error.message : TOOL_FAILED;
}

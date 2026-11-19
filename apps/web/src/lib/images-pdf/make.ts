import type { NodeView } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { THUMBNAIL_MAX_BYTES } from '@hushos/drive/protocol';
import { endRun, type SaveRun } from '@hushos/drive/save-runs';
import type { QueryClient } from '@tanstack/react-query';
import { openStorageFull } from '@/components/drive/storage-full-dialog';
import { nodeSize } from '@/lib/drive';
import { RunStopped, SaveRefused, startSaveRun } from '@/lib/save-runs';
import { toolRunRows } from '@/lib/tool-run-rows';
import { TOOL_FAILED } from '@/lib/tools/protocol';
import { startToolRun, ToolCancelled, type ToolRun } from '@/lib/tools/run';
import { driveSource } from '@/lib/tools/sources';
import type { PageSize } from './geometry';
import { PDF_MAX_BYTES, THUMBNAIL, type ImagesPdfInput, type ImagesPdfSummary } from './protocol';

/*
 * One PDF on the page (docs/file-tools-design.md, feature (b)): a save run into the folder (room
 * checked and the run's record written before anything is made), then a tool run in the PDF
 * worker over the images in the order chosen, its PDF saved as a new file under the next free
 * name, signed as the weakest of the images. It runs as a row in the transfers panel; Cancel, a
 * refusal, a lock or a sign-out leaves nothing (the save run deletes what it published).
 */

export type ImagesPdfJob = {
    folder: DriveNode;
    /* The folder as the person knows it ("My files" for their own top folder). */
    folderName: string;
    images: DriveNode[];
    size: PageSize;
    margin: boolean;
    name: string;
};

const THUMBNAIL_EDGE = 512;

/* Images from more than one folder (search results can hold them): refused, never converted in part. */
export const MIXED_FOLDERS =
    'These images are in different folders. Make a PDF from one folder at a time.';

/* The person's words for each refusal the worker may send, image by image. */
export function imagesPdfRefusals(names: readonly string[]): Record<string, string> {
    const words: Record<string, string> = {
        'too-large': 'The PDF would be larger than 256 MB. Choose fewer images.',
    };
    names.forEach((name, index) => {
        words[`damaged:${index}`] =
            `“${name}” is damaged, or isn’t an image HushOS can put in a PDF.`;
        words[`unsupported:${index}`] = `“${name}” is a kind of JPEG HushOS can’t put in a PDF.`;
        words[`heic:${index}`] =
            `This browser can’t open HEIC photos such as “${name}”. Use Safari, or HushOS on your phone.`;
        words[`too-many-pixels:${index}`] = `“${name}” is too large to put in a PDF here.`;
        words[`too-large-to-decode:${index}`] =
            `“${name}” is too large to convert here. Save it as a JPEG or PNG first.`;
    });
    return words;
}

export function imagesPdfWorker() {
    return new Worker(new URL('./images-pdf.tool-worker.ts', import.meta.url), {
        type: 'module',
        name: 'images-pdf',
    });
}

/*
 * Starts One PDF; its row in the transfers panel says how it goes. Resolves once it has ended,
 * however it ended; never throws.
 */
export async function makeImagesPdf(queryClient: QueryClient, job: ImagesPdfJob) {
    let cancelled = false;
    let save: SaveRun | null = null;
    let tool: ToolRun<ImagesPdfSummary> | null = null;
    const row = toolRunRows.add(
        {
            title: `Making ${job.name}`,
            cancelQuestion: 'Stop making the PDF?',
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
    const total = job.images.reduce((sum, node) => sum + (nodeSize(node) ?? 0), 0);
    try {
        // The PDF goes beside its images: all of them in this one folder, or none is converted.
        if (
            job.images.some(
                (node) =>
                    node.parentId !== job.folder.id || node.workspaceId !== job.folder.workspaceId,
            )
        )
            throw new Error(MIXED_FOLDERS);
        save = await startSaveRun(queryClient, {
            targets: [job.folder],
            results: [{ sourcesSize: total }],
        });
        if (cancelled) throw new ToolCancelled();
        const sources = job.images.map((node) => ({ node, source: 'drive' as const }));
        let thumbnail: Uint8Array | null = null;
        // Set by onOutput, below: a cast, so the checker doesn't take it for null forever.
        let saving = null as Promise<NodeView | null> | null;
        const run = save;
        tool = startToolRun<ImagesPdfInput, ImagesPdfSummary>({
            label: `Making ${job.name}`,
            worker: imagesPdfWorker,
            input: {
                name: job.name,
                size: job.size,
                margin: job.margin,
                thumbnail: { edge: THUMBNAIL_EDGE, maxBytes: THUMBNAIL_MAX_BYTES },
            },
            sources: job.images.map(driveSource),
            maxOutputs: 2,
            maxTotalBytes: PDF_MAX_BYTES + THUMBNAIL_MAX_BYTES,
            refusals: imagesPdfRefusals(job.images.map((node) => node.name)),
            onOutput: (output) => {
                // The thumbnail comes first, if at all: small, a JPEG, kept as a copy.
                if (output.name === THUMBNAIL && !saving) {
                    if (output.mime === 'image/jpeg' && output.size <= THUMBNAIL_MAX_BYTES)
                        thumbnail = new Uint8Array(output.bytes).slice();
                    output.release();
                    return;
                }
                if (saving || output.mime !== 'application/pdf') {
                    output.release();
                    return;
                }
                row.update({ phase: 'saving', line: 'Saving', progress: null });
                saving = run
                    .file({
                        name: job.name,
                        bytes: new Uint8Array(output.bytes),
                        mime: 'application/pdf',
                        sources,
                        thumbnail,
                        into: job.folder,
                        onQueued: (uploadId) => row.update({ uploadId }),
                    })
                    .finally(() => output.release());
                // Heard once it settles below; a rejection here is never left unheard.
                saving.catch(() => {});
            },
        });
        const images = job.images.length;
        tool.subscribe((state) => {
            if (cancelled) return;
            if (state.status === 'waiting')
                row.update({
                    phase: 'waiting',
                    line: `Waiting for ${lower(state.behind)} to finish`,
                });
            if (state.status === 'running' && !saving) {
                const done = Math.min(state.done, images);
                row.update({
                    phase: 'making',
                    line: `${done} of ${images} ${images === 1 ? 'image' : 'images'}`,
                    progress: { value: state.done, max: state.total ?? images + 1 },
                });
            }
        });
        await tool.result;
        if (!saving) throw new Error(TOOL_FAILED);
        await saving;
        if (!(await endRun(save)))
            throw new Error('This device couldn’t keep a record of this save.');
        row.update({ phase: 'done', line: `Saved in ${job.folderName}`, progress: null });
    } catch (error) {
        tool?.cancel();
        const stopped = save ? await save.cancel().catch(() => null) : null;
        if (error instanceof SaveRefused && error.reason === 'no-room' && error.room)
            openStorageFull();
        row.update({
            phase: 'failed',
            line: failureWords(error, stopped, cancelled),
            progress: null,
            uploadId: null,
        });
    }
}

function failureWords(error: unknown, stopped: RunStopped | null, cancelled: boolean) {
    if (error instanceof RunStopped) return error.message;
    if (error instanceof SaveRefused) return error.message;
    // The run's clean-up says it all when it couldn't finish, or when the run was asked to stop.
    if (stopped && (cancelled || error instanceof ToolCancelled || stopped.cleanup === 'left'))
        return stopped.message;
    if (cancelled || error instanceof ToolCancelled) return 'Cancelled. Nothing was saved.';
    return error instanceof Error && error.message ? error.message : TOOL_FAILED;
}

const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

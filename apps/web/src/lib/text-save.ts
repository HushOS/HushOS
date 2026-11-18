import type { NodeView } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { OWN_WRITING, type RunPlan, type SaveRun } from '@hushos/drive/save-runs';
import { encodeText } from '@/lib/text-edit';

/*
 * The text editor's save (docs/editing-design.md section 3; Editing 1a):
 * through the save path's two modes (lib/save-runs.ts), never a second one.
 *
 * - Save: a new version of the file, from the version the editor opened. If
 *   someone else's version is current, nothing is published and the editor
 *   offers the stale choices:
 * - Save on top: a new version after theirs (both stay in history), the same
 *   save started from the version that is current now.
 * - Save as a copy: a new file beside it under the next free name, signed as
 *   its source is (an Unverified file's copy stays Unverified).
 * - Open theirs: nothing is saved; the editor discards its text after a
 *   confirmation and opens the current version.
 *
 * The bytes are the editor's text as UTF-8, exactly (lib/text-edit.ts), and
 * the run is planned for that many bytes with no thumbnail, so the room check
 * before anything is made is the save's real size.
 */

export type StartRun = (plan: RunPlan) => Promise<SaveRun>;

export type TextSaved =
    /*
     * `versionId`: the version this save published, by the upload's own id; null when the save
     * path couldn't say, and then the next save asks the stale question rather than assume.
     */
    | { status: 'saved'; versionId: string | null }
    /* Someone else's version is current (null: the file is gone from its folder). */
    | { status: 'stale'; currentVersionId: string | null };

/* A save's folder and file as the editor asks for them: the folder's listing, as the app reads it. */
export type FolderListing = { folder: DriveNode; children: DriveNode[] };

/*
 * The file's folder and the file itself in a listing asked for by the file's own folder and
 * workspace, or a throw when the listing answers for another folder: a save never goes into a
 * folder the editor didn't open the file from. The file is the row with its id in that same
 * workspace and folder, or null when it is no longer there.
 */
export function editTargetOf(listing: FolderListing, file: DriveNode) {
    const folder = listing.folder;
    if (
        folder.id !== file.parentId ||
        folder.workspaceId !== file.workspaceId ||
        folder.kind !== 'folder'
    )
        throw new Error(
            'HushOS answered with a different folder than this file’s. Nothing was saved.',
        );
    const listed =
        listing.children.find(
            (child) =>
                child.id === file.id &&
                child.workspaceId === file.workspaceId &&
                child.parentId === folder.id &&
                child.kind === 'file',
        ) ?? null;
    return { folder, file: listed };
}

/* Tries before a run whose record this device wouldn't update is let go of (its result is kept). */
const FINISH_TRIES = 3;
const FINISH_PAUSE_MS = 250;

/*
 * Ends a run whose result is in: its record goes, its lock and its listener with it. A record this
 * device wouldn't update is asked again (never the upload); past the tries the run is cancelled,
 * which keeps a version that landed and lets everything else go, and its row is settled at the next
 * open. Never throws: what was saved stays saved.
 */
export async function endRun(run: SaveRun, pause = (ms: number) => sleep(ms)) {
    for (let attempt = 1; attempt <= FINISH_TRIES; attempt++) {
        try {
            await run.finish();
            return true;
        } catch {
            if (attempt < FINISH_TRIES) await pause(FINISH_PAUSE_MS * attempt);
        }
    }
    await run.cancel().catch(() => {});
    return false;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* A new version of `file` holding `text`, unless the file moved on from `startedFrom`. */
export async function saveVersion(
    start: StartRun,
    edit: { file: DriveNode; folder: DriveNode; startedFrom: string | null; text: string },
    pause?: (ms: number) => Promise<void>,
): Promise<TextSaved> {
    const bytes = encodeText(edit.text);
    const run = await start({
        targets: [edit.file],
        results: [{ size: bytes.byteLength, thumbnail: false }],
    });
    const saved = await run.version({
        file: edit.file,
        folder: edit.folder,
        startedFrom: edit.startedFrom,
        bytes,
        sources: OWN_WRITING,
        mime: edit.file.metadata?.mime ?? null,
    });
    await endRun(run, pause);
    if (saved.status === 'stale') return saved;
    return { status: 'saved', versionId: saved.versionId };
}

/* A new file beside `file` in `folder`, under the next free name, holding `text`. */
export async function saveCopy(
    start: StartRun,
    edit: { file: DriveNode; folder: DriveNode; text: string },
    pause?: (ms: number) => Promise<void>,
): Promise<NodeView | null> {
    const bytes = encodeText(edit.text);
    const run = await start({
        targets: [edit.folder],
        results: [{ size: bytes.byteLength, thumbnail: false }],
    });
    const made = await run.file({
        name: edit.file.name,
        bytes,
        mime: edit.file.metadata?.mime ?? null,
        sources: [{ node: edit.file, source: 'drive' }],
        into: edit.folder,
    });
    await endRun(run, pause);
    return made;
}

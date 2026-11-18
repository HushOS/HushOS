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
    | { status: 'saved'; versionId: string | null }
    /* Someone else's version is current (null: the file is gone from its folder). */
    | { status: 'stale'; currentVersionId: string | null };

/* A new version of `file` holding `text`, unless the file moved on from `startedFrom`. */
export async function saveVersion(
    start: StartRun,
    edit: { file: DriveNode; folder: DriveNode; startedFrom: string | null; text: string },
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
    // The run's record goes once its only result is in, saved or not. A record this device couldn't
    // update stays for the next open, which finds nothing to delete: what was saved is kept.
    await run.finish().catch(() => {});
    if (saved.status === 'stale') return saved;
    return { status: 'saved', versionId: saved.node?.currentVersion?.id ?? null };
}

/* A new file beside `file` in `folder`, under the next free name, holding `text`. */
export async function saveCopy(
    start: StartRun,
    edit: { file: DriveNode; folder: DriveNode; text: string },
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
    await run.finish().catch(() => {});
    return made;
}

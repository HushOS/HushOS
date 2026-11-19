import type { NodeView } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import type { NodeIntegrity } from '@hushos/drive/trust';
import { endRun, OWN_WRITING, type RunPlan, type SaveRun } from '@hushos/drive/save-runs';

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
 * The bytes are the editor's text in the file's own encoding, byte order mark
 * and line breaks (saveBytes in lib/text-edit.ts), and the run is planned for
 * that many bytes with no thumbnail, so the room check before anything is made
 * is the save's real size.
 */

export type StartRun = (plan: RunPlan) => Promise<SaveRun>;

/*
 * `stillOn`: whether the editor session this save began in is still the one on screen (not closed,
 * not discarded, the same account session), asked last thing before the run starts; `pause`: the
 * wait between tries to retire the run's record.
 */
export type SaveOptions = { stillOn?: () => boolean; pause?: (ms: number) => Promise<void> };

/* The save's session ended before its run started: nothing was uploaded. */
export class SessionEnded extends Error {
    constructor() {
        super('This editor was closed before the save started.');
        this.name = 'SessionEnded';
    }
}

export type TextSaved =
    /*
     * `versionId`: the version this save published, by the upload's own id; null when the save
     * path couldn't say, and then the next save asks the stale question rather than assume.
     */
    | { status: 'saved'; versionId: string | null }
    /* Someone else's version is current (null: the file is gone from its folder). */
    | { status: 'stale'; currentVersionId: string | null };

/*
 * What the editor writes to and what its text came from. `file`: where the next save goes (the
 * opened file, or the copy saved last); `startedFrom`: the version that save replaces; `source`:
 * the row the text's bytes were read from, whose checks sign a copy (an Unverified file's copy stays
 * Unverified). Only opening a version sets `source`: a save or a copy moves `file` on, and a listing
 * of the file written to never stands in for it (that row may already carry someone else's version).
 */
export type EditTarget = { file: DriveNode; startedFrom: string | null; source: DriveNode };

/* A version just opened: written to, started from and signed from as it was read. */
export function openedTarget(file: DriveNode): EditTarget {
    return { file, startedFrom: file.currentVersion?.id ?? null, source: file };
}

/* After a save or a copy landed as `versionId` of `file`: written there next, from that version, signed as before. */
export function savedTarget(
    before: EditTarget,
    file: DriveNode,
    versionId: string | null,
): EditTarget {
    return { file, startedFrom: versionId, source: before.source };
}

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

/* A new version of `file` holding `bytes`, unless the file moved on from `startedFrom`. */
export async function saveVersion(
    start: StartRun,
    edit: { file: DriveNode; folder: DriveNode; startedFrom: string | null; bytes: Uint8Array },
    { stillOn = () => true, pause }: SaveOptions = {},
): Promise<TextSaved> {
    const bytes = edit.bytes;
    if (!stillOn()) throw new SessionEnded();
    const run = await start({
        targets: [edit.file],
        results: [{ size: bytes.byteLength, thumbnail: false }],
    });
    // Starting waited (the room check, the run's lock, its record): asked again before any byte goes.
    if (!stillOn()) {
        await endRun(run, pause ? { pause } : {});
        throw new SessionEnded();
    }
    const saved = await run.version({
        file: edit.file,
        folder: edit.folder,
        startedFrom: edit.startedFrom,
        bytes,
        sources: OWN_WRITING,
        mime: edit.file.metadata?.mime ?? null,
    });
    await endRun(run, pause ? { pause } : {});
    if (saved.status === 'stale') return saved;
    return { status: 'saved', versionId: saved.versionId };
}

/* A copy saved: the new file as its reply row came, and the version it published, as minted. */
export type TextCopy = { node: NodeView | null; versionId: string | null };

/*
 * Who wrote rows' records, checked at this moment against the trust (or family members) as it is
 * now: the drive client's checkNow. Absent, the rows' own verdicts stand (tests that don't sign).
 */
export type CheckNow = (nodes: DriveNode[]) => Promise<Map<string, NodeIntegrity | null>>;

/*
 * A new file beside `file` in `folder`, under the next free name, holding `bytes`, signed as
 * `source` (the row the text was read from) is. Its version is the one the upload minted, never
 * the reply row's: a repeated completion answers with the node as it is by then, which may already
 * carry another device's edit.
 */
export async function saveCopy(
    start: StartRun,
    edit: { file: DriveNode; source: DriveNode; folder: DriveNode; bytes: Uint8Array },
    { stillOn = () => true, pause, check }: SaveOptions & { check?: CheckNow } = {},
): Promise<TextCopy> {
    const bytes = edit.bytes;
    // Signed as the weakest of what it is made from, each checked now: the text's own version
    // (`source`) and, when they differ, the row its name and type come from (`file`, which a save
    // may have adopted renamed). A check that can't run re-seals rather than vouches.
    const rows = edit.file === edit.source ? [edit.source] : [edit.source, edit.file];
    // One row a check: the two may be the same file at two versions, and an answer is keyed by id.
    const now = async (row: DriveNode): Promise<DriveNode> => {
        if (!check) return row;
        const checked = await check([row]).catch(() => null);
        return {
            ...row,
            integrity: checked?.get(row.id) ?? {
                metadata: 'unchecked',
                version: row.currentVersion ? 'unchecked' : null,
            },
        };
    };
    const sources = await Promise.all(rows.map(async (row) => ({ node: await now(row) })));
    if (!stillOn()) throw new SessionEnded();
    const run = await start({
        targets: [edit.folder],
        results: [{ size: bytes.byteLength, thumbnail: false }],
    });
    if (!stillOn()) {
        await endRun(run, pause ? { pause } : {});
        throw new SessionEnded();
    }
    let versionId: string | null = null;
    const made = await run.file({
        name: edit.file.name,
        bytes,
        mime: edit.file.metadata?.mime ?? null,
        sources: sources.map(({ node }) => ({ node, source: 'drive' as const })),
        into: edit.folder,
        onVersion: (minted) => {
            versionId = minted;
        },
    });
    await endRun(run, pause ? { pause } : {});
    return { node: made, versionId };
}

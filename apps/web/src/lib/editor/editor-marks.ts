import type { DriveNode } from '@hushos/drive/client';

/*
 * The text the editor holds came from one version: the one it read when it opened, or the one its
 * last save or copy published. The viewer's marks (Unverified, "Saved from a link") speak for that
 * version while the editor is open, never for whatever the listing shows by then: another device's
 * newer version, checked or not, says nothing about the text on screen.
 */
export type EditorRead = {
    /* The row the editor read its text from (the opened file's row, as listed when it opened). */
    row: DriveNode;
    /* The version the text is now: the one read, or the one the last save or copy published (null: unknown). */
    versionId: string | null;
    /*
     * The text came from a version that can't be checked now (a draft restored from another one):
     * its content shows as unchecked, never as the version read.
     */
    contentUnknown?: boolean;
};

/*
 * What the editor's text is after it read a version or a save or copy published one (`versionId`):
 * `row` (the opened file, the saved file, the copy) speaks for it only when it lists that very
 * version, so after Save as a copy the header names the copy, and a row already showing someone
 * else's version never does. Otherwise the row before stands.
 */
export function nextRead(
    before: EditorRead,
    versionId: string | null,
    row?: DriveNode,
    contentUnknown = false,
): EditorRead {
    const speaks = row && versionId !== null && row.currentVersion?.id === versionId;
    return { row: speaks ? row : before.row, versionId, contentUnknown };
}

/*
 * The row whose checks the marks show: the listing's row of the file being written only while it
 * lists the very version the editor holds (its checks are of that version), else the row read.
 */
export function markedRow(
    listed: DriveNode | null,
    target: DriveNode,
    read: EditorRead,
): DriveNode {
    const row = checkedRow(listed, target, read);
    if (!read.contentUnknown) return row;
    // Text from another version than this row's: no verdict of this row's version speaks for it.
    return {
        ...row,
        integrity: { metadata: row.integrity?.metadata ?? 'unchecked', version: 'unchecked' },
    };
}

function checkedRow(listed: DriveNode | null, target: DriveNode, read: EditorRead): DriveNode {
    if (
        listed &&
        read.versionId !== null &&
        listed.id === target.id &&
        listed.workspaceId === target.workspaceId &&
        listed.currentVersion?.id === read.versionId
    )
        return listed;
    return read.row;
}

/*
 * The row the viewer's header shows, its name and its marks together: the listing's row when no
 * editor is open, the marked row while one is. A name taken from one row and a mark from another
 * would let a verified old name stand over an unverified new one.
 */
export function headerRow(
    shown: DriveNode | null,
    listed: DriveNode | null,
    editing: { target: DriveNode; read: EditorRead } | null,
): DriveNode | null {
    if (!editing || !shown) return shown;
    return markedRow(listed, editing.target, editing.read);
}

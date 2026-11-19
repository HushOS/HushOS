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
};

/*
 * The row whose checks the marks show: the listing's row of the file being written only while it
 * lists the very version the editor holds (its checks are of that version), else the row read.
 */
export function markedRow(
    listed: DriveNode | null,
    target: DriveNode,
    read: EditorRead,
): DriveNode {
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

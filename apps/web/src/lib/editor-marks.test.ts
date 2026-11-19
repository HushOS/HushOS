import type { DriveNode } from '@hushos/drive/client';
import { describe, expect, test } from 'vitest';
import { headerRow, markedRow } from '@/lib/editor-marks';

/*
 * While the editor is open the viewer's Unverified mark speaks for the text on screen. Fails if a
 * newer version another device published (verified) takes the warning off text that came from an
 * unverified one, or if a save's own version never gets its marks.
 */

const row = (
    version: string,
    verdict: 'verified' | 'unverified',
    workspaceId = 'w',
    name = 'notes.txt',
) =>
    ({
        id: 'f',
        kind: 'file',
        name,
        workspaceId,
        parentId: 'root',
        currentVersion: { id: version },
        integrity: { metadata: verdict, version: verdict },
    }) as unknown as DriveNode;

describe('the marks while editing', () => {
    const opened = row('v1', 'unverified');

    test('another device’s newer version never takes the warning off the text read', () => {
        const theirs = row('v2', 'verified');
        const marked = markedRow(theirs, opened, { row: opened, versionId: 'v1' });
        expect(marked.integrity?.version).toBe('unverified');
    });

    test('the listing speaks for the text once it lists the very version the editor holds', () => {
        const mine = row('v3', 'verified');
        expect(markedRow(mine, opened, { row: opened, versionId: 'v3' })).toBe(mine);
        // A save whose version isn't known never adopts whatever the listing shows.
        expect(markedRow(mine, opened, { row: opened, versionId: null })).toBe(opened);
    });

    test('a row with the file’s id in another drive is not the file', () => {
        const elsewhere = row('v1', 'verified', 'other');
        expect(markedRow(elsewhere, opened, { row: opened, versionId: 'v1' })).toBe(opened);
    });

    test('a rename and a new version from another device: the header’s name and mark come from one row', () => {
        const read = row('v1', 'verified');
        // Renamed by someone whose name record doesn't check, with a new version: the listing now.
        const listed = {
            ...row('v2', 'verified', 'w', 'renamed.txt'),
            integrity: { metadata: 'unverified', version: 'verified' },
        } as unknown as DriveNode;
        const header = headerRow(listed, listed, {
            target: read,
            read: { row: read, versionId: 'v1' },
        });
        // Never the new name under the old name's verdict: both are the row the text came from.
        expect(header).toBe(read);
        expect(header?.name).toBe('notes.txt');
        // Without an editor, the listing's row as it is: the new name with its own Unverified record.
        const viewing = headerRow(listed, listed, null);
        expect(viewing?.name).toBe('renamed.txt');
        expect(viewing?.integrity?.metadata).toBe('unverified');
    });
});

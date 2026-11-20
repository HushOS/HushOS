import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DriveNode } from '@hushos/drive/client';
import { describe, expect, it } from 'vitest';
import { FIXTURE_DIR } from '../../../../../e2e/fixtures/archives/make';
import { recallPreview, rememberPreview } from '@/lib/viewers/previews';
import { entryNode, forgetEntryPreviews } from './open';
import type { ArchiveEntry } from './session';
import { ZipArchive } from './zip-archive';

/*
 * What a viewed entry's preview is remembered under. two-passwords.zip has an entry under each of
 * two passwords: a preview first.txt's password opened in one session is never shown in a later
 * one where only second.txt's password was typed.
 */

const archive = {
    id: 'node-1',
    kind: 'file',
    name: 'two-passwords.zip',
    currentVersion: { id: 'version-1' },
} as unknown as DriveNode;

async function entries(name: string) {
    const bytes = new Uint8Array(readFileSync(join(FIXTURE_DIR, name)));
    const zip = await ZipArchive.open({
        size: bytes.length,
        read: async (offset, length) => bytes.slice(offset, offset + length),
    });
    return zip.listed as unknown as ArchiveEntry[];
}

describe('a remembered entry preview', () => {
    it('is a locked entry’s only in the session that opened it, a plain entry’s in any', async () => {
        const [first, second] = await entries('two-passwords.zip');
        expect(first!.lock).not.toBe('none');
        // Session A opened first.txt under its password, and its preview was remembered.
        const seen = entryNode(archive, first!, 'session-a');
        rememberPreview(seen.currentVersion!.id, {
            kind: 'text',
            data: new Uint8Array(4),
            bytes: 4,
        } as never);
        expect(
            recallPreview(entryNode(archive, first!, 'session-a').currentVersion!.id),
        ).not.toBeNull();
        // Session B, where second.txt's password was typed: first.txt asks for its own again.
        expect(
            recallPreview(entryNode(archive, first!, 'session-b').currentVersion!.id),
        ).toBeNull();
        expect(entryNode(archive, second!, 'session-b').id).not.toBe(
            entryNode(archive, second!, 'session-a').id,
        );
        // Session A closes: what it showed of its locked entries is let go of at once, not kept until a lock.
        const kept = entryNode(archive, second!, 'session-c');
        rememberPreview(kept.currentVersion!.id, {
            kind: 'text',
            data: new Uint8Array(4),
            bytes: 4,
        } as never);
        forgetEntryPreviews('session-a');
        expect(recallPreview(seen.currentVersion!.id)).toBeNull();
        expect(recallPreview(kept.currentVersion!.id)).not.toBeNull();
        // A plain entry needs no password: its preview is the same in every session.
        const [plain] = (await entries('basic.zip')).filter(
            (entry) => entry.lock === 'none' && !entry.directory,
        );
        expect(entryNode(archive, plain!, 'session-a').id).toBe(
            entryNode(archive, plain!, 'session-b').id,
        );
    });
});

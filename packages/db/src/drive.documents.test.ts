import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import * as drive from './drive';

/*
 * A workspace document is replaced whole under a version precondition, so two
 * devices editing the tag registry cannot silently drop each other's tags: the
 * second write is refused with the row it must merge with.
 */

const envelope = (bytes = 100) => randomBytes(bytes);

let owner: Awaited<ReturnType<typeof createTestAccount>>;
let other: Awaited<ReturnType<typeof createTestAccount>>;

beforeEach(async () => {
    await resetDatabase();
    owner = await createTestAccount();
    other = await createTestAccount();
});
afterAll(closeDatabase);

describe('workspace documents', () => {
    test('the first write must expect no document, and each write becomes the next version', async () => {
        expect(await drive.getWorkspaceDocument(owner.workspaceId, 'tags')).toBeNull();
        const early = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            kind: 'tags',
            version: 1,
            envelope: envelope(),
        });
        expect(early).toEqual({ status: 'stale', document: null });

        const first = envelope();
        const created = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            kind: 'tags',
            version: 0,
            envelope: first,
        });
        expect(created.status).toBe('ok');
        expect(created.document?.version).toBe(1);

        const second = envelope();
        const updated = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            kind: 'tags',
            version: 1,
            envelope: second,
        });
        expect(updated.status).toBe('ok');
        expect(updated.document?.version).toBe(2);
        const stored = await drive.getWorkspaceDocument(owner.workspaceId, 'tags');
        expect(stored?.version).toBe(2);
        expect(stored?.envelope.equals(second)).toBe(true);
    });

    test('a write from a stale version is refused with the current row, and nothing changes', async () => {
        const first = envelope();
        await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            kind: 'tags',
            version: 0,
            envelope: first,
        });
        const current = envelope();
        await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            kind: 'tags',
            version: 1,
            envelope: current,
        });
        // A second device that still holds version 1.
        const refused = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            kind: 'tags',
            version: 1,
            envelope: envelope(),
        });
        expect(refused.status).toBe('stale');
        expect(refused.document?.version).toBe(2);
        expect(refused.document?.envelope.equals(current)).toBe(true);
        // Nor can a device that saw nothing create over it.
        const clobber = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            kind: 'tags',
            version: 0,
            envelope: envelope(),
        });
        expect(clobber.status).toBe('stale');
        expect(clobber.document?.version).toBe(2);
        const stored = await drive.getWorkspaceDocument(owner.workspaceId, 'tags');
        expect(stored?.envelope.equals(current)).toBe(true);
    });

    test('documents are kept apart by workspace and by kind', async () => {
        await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            kind: 'tags',
            version: 0,
            envelope: envelope(),
        });
        expect(await drive.getWorkspaceDocument(other.workspaceId, 'tags')).toBeNull();
        expect(await drive.getWorkspaceDocument(owner.workspaceId, 'pins')).toBeNull();
        const pins = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            kind: 'pins',
            version: 0,
            envelope: envelope(),
        });
        expect(pins.status).toBe('ok');
        expect((await drive.getWorkspaceDocument(owner.workspaceId, 'tags'))?.version).toBe(1);
    });

    test('the row refuses a kind outside the grammar and an envelope outside the size bounds', async () => {
        await expect(
            drive.putWorkspaceDocument({
                workspaceId: owner.workspaceId,
                kind: 'Tags',
                version: 0,
                envelope: envelope(),
            }),
        ).rejects.toThrow();
        await expect(
            drive.putWorkspaceDocument({
                workspaceId: owner.workspaceId,
                kind: 'tags',
                version: 0,
                envelope: envelope(41),
            }),
        ).rejects.toThrow();
        await expect(
            drive.putWorkspaceDocument({
                workspaceId: owner.workspaceId,
                kind: 'tags',
                version: 0,
                envelope: envelope(1048617),
            }),
        ).rejects.toThrow();
        const ok = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            kind: 'tags',
            version: 0,
            envelope: envelope(1048616),
        });
        expect(ok.status).toBe('ok');
    });
});

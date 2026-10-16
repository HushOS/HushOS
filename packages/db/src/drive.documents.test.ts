import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { count, eq, sql } from 'drizzle-orm';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import { db } from './client';
import * as drive from './drive';
import { workspaceDocuments } from './schema';

/*
 * A workspace document is replaced whole under a version precondition, so two
 * devices editing the tag registry cannot silently drop each other's tags: the
 * second write is refused with the row it must merge with.
 */

const envelope = (bytes = 100) => randomBytes(bytes);
/* Drive's limits (@hushos/drive/protocol): 8 kinds, two documents at the largest size. */
const LIMITS = { kinds: 8, bytes: 2 * 1048616 };

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
            limits: LIMITS,
            kind: 'tags',
            version: 1,
            envelope: envelope(),
        });
        expect(early).toEqual({ status: 'stale', document: null });

        const first = envelope();
        const created = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            limits: LIMITS,
            kind: 'tags',
            version: 0,
            envelope: first,
        });
        expect(created.status).toBe('ok');
        expect(created.document?.version).toBe(1);

        const second = envelope();
        const updated = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            limits: LIMITS,
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
            limits: LIMITS,
            kind: 'tags',
            version: 0,
            envelope: first,
        });
        const current = envelope();
        await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            limits: LIMITS,
            kind: 'tags',
            version: 1,
            envelope: current,
        });
        // A second device that still holds version 1.
        const refused = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            limits: LIMITS,
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
            limits: LIMITS,
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
            limits: LIMITS,
            kind: 'tags',
            version: 0,
            envelope: envelope(),
        });
        expect(await drive.getWorkspaceDocument(other.workspaceId, 'tags')).toBeNull();
        expect(await drive.getWorkspaceDocument(owner.workspaceId, 'pins')).toBeNull();
        const pins = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            limits: LIMITS,
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
                limits: LIMITS,
                kind: 'Tags',
                version: 0,
                envelope: envelope(),
            }),
        ).rejects.toThrow();
        await expect(
            drive.putWorkspaceDocument({
                workspaceId: owner.workspaceId,
                limits: LIMITS,
                kind: 'tags',
                version: 0,
                envelope: envelope(41),
            }),
        ).rejects.toThrow();
        await expect(
            drive.putWorkspaceDocument({
                workspaceId: owner.workspaceId,
                limits: LIMITS,
                kind: 'tags',
                version: 0,
                envelope: envelope(1048617),
            }),
        ).rejects.toThrow();
        const ok = await drive.putWorkspaceDocument({
            workspaceId: owner.workspaceId,
            limits: LIMITS,
            kind: 'tags',
            version: 0,
            envelope: envelope(1048616),
        });
        expect(ok.status).toBe('ok');
    });

    test('a workspace holds up to the kind limit; one kind more is refused, rewriting one it holds is not', async () => {
        const limits = { kinds: 3, bytes: LIMITS.bytes };
        const put = (kind: string, version: number) =>
            drive.putWorkspaceDocument({
                workspaceId: owner.workspaceId,
                kind,
                version,
                envelope: envelope(),
                limits,
            });
        for (const kind of ['tags', 'pins', 'views'])
            expect((await put(kind, 0)).status).toBe('ok');
        expect(await put('notes', 0)).toEqual({ status: 'limit', limit: 'kinds' });
        expect(await drive.getWorkspaceDocument(owner.workspaceId, 'notes')).toBeNull();
        expect((await put('tags', 1)).status).toBe('ok');
        // A stale write is told it is stale first, so the client merges before meeting the limit.
        expect((await put('notes', 1)).status).toBe('stale');
        // The limit is per workspace: another account's is untouched by this one's.
        expect(
            (
                await drive.putWorkspaceDocument({
                    workspaceId: other.workspaceId,
                    kind: 'notes',
                    version: 0,
                    envelope: envelope(),
                    limits,
                })
            ).status,
        ).toBe('ok');
    });

    test('stored envelopes up to the byte limit are kept; one byte past it is refused, counting a rewrite once', async () => {
        const limits = { kinds: LIMITS.kinds, bytes: 300 };
        const put = (kind: string, version: number, bytes: number) =>
            drive.putWorkspaceDocument({
                workspaceId: owner.workspaceId,
                kind,
                version,
                envelope: envelope(bytes),
                limits,
            });
        expect((await put('tags', 0, 100)).status).toBe('ok');
        expect((await put('pins', 0, 200)).status).toBe('ok');
        // At the limit exactly: 300. A rewrite that grows it by one byte is refused, whole.
        expect(await put('pins', 1, 201)).toEqual({ status: 'limit', limit: 'bytes' });
        expect((await drive.getWorkspaceDocument(owner.workspaceId, 'pins'))!.envelope.length).toBe(
            200,
        );
        expect(await put('views', 0, 42)).toEqual({ status: 'limit', limit: 'bytes' });
        // A rewrite counts in place of the bytes it replaces, not on top of them.
        expect((await put('tags', 1, 100)).status).toBe('ok');
        expect((await put('tags', 2, 58)).status).toBe('ok');
        expect((await put('views', 0, 42)).status).toBe('ok');
    });

    test('two new kinds written at once with room for one: one lands, the other meets the limit', async () => {
        // Connections ready for both, so the two writes really run side by side.
        await Promise.all(Array.from({ length: 4 }, () => db.execute(sql`select pg_sleep(0.02)`)));
        const put = (kind: string, kinds: number) =>
            drive.putWorkspaceDocument({
                workspaceId: owner.workspaceId,
                kind,
                version: 0,
                envelope: envelope(),
                limits: { kinds, bytes: LIMITS.bytes },
            });
        // Each round leaves room for exactly one more kind, and two writers race for it.
        for (let held = 0; held < 8; held++) {
            const raced = await Promise.all([put(`a${held}`, held + 1), put(`b${held}`, held + 1)]);
            expect(raced.map((result) => result.status).sort()).toEqual(['limit', 'ok']);
        }
        const [row] = await db
            .select({ kinds: count() })
            .from(workspaceDocuments)
            .where(eq(workspaceDocuments.workspaceId, owner.workspaceId));
        expect(row!.kinds).toBe(8);
    });
});

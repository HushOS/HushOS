import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { closeDatabase, resetDatabase } from '../../db/test/helpers';
import { member, type Account } from '../test/fixtures';
import { WORKSPACE_DOCUMENT_BYTES, WORKSPACE_DOCUMENT_KINDS } from './protocol';
import type * as Protocol from './protocol';
import * as server from './server';

/*
 * As if clients had shipped more kinds than the limit allows: every shipped
 * client writes `tags` alone today, and the kind limit is the backstop for
 * when the list grows (server.document-kinds.test.ts holds the list itself).
 */
const KINDS = vi.hoisted(() => [
    'tags',
    'pins',
    'views',
    ...Array.from({ length: 7 }, (_, i) => `kind-${i}`),
]);
vi.mock('./protocol', async (original) => ({
    ...(await original<typeof Protocol>()),
    DOCUMENT_KINDS: KINDS,
}));

/*
 * The limits on a workspace's sealed documents, as a client meets them: every
 * roster rotation of a group area carries all of its documents again, so what
 * a workspace may hold bounds what a roster body must make room for. The
 * limits hold for personal workspaces alike.
 */

// A sealed document as a client pads it: `plaintext` bytes, its nonce and tag.
const sealed = (plaintext = 1024) => randomBytes(24 + plaintext + 16).toString('base64url');

let owner: Account;
beforeEach(async () => {
    await resetDatabase();
    owner = await member();
});
afterAll(closeDatabase);

async function refusal(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        const { code, status, data } = error as { code: string; status: number; data: unknown };
        return { code, status, data };
    }
    throw new Error('Expected a refusal.');
}

describe('workspace document limits', () => {
    test('a workspace holds eight kinds; a ninth is a document-limit 409 and is not stored', async () => {
        const kinds = KINDS.slice(0, WORKSPACE_DOCUMENT_KINDS);
        for (const kind of kinds)
            await server.putWorkspaceDocument(owner.userId, owner.workspaceId, kind, {
                version: 0,
                envelope: sealed(),
            });
        expect(
            await refusal(
                server.putWorkspaceDocument(owner.userId, owner.workspaceId, KINDS[8]!, {
                    version: 0,
                    envelope: sealed(),
                }),
            ),
        ).toEqual({
            code: 'document-limit',
            status: 409,
            data: { limit: 'kinds', kinds: 8, bytes: WORKSPACE_DOCUMENT_BYTES },
        });
        expect(await server.workspaceDocument(owner.userId, owner.workspaceId, KINDS[8]!)).toEqual({
            document: null,
        });
        // Rewriting a kind it holds is not a new kind.
        const rewritten = await server.putWorkspaceDocument(
            owner.userId,
            owner.workspaceId,
            kinds[0]!,
            { version: 1, envelope: sealed() },
        );
        expect(rewritten.document.version).toBe(2);
    });

    test('two documents at the largest size fit; any byte more is a document-limit 409', async () => {
        const largest = 1024 * 1024;
        for (const kind of ['tags', 'pins'])
            await server.putWorkspaceDocument(owner.userId, owner.workspaceId, kind, {
                version: 0,
                envelope: sealed(largest),
            });
        expect(
            await refusal(
                server.putWorkspaceDocument(owner.userId, owner.workspaceId, 'views', {
                    version: 0,
                    envelope: sealed(),
                }),
            ),
        ).toMatchObject({ code: 'document-limit', status: 409, data: { limit: 'bytes' } });
        // Shrinking one makes room, counted in place of what it replaces.
        await server.putWorkspaceDocument(owner.userId, owner.workspaceId, 'pins', {
            version: 1,
            envelope: sealed(largest - 16 * 1024),
        });
        const views = await server.putWorkspaceDocument(owner.userId, owner.workspaceId, 'views', {
            version: 0,
            envelope: sealed(),
        });
        expect(views.document.version).toBe(1);
    });
});

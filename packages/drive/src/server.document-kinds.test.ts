import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, resetDatabase } from '../../db/test/helpers';
import { member, type Account } from '../test/fixtures';
import * as server from './server';

/*
 * The server keeps only the document kinds shipped clients write: a member
 * cannot plant one other clients do not know, which every rotation of a group
 * area would then have to carry without anyone able to read it.
 */

const sealed = () => randomBytes(24 + 1024 + 16).toString('base64url');

let owner: Account;
beforeEach(async () => {
    await resetDatabase();
    owner = await member();
});
afterAll(closeDatabase);

describe('document kinds', () => {
    test('the tags registry is kept; a kind no shipped client writes is refused and not stored', async () => {
        const tags = await server.putWorkspaceDocument(owner.userId, owner.workspaceId, 'tags', {
            version: 0,
            envelope: sealed(),
        });
        expect(tags.document.version).toBe(1);
        await expect(
            server.putWorkspaceDocument(owner.userId, owner.workspaceId, 'pins', {
                version: 0,
                envelope: sealed(),
            }),
        ).rejects.toMatchObject({ code: 'invalid', status: 400 });
        expect(await server.workspaceDocument(owner.userId, owner.workspaceId, 'pins')).toEqual({
            document: null,
        });
    });

    test('a rotation may not carry a kind no shipped client writes', () => {
        expect(() =>
            server.rotatedDocumentInput({ kind: 'pins', version: 1, envelope: sealed() }),
        ).toThrow(expect.objectContaining({ code: 'invalid' }));
        expect(
            server.rotatedDocumentInput({ kind: 'tags', version: 1, envelope: sealed() }).kind,
        ).toBe('tags');
    });
});

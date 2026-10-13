import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { closeDatabase, resetDatabase } from '../../db/test/helpers';
import { file, folder, keysOf, link, member, root, type Account } from '../test/fixtures';
import * as server from './server';

/*
 * What a link's visitor is told. A visitor has no account and no pins, so a
 * signer or a signature would buy them nothing to check, while testing a
 * signature against keys from contact lookup would tell an anonymous holder of
 * the URL who wrote the files: every visitor response leaves them out, at any
 * depth, and leaves out the owner's change sequence too. The paths that once
 * carried the token answer 410.
 */

vi.mock('./storage', () => ({
    objectKey: (workspaceId: string, objectId: string) => `ws/${workspaceId}/${objectId}`,
    primaryStore: () => ({
        presignGet: async (key: string) => `https://store.test/${key}`,
    }),
}));

const SIGNED_FIELDS = ['metadataSigner', 'metadataSignature', 'signer', 'signature'];
const ADDRESS = '203.0.113.7';

let owner: Account;
let top: Awaited<ReturnType<typeof root>>;

beforeEach(async () => {
    await resetDatabase();
    owner = await member();
    top = await root(owner);
});
afterAll(closeDatabase);

describe('link visitors', () => {
    test('open, listing and download carry no signer, no signature and no change sequence', async () => {
        const shared = await folder(owner, top);
        const inner = await folder(owner, shared);
        const doc = await file(owner, inner);
        const token = await link(owner, shared);

        // What a member is served for the same nodes does carry all four, so the check below
        // is about the visitor's view and not about fixtures that were never signed.
        const own = await server.listChildren(owner.userId, owner.workspaceId, inner.id);
        for (const field of SIGNED_FIELDS) expect(keysOf(own).has(field)).toBe(true);
        expect(own.children[0]?.metadataSignature).toEqual(expect.any(String));

        const opened = await server.openLink(token, ADDRESS);
        const listing = await server.linkChildren(token, ADDRESS, inner.id);
        const download = await server.linkDownloadUrl(token, ADDRESS, doc.currentVersion!.id);
        for (const response of [opened, listing, download]) {
            const keys = keysOf(response);
            for (const field of SIGNED_FIELDS) expect(keys.has(field)).toBe(false);
        }
        expect(opened.node.id).toBe(shared.id);
        expect(opened.node.workspaceId).toBe(owner.workspaceId);
        expect(listing.children.map((child) => child.id)).toEqual([doc.id]);
        expect(listing.children[0]?.currentVersion?.id).toBe(doc.currentVersion!.id);
        expect(download.version.id).toBe(doc.currentVersion!.id);
        for (const node of [opened.node, listing.folder, ...listing.children, download.node])
            expect(node.changeSeq).toBeNull();
    });

    test('a node outside the linked subtree is not served, however it is named', async () => {
        const shared = await folder(owner, top);
        const outside = await folder(owner, top);
        const token = await link(owner, shared);
        await expect(server.linkChildren(token, ADDRESS, outside.id)).rejects.toMatchObject({
            status: 404,
        });
    });

    test('the retired token-in-path routes answer 410 and say to update', () => {
        expect(() => server.linkPathRetired()).toThrow(
            expect.objectContaining({ status: 410, message: 'Update HushOS to open links.' }),
        );
    });
});

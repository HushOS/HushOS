import { randomBytes } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { db } from '../../db/src/client';
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

// A re-keyed record's origin names its writer and carries their signature: as good as a signer.
const SIGNED_FIELDS = [
    'metadataSigner',
    'metadataSignature',
    'metadataRekey',
    'metadataOriginDropped',
    'signer',
    'signature',
    'rekey',
    'originDropped',
];
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

    test('a re-keyed record’s origin is served to members, and to no visitor', async () => {
        const shared = await folder(owner, top);
        const doc = await file(owner, shared);
        const writer = '0e1d2c3b-4a59-4687-9a6b-5c4d3e2f1a0b';
        const origin = {
            envelope: randomBytes(100),
            keyEnvelope: randomBytes(72),
            signature: randomBytes(64),
            rekey: randomBytes(64),
        };
        // As a rotation leaves them (the writer need not be an account any more: no foreign key).
        await db.$client.query(
            `update drive_nodes set metadata_origin_envelope = $2, metadata_origin_key_envelope = $3,
                metadata_origin_signer = $4, metadata_origin_signature = $5, metadata_rekey_signature = $6
             where id = $1`,
            [doc.id, origin.envelope, origin.keyEnvelope, writer, origin.signature, origin.rekey],
        );
        await db.$client.query(
            `update file_versions set origin_envelope = content_key_envelope, origin_key_envelope = $2,
                origin_signer = $3, origin_signature = $4, rekey_signature = $5
             where id = $1`,
            [doc.currentVersion!.id, origin.keyEnvelope, writer, origin.signature, origin.rekey],
        );
        // And a drop's trace, as a later rotation would leave it beside the record.
        await db.$client.query(
            `update drive_nodes set metadata_dropped_signer = $2, metadata_origin_dropped_by = $3 where id = $1`,
            [doc.id, writer, owner.userId],
        );
        await db.$client.query(
            `update file_versions set dropped_signer = $2, origin_dropped_by = $3 where id = $1`,
            [doc.currentVersion!.id, writer, owner.userId],
        );
        const token = await link(owner, shared);

        const own = await server.listChildren(owner.userId, owner.workspaceId, shared.id);
        // Members get who the server says dropped it, never the dropped origin's writer.
        expect(own.children[0]?.metadataOriginDropped).toEqual({ by: { id: owner.userId } });
        expect(own.children[0]?.currentVersion?.originDropped).toEqual({
            by: { id: owner.userId },
        });
        expect(own.children[0]?.metadataRekey).toEqual({
            origin: {
                envelope: origin.envelope.toString('base64url'),
                signer: { id: writer },
                signature: origin.signature.toString('base64url'),
                keyEnvelope: origin.keyEnvelope.toString('base64url'),
            },
            signature: origin.rekey.toString('base64url'),
        });
        expect(own.children[0]?.currentVersion?.rekey?.origin.signer).toEqual({ id: writer });

        const listing = await server.linkChildren(token, ADDRESS, shared.id);
        expect(listing.children.map((child) => child.id)).toEqual([doc.id]);
        const keys = keysOf(listing);
        for (const field of SIGNED_FIELDS) expect(keys.has(field)).toBe(false);
        const [child] = listing.children;
        for (const field of ['metadataRekey', 'metadataOriginDropped', 'metadataSigner'])
            expect(child).not.toHaveProperty(field);
        for (const field of ['rekey', 'originDropped', 'signer'])
            expect(child!.currentVersion).not.toHaveProperty(field);
        const opened = await server.openLink(token, ADDRESS);
        expect(opened.node).not.toHaveProperty('metadataOriginDropped');
        expect(opened.node).not.toHaveProperty('metadataRekey');
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

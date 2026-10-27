// @vitest-environment node
import type { DriveApi, NodeView, ServedIdentity } from '@hushos/drive/api';
import { createDriveClient, type Rpc, type SharingLedger } from '@hushos/drive/client';
import { describe, expect, test } from 'vitest';
import { stopSharingWith } from './stop-sharing';

/*
 * Stop sharing with Maya (docs/optional-verification.md 6.6, 4.4), through the
 * real Drive client: every share this account made with her is revoked, and
 * each item it covered is re-keyed with her already out of the owner's
 * ledger, so the keys the worker seals again go to everyone else and never to
 * her. The server here keeps listing her shares on the re-keying walk, as a
 * stale or dishonest one would: only the ledger keeps her out.
 */

const WS = 'ws';
const ROOT = 'root';
const MAYA = 'maya';
const SAM = 'sam';

function node(id: string, parentId: string | null): NodeView {
    return {
        id,
        workspaceId: WS,
        parentId,
        kind: 'folder',
        keyEpoch: 2,
        parentKeyEpoch: 1,
        keyEnvelope: 'ke',
        prevKeyEnvelope: null,
        prevKeyEpoch: null,
        prevParentKeyEpoch: null,
        metadataVersion: 1,
        metadataEnvelope: 'me',
        currentVersion: null,
        trashedAt: null,
        changeSeq: 1,
        createdAt: '2026-10-27T00:00:00.000Z',
        updatedAt: '2026-10-27T00:00:00.000Z',
        envelopeSuite: 4,
        metadataSigner: null,
        metadataSignature: null,
    };
}
const identity = (id: string): ServedIdentity => ({
    keyVersion: 1,
    identityVersion: 2,
    encryptionPublicKey: `x25519-${id}`,
    signingPublicKey: `ed25519-${id}`,
    mlDsaPublicKey: `ml-dsa-${id}`,
    kemPublicKey: `kem-${id}`,
    keysSignature: `keys-${id}`,
});

function harness() {
    // A and B shared with Maya, A with Sam too; C is in the ledger for Maya, but the server lists
    // no share of it (one it already ended, or one it hides).
    const ledgerState: { shares: Record<string, string[]>; links: Record<string, string> } = {
        shares: { A: [MAYA, SAM], B: [MAYA], C: [MAYA] },
        links: {},
    };
    const ledger: SharingLedger = {
        read: async () => structuredClone(ledgerState),
        addShare: async () => {},
        removeShare: async (nodeId, grantee) => {
            const people = (ledgerState.shares[nodeId] ?? []).filter((id) => id !== grantee);
            if (people.length) ledgerState.shares[nodeId] = people;
            else delete ledgerState.shares[nodeId];
        },
        addLink: async () => {},
        removeLink: async () => {},
    };
    const listed = [
        { id: 'share-maya-A', nodeId: 'A', grantee: MAYA },
        { id: 'share-sam-A', nodeId: 'A', grantee: SAM },
        { id: 'share-maya-B', nodeId: 'B', grantee: MAYA },
    ];
    const revoked: string[] = [];
    // Per rotated node, whom the worker was asked to seal its new key to.
    const sealedTo: Record<string, string[]> = {};
    const walks = new Map<string, number>();
    const api = {
        workspace: async () => ({
            workspaceId: WS,
            grant: { workspaceKeyVersion: 1 },
            root: node(ROOT, null),
            changeSeq: 0,
        }),
        children: async (_ws: string, folderId: string) => ({
            folder: node(folderId, folderId === ROOT ? null : ROOT),
            ancestors: folderId === ROOT ? [] : [node(ROOT, null)],
            children: folderId === ROOT ? ['A', 'B', 'C'].map((id) => node(id, ROOT)) : [],
            nextCursor: null,
        }),
        sharedByMe: async () => ({
            shares: listed
                .filter((share) => !revoked.includes(share.id))
                .map((share) => ({
                    id: share.id,
                    suite: 4,
                    role: 'viewer',
                    node: node(share.nodeId, ROOT),
                    grantee: {
                        id: share.grantee,
                        name: share.grantee,
                        email: `${share.grantee}@x`,
                    },
                    granteeIdentity: identity(share.grantee),
                })),
            links: [],
        }),
        nodeShares: async (_ws: string, nodeId: string) => ({
            shares: listed
                .filter((share) => share.nodeId === nodeId && !revoked.includes(share.id))
                .map((share) => ({
                    id: share.id,
                    role: 'viewer',
                    keyEpoch: 2,
                    createdAt: '',
                    suite: 4,
                    grantee: { id: share.grantee, name: share.grantee, email: '' },
                })),
        }),
        revokeShare: async (_ws: string, shareId: string) => {
            revoked.push(shareId);
            return {};
        },
        startRotation: async () => ({ rotation: { targetEpoch: 3 } }),
        rotationWork: async (_ws: string, rootId: string) => {
            const calls = walks.get(rootId) ?? 0;
            walks.set(rootId, calls + 1);
            if (calls > 0) return { done: true, nextCursor: null, nodes: [] };
            return {
                done: false,
                nextCursor: null,
                nodes: [
                    {
                        ...node(rootId, ROOT),
                        depth: 0,
                        versions: [],
                        // Every share the server ever had on it, the revoked ones included.
                        shares: listed
                            .filter((share) => share.nodeId === rootId)
                            .map((share) => ({
                                id: share.id,
                                granteeUserId: share.grantee,
                                grantee: identity(share.grantee),
                            })),
                        links: [],
                    },
                ],
            };
        },
        rotateNodes: async (_ws: string, _root: string, nodes: { id: string }[]) => ({
            results: nodes.map((n) => ({ id: n.id, status: 'ok' })),
        }),
    } as unknown as DriveApi;
    const rpc = (async (operation: string, input: Record<string, unknown>) => {
        switch (operation) {
            case 'driveOpenWorkspace':
                return { workspaceId: WS, workspaceKeyVersion: 1 };
            case 'driveOpenNodes':
                return {
                    nodes: (input.nodes as unknown[]).map(() => ({
                        metadata: { name: 'x', mime: null, size: null, modified: null },
                    })),
                };
            case 'driveVerify':
                return {
                    nodes: (input.nodes as { id: string }[]).map((n) => ({
                        id: n.id,
                        metadata: 'verified',
                        versions: [],
                    })),
                };
            case 'driveRotateNodes': {
                const nodes = input.nodes as {
                    id: string;
                    shares: { granteeUserId: string }[];
                }[];
                for (const n of nodes) sealedTo[n.id] = n.shares.map((s) => s.granteeUserId);
                return {
                    nodes: nodes.map(() => ({
                        keyEnvelope: 'k',
                        rewrap: false,
                        metadataEnvelope: 'm',
                        metadataSignature: 'msig',
                        versions: [],
                        shares: [],
                        links: [],
                    })),
                };
            }
            case 'driveRotateCommit':
                return { committed: (input.nodeIds as string[]).length };
            case 'driveRotateDrop':
                return { dropped: (input.nodeIds as string[]).length };
            default:
                throw new Error(`unexpected ${operation}`);
        }
    }) as unknown as Rpc;
    const client = createDriveClient(rpc, api, {
        ledger,
        signers: async () => ({}),
        trustGrantee: async (_id, served) => ({
            encryptionPublicKey: served.encryptionPublicKey,
            kemPublicKey: served.kemPublicKey,
        }),
    });
    return { client, ledger, ledgerState, revoked, sealedTo };
}

describe('stop sharing with Maya', () => {
    test('revokes every share with her and re-keys what each covered, sealing again to everyone but her', async () => {
        const h = harness();
        await h.client.open('owner');
        const { stopped, rotated } = await stopSharingWith(MAYA, {
            ledger: h.ledger,
            shares: () => h.client.mySharing(),
            revoke: (target, shareId) => h.client.revokeShare(target, shareId),
            rotate: (target) => h.client.rotate(target),
        });
        await rotated;
        expect(stopped).toBe(2);
        expect(h.revoked.sort()).toEqual(['share-maya-A', 'share-maya-B']);
        // Both items she had were re-keyed; the new keys went to Sam alone.
        expect(h.sealedTo).toEqual({ A: [SAM], B: [] });
        // Nothing in the ledger names her any more, the share the server didn't list included.
        expect(h.ledgerState.shares).toEqual({ A: [SAM] });
    });
});

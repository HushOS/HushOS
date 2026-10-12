import { describe, expect, test } from 'vitest';
import type { DriveApi, NodeView, ServedIdentity } from './api';
import { createDriveClient, type Rpc, type SharingLedger } from './client';

/*
 * What gets sealed again is the owner's to say, not the server's. The server
 * lists shares and links on every rotation and upgrade; the client seals only
 * what the owner's ledger holds, so a grantee the server adds, or a share or
 * link the owner stopped, never gets the new key.
 */

const WS = 'ws';
const ROOT = 'root';
const A = 'folder-a';

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
        createdAt: '2026-10-12T00:00:00.000Z',
        updatedAt: '2026-10-12T00:00:00.000Z',
        envelopeSuite: 1,
    };
}

const identity = (id: string): ServedIdentity => ({
    encryptionPublicKey: `x25519-${id}`,
    signingPublicKey: `ed25519-${id}`,
    kem: { publicKey: `kem-${id}`, signature: `sig-${id}` },
});

function ledgerOf(state: Awaited<ReturnType<SharingLedger['read']>>): SharingLedger {
    return {
        read: async () => state,
        addShare: async () => {},
        removeShare: async () => {},
        addLink: async () => {},
        removeLink: async () => {},
    };
}

function harness() {
    const sealedFor: string[] = [];
    const resealed: string[] = [];
    const rotated: { shares: string[]; links: string[] }[] = [];
    let workCalls = 0;
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
            children: folderId === ROOT ? [node(A, ROOT)] : [],
            nextCursor: null,
        }),
        sharedByMe: async () => ({
            shares: ['g1', 'g2'].map((grantee) => ({
                id: `share-${grantee}`,
                suite: 1,
                node: node(A, ROOT),
                grantee: { id: grantee },
                granteeIdentity: identity(grantee),
            })),
            links: [],
        }),
        resealShare: async (_ws: string, shareId: string) => {
            resealed.push(shareId);
            return {};
        },
        startRotation: async () => ({ rotation: { targetEpoch: 9 } }),
        rotationWork: async () =>
            workCalls++ === 0
                ? {
                      done: false,
                      nextCursor: null,
                      nodes: [
                          {
                              ...node(A, ROOT),
                              depth: 1,
                              versions: [],
                              shares: ['g1', 'g2'].map((grantee) => ({
                                  id: `share-${grantee}`,
                                  granteeUserId: grantee,
                                  grantee: identity(grantee),
                              })),
                              links: ['l1', 'l2'].map((id) => ({
                                  id,
                                  hasPassword: false,
                                  secretEnvelope: 'se',
                              })),
                          },
                      ],
                  }
                : { done: true, nextCursor: null, nodes: [] },
        rotateNodes: async () => ({ results: [{ status: 'ok' }] }),
    } as unknown as DriveApi;
    const rpc = (async (operation: string, input: Record<string, unknown>) => {
        switch (operation) {
            case 'driveOpenWorkspace':
                return { workspaceId: WS, workspaceKeyVersion: 1 };
            case 'driveOpenNodes':
                return {
                    nodes: (input.nodes as { id: string }[]).map(() => ({
                        metadata: { name: 'x', mime: null, size: null, modified: null },
                    })),
                };
            case 'driveSealShare':
                sealedFor.push(input.granteeUserId as string);
                return { shareEnvelope: 'se' };
            case 'driveRotateNodes': {
                const nodes = input.nodes as {
                    shares: { id: string }[];
                    links: { id: string }[];
                }[];
                for (const n of nodes)
                    rotated.push({
                        shares: n.shares.map((s) => s.id),
                        links: n.links.map((l) => l.id),
                    });
                return {
                    nodes: nodes.map(() => ({
                        keyEnvelope: 'k',
                        rewrap: false,
                        metadataEnvelope: 'm',
                        versions: [],
                        shares: [],
                        links: [],
                    })),
                };
            }
            default:
                throw new Error(`unexpected ${operation}`);
        }
    }) as unknown as Rpc;
    const trustGrantee = async (granteeUserId: string, served: ServedIdentity) => ({
        encryptionPublicKey: `pinned-${granteeUserId}`,
        kemPublicKey: served.kem!.publicKey,
    });
    return { api, rpc, trustGrantee, sealedFor, resealed, rotated };
}

describe('sealing again', () => {
    test('the upgrade pass re-seals only shares the owner’s ledger holds', async () => {
        const h = harness();
        const client = createDriveClient(h.rpc, h.api, {
            trustGrantee: h.trustGrantee,
            ledger: ledgerOf({ shares: { [A]: ['g1'] }, links: {} }),
        });
        await client.open('owner');
        const result = await client.upgradeShares();
        // g2 is a share the server lists and the owner never made: counted, never sealed to.
        expect(h.sealedFor).toEqual(['g1']);
        expect(h.resealed).toEqual(['share-g1']);
        expect(result).toEqual({ resealed: 1, refused: 1 });
    });

    test('a rotation hands the worker only the ledger’s shares and links', async () => {
        const h = harness();
        const client = createDriveClient(h.rpc, h.api, {
            trustGrantee: h.trustGrantee,
            ledger: ledgerOf({ shares: { [A]: ['g1'] }, links: { l1: A, l2: 'another-node' } }),
        });
        await client.open('owner');
        await client.rotate(node(A, ROOT) as never);
        // l2 is in the ledger, but for another node: a server cannot move a link onto this one.
        expect(h.rotated).toEqual([{ shares: ['share-g1'], links: ['l1'] }]);
    });

    test('without a ledger nothing is sealed again, and without a pin check no share is', async () => {
        const h = harness();
        const client = createDriveClient(h.rpc, h.api, {});
        await client.open('owner');
        expect(await client.upgradeShares()).toEqual({ resealed: 0, refused: 0 });
        await client.rotate(node(A, ROOT) as never);
        expect(h.rotated).toEqual([{ shares: [], links: [] }]);
        expect(h.sealedFor).toEqual([]);
    });
});

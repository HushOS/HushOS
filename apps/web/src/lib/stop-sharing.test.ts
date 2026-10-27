// @vitest-environment node
import type { DriveApi, NodeView, ServedIdentity } from '@hushos/drive/api';
import { DriveApiError } from '@hushos/drive/api';
import { createDriveClient, type Rpc, type SharingLedger } from '@hushos/drive/client';
import { describe, expect, test } from 'vitest';
import {
    rekeyAll,
    resumeStopping,
    stopSharingWith,
    type StopRecord,
    type StopSharingParts,
    type StopWork,
} from './stop-sharing';

/*
 * Stop sharing with Maya (docs/optional-verification.md 6.6, 4.4), through the
 * real Drive client: every share this account made with her is revoked, and
 * each item it covered is re-keyed with her already out of the owner's
 * ledger, so the keys the worker seals again go to everyone else and never to
 * her. The server here keeps listing her shares on the re-keying walk, as a
 * stale or dishonest one would: only the ledger keeps her out. C is a folder
 * shared with her that is now in Trash, so the server's list of what this
 * account shares leaves it out; restoring it must not give it back to her.
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

/* The owner's settings as the app keeps this work: the ledger and what is owed beside it. */
function memoryWork(initial: StopRecord) {
    const state = structuredClone(initial);
    let saves = 0;
    const work: StopWork = {
        read: async () => structuredClone(state),
        save: async (change) => {
            const next = structuredClone(state);
            change(next);
            saves++;
            for (const key of Object.keys(state) as (keyof StopRecord)[]) delete state[key];
            Object.assign(state, next);
        },
    };
    return { work, state, saves: () => saves };
}

function harness() {
    // A and B shared with Maya, A with Sam too; C, shared with Maya, is in Trash: the server's
    // list of what this account shares leaves it out, but the item's own shares still name her.
    const record = memoryWork({
        shares: { A: [MAYA, SAM], B: [MAYA], C: [MAYA] },
    });
    const ledger: SharingLedger = {
        read: async () => ({ shares: (await record.work.read()).shares, links: {} }),
        addShare: async () => {},
        removeShare: async () => {},
        addLink: async () => {},
        removeLink: async () => {},
    };
    const listed = [
        { id: 'share-maya-A', nodeId: 'A', grantee: MAYA },
        { id: 'share-sam-A', nodeId: 'A', grantee: SAM },
        { id: 'share-maya-B', nodeId: 'B', grantee: MAYA },
        { id: 'share-maya-C', nodeId: 'C', grantee: MAYA },
    ];
    const trashed = new Set(['C']);
    const revoked: string[] = [];
    /* Revocations the server refuses once each, as a dropped connection would. */
    const failOnce = new Set<string>();
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
        children: async (_ws: string, folderId: string) => {
            if (trashed.has(folderId))
                throw new DriveApiError('This folder is in the trash.', 'trashed', 410);
            return {
                folder: node(folderId, folderId === ROOT ? null : ROOT),
                ancestors: folderId === ROOT ? [] : [node(ROOT, null)],
                children:
                    folderId === ROOT
                        ? ['A', 'B', 'C']
                              .filter((id) => !trashed.has(id))
                              .map((id) => node(id, ROOT))
                        : [],
                nextCursor: null,
            };
        },
        trashListing: async () => ({
            items: [...trashed].map((id) => ({ node: node(id, ROOT), ancestors: [] })),
            nextCursor: null,
        }),
        sharedByMe: async () => ({
            shares: listed
                .filter((share) => !revoked.includes(share.id) && !trashed.has(share.nodeId))
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
            if (failOnce.delete(shareId)) throw new Error('Failed to fetch');
            revoked.push(shareId);
            return {};
        },
        startRotation: async (_ws: string, nodeId: string) => ({
            rotation: { nodeId, targetEpoch: 3 },
        }),
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
    /* What the app hands Stop sharing (lib/rotation.ts), with a re-key walk that can be held. */
    const parts = (rekey?: () => Promise<unknown>): StopSharingParts => ({
        work: record.work,
        listed: () => client.sharedByMeIds(),
        sharesOf: async (nodeId) =>
            (await client.sharesOfNode(nodeId)).map((share) => ({
                id: share.id,
                granteeId: share.grantee.id,
            })),
        revoke: (_nodeId, shareId) => client.endShare(shareId),
        rekey: rekey ?? (() => rekeyAll(record.work, (nodeId) => client.rotateById(nodeId))),
    });
    return { client, record, parts, revoked, failOnce, sealedTo, trashed };
}

describe('stop sharing with Maya', () => {
    test('revokes every share with her and re-keys what each covered, an item in Trash included', async () => {
        const h = harness();
        await h.client.open('owner');
        const { stopped, rotated } = await stopSharingWith(MAYA, h.parts());
        await rotated;
        expect(stopped).toBe(3);
        expect(h.revoked.sort()).toEqual(['share-maya-A', 'share-maya-B', 'share-maya-C']);
        // Every item she had was re-keyed, the one in Trash too; the new keys went to Sam alone.
        expect(h.sealedTo).toEqual({ A: [SAM], B: [], C: [] });
        // Nothing in the ledger names her, and nothing is left owed.
        expect(h.record.state).toEqual({ shares: { A: [SAM] } });
    });

    test('a revocation that fails keeps what is owed: the retry finishes it and loses nothing', async () => {
        const h = harness();
        await h.client.open('owner');
        h.failOnce.add('share-maya-B');
        await expect(
            stopSharingWith(
                MAYA,
                h.parts(() => new Promise(() => {})),
            ),
        ).rejects.toThrow('Failed to fetch');
        // A's share ended before B's failed: A stays owed its re-key, B its revocation too.
        expect(h.revoked).toEqual(['share-maya-A']);
        expect(h.record.state.stopping?.[MAYA]).toEqual(['B', 'C']);
        expect(h.record.state.rekey).toEqual(['A', 'B', 'C']);
        // Opening Drive again (resumeStopping) revokes what is left and re-keys all three.
        await resumeStopping(h.parts());
        expect(h.revoked.sort()).toEqual(['share-maya-A', 'share-maya-B', 'share-maya-C']);
        expect(h.sealedTo).toEqual({ A: [SAM], B: [], C: [] });
        expect(h.record.state).toEqual({ shares: { A: [SAM] } });
    });

    test('every re-key owed is recorded before any runs, so a closed tab loses none of them', async () => {
        const h = harness();
        await h.client.open('owner');
        // The tab closes as the first re-key starts: the walk never gets past it.
        let started = 0;
        const { rotated } = await stopSharingWith(
            MAYA,
            h.parts(() =>
                rekeyAll(h.record.work, async () => {
                    started++;
                    return new Promise<boolean>(() => {});
                }),
            ),
        );
        void rotated;
        await tick();
        expect(started).toBe(1);
        expect(h.record.state.rekey).toEqual(['A', 'B', 'C']);
        // The next time Drive opens, all three are re-keyed and crossed off.
        await resumeStopping(h.parts());
        expect(h.sealedTo).toEqual({ A: [SAM], B: [], C: [] });
        expect(h.record.state.rekey).toBeUndefined();
    });

    test('a re-key that fails stops the walk with it and everything after it still owed', async () => {
        const record = memoryWork({ shares: {}, rekey: ['A', 'B', 'C'] });
        const done: string[] = [];
        await expect(
            rekeyAll(record.work, async (nodeId) => {
                if (nodeId === 'B') throw new Error('The rotation could not finish. Try again.');
                done.push(nodeId);
                return true;
            }),
        ).rejects.toThrow('could not finish');
        expect(done).toEqual(['A']);
        expect(record.state.rekey).toEqual(['B', 'C']);
        // An item deleted for good is crossed off without a rotation.
        const rest = await rekeyAll(record.work, async (nodeId) => nodeId !== 'B');
        expect(rest).toEqual({ rotated: 1 });
        expect(record.state.rekey).toBeUndefined();
    });
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

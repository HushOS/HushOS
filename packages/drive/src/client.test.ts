import { describe, expect, test } from 'vitest';
import type { DriveApi, NodeView, ServedIdentity } from './api';
import { createDriveClient, type Rpc, type SharingLedger } from './client';
import { integrityIssues } from './trust';

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

function ledgerOf(state: Awaited<ReturnType<SharingLedger['read']>>): SharingLedger {
    return {
        read: async () => state,
        addShare: async () => {},
        removeShare: async () => {},
        addLink: async () => {},
        removeLink: async () => {},
    };
}

function harness(
    shareSuites: Record<string, 1 | 2 | 3 | 4> = {},
    /* What the worker calls the root's metadata; A's is always someone not checked. */
    rootVerdict = 'verified',
) {
    const sealedFor: string[] = [];
    const resealed: string[] = [];
    const rotated: { shares: string[]; links: string[] }[] = [];
    const wired: unknown[] = [];
    const verified: { signers: unknown; nodes: unknown[] }[] = [];
    const opened: { granterSigningPublicKey: string | null }[] = [];
    const rotatedWith: unknown[] = [];
    const settled: { commit: string[]; drop: string[] } = { commit: [], drop: [] };
    const sealedMetadata: { nodeId: string; signAs: unknown }[] = [];
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
                suite: shareSuites[grantee] ?? 1,
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
        rename: async (_ws: string, nodeId: string) => ({
            node: node(nodeId, nodeId === ROOT ? null : ROOT),
        }),
        rotateNodes: async (_ws: string, _root: string, nodes: unknown[]) => {
            wired.push(...nodes);
            return {
                results: (nodes as { id: string }[]).map((n) => ({ id: n.id, status: 'ok' })),
            };
        },
        sharedWithMe: async () => ({
            shares: [
                {
                    id: 'received',
                    workspaceId: 'their-ws',
                    role: 'viewer',
                    keyEpoch: 3,
                    shareEnvelope: 'env',
                    prevShareEnvelope: null,
                    prevKeyEpoch: null,
                    createdAt: '',
                    changeSeq: 0,
                    granter: {
                        id: 'granter',
                        name: 'Maya',
                        email: 'maya@example.com',
                        ...identity('granter-now'),
                        keyVersion: 2,
                    },
                    node: { ...node('shared', null), workspaceId: 'their-ws' },
                },
            ],
        }),
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
            case 'driveVerify': {
                const nodes = input.nodes as { id: string; versions: { id: string }[] }[];
                verified.push({ signers: input.signers, nodes });
                return {
                    nodes: nodes.map((n) => ({
                        id: n.id,
                        metadata: n.id === A ? 'unknown-signer' : rootVerdict,
                        versions: n.versions.map((v) => ({ id: v.id, integrity: 'bad-signature' })),
                    })),
                };
            }
            case 'driveOpenShare':
                opened.push({
                    granterSigningPublicKey: input.granterSigningPublicKey as string | null,
                });
                if (input.granterSigningPublicKey !== 'ed25519-granter-now')
                    throw new Error('This share isn’t signed by its granter.');
                return { opened: true };
            case 'driveOpenLink':
                return { opened: true };
            case 'driveSealMetadata':
                sealedMetadata.push({ nodeId: input.nodeId as string, signAs: input.signAs });
                return { metadataEnvelope: 'renamed', metadataSignature: 'rsig' };
            case 'driveRotateNodes': {
                const nodes = input.nodes as {
                    shares: { id: string }[];
                    links: { id: string }[];
                }[];
                rotatedWith.push(input.signers);
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
                        metadataSignature: 'msig',
                        versions: [],
                        shares: [],
                        links: [],
                    })),
                };
            }
            case 'driveRotateCommit':
            case 'driveRotateDrop': {
                const ids = input.nodeIds as string[];
                settled[operation === 'driveRotateCommit' ? 'commit' : 'drop'].push(...ids);
                return operation === 'driveRotateCommit'
                    ? { committed: ids.length }
                    : { dropped: ids.length };
            }
            default:
                throw new Error(`unexpected ${operation}`);
        }
    }) as unknown as Rpc;
    const trustGrantee = async (granteeUserId: string, served: ServedIdentity) => ({
        encryptionPublicKey: `pinned-${granteeUserId}`,
        kemPublicKey: served.kemPublicKey!,
    });
    return {
        api,
        rpc,
        trustGrantee,
        sealedFor,
        resealed,
        rotated,
        rotatedWith,
        settled,
        wired,
        verified,
        opened,
        sealedMetadata,
    };
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
            signers: async () => ({}),
        });
        await client.open('owner');
        await client.rotate(node(A, ROOT) as never);
        // l2 is in the ledger, but for another node: a server cannot move a link onto this one.
        expect(h.rotated).toEqual([{ shares: ['share-g1'], links: ['l1'] }]);
    });

    test('without a ledger nothing is sealed again, and without a pin check no share is', async () => {
        const h = harness();
        const client = createDriveClient(h.rpc, h.api, { signers: async () => ({}) });
        await client.open('owner');
        expect(await client.upgradeShares()).toEqual({ resealed: 0, refused: 0 });
        await client.rotate(node(A, ROOT) as never);
        expect(h.rotated).toEqual([{ shares: [], links: [] }]);
        expect(h.sealedFor).toEqual([]);
    });
});

describe('sealing again after a succession', () => {
    test('suite 4 shares are sealed again only for grantees whose pin followed a succession', async () => {
        const h = harness({ g1: 4, g2: 4 });
        const done: string[][] = [];
        const client = createDriveClient(h.rpc, h.api, {
            trustGrantee: h.trustGrantee,
            ledger: ledgerOf({ shares: { [A]: ['g1', 'g2'] }, links: {} }),
            resealPending: async () => ['g2'],
            resealedTo: async (ids) => {
                done.push(ids);
            },
        });
        await client.open('owner');
        expect(await client.upgradeShares()).toEqual({ resealed: 1, refused: 0 });
        expect(h.sealedFor).toEqual(['g2']);
        // Every share to g2 went through, so the pin may stop asking.
        expect(done).toEqual([['g2']]);
    });

    test('a grantee whose pin refuses stays owed, and replacing one’s own keys seals every share', async () => {
        const h = harness({ g1: 4, g2: 4 });
        const done: string[][] = [];
        const client = createDriveClient(h.rpc, h.api, {
            trustGrantee: async (grantee, served) => {
                if (grantee === 'g2') throw new Error('changed');
                return h.trustGrantee(grantee, served);
            },
            ledger: ledgerOf({ shares: { [A]: ['g1', 'g2'] }, links: {} }),
            resealPending: async () => ['g2'],
            resealedTo: async (ids) => {
                done.push(ids);
            },
        });
        await client.open('owner');
        expect(await client.upgradeShares({ all: true })).toEqual({ resealed: 1, refused: 1 });
        expect(h.sealedFor).toEqual(['g1']);
        expect(done).toEqual([]);
    });
});

describe('finishing a replacement of one’s own keys', () => {
    test('an interrupted re-seal is finished on the next pass, and only then marked done', async () => {
        const h = harness({ g1: 4, g2: 4 });
        let pending = true;
        let failOnce = true;
        const api = {
            ...h.api,
            resealShare: async (ws: string, shareId: string, input: unknown) => {
                if (shareId === 'share-g2' && failOnce) {
                    failOnce = false;
                    throw new Error('dropped');
                }
                return h.api.resealShare(ws, shareId, input as never);
            },
        } as DriveApi;
        const client = createDriveClient(h.rpc, api, {
            trustGrantee: h.trustGrantee,
            ledger: ledgerOf({ shares: { [A]: ['g1', 'g2'] }, links: {} }),
            resealAll: async () => pending,
            resealedAll: async () => {
                pending = false;
            },
        });
        await client.open('owner');
        await client.upgradeShares();
        // One share went through, one did not: still owed.
        expect(h.resealed).toEqual(['share-g1']);
        expect(pending).toBe(true);
        await client.upgradeShares();
        expect(h.resealed).toEqual(['share-g1', 'share-g1', 'share-g2']);
        expect(pending).toBe(false);
        // Done: suite 4 shares are left alone from now on.
        await client.upgradeShares();
        expect(h.resealed).toHaveLength(3);
    });
});

describe('signatures', () => {
    test('a rotation sends the signatures the worker made beside what it re-sealed', async () => {
        const h = harness();
        const signers = { maya: { current: 'maya-key', retired: [] } };
        const client = createDriveClient(h.rpc, h.api, {
            trustGrantee: h.trustGrantee,
            ledger: ledgerOf({ shares: {}, links: {} }),
            signers: async () => signers,
        });
        await client.open('owner');
        await client.rotate(node(A, ROOT) as never);
        expect(h.wired).toMatchObject([{ id: A, rotated: { metadataSignature: 'msig' } }]);
        // The worker got the trust set to check each record against before re-signing it.
        expect(h.rotatedWith).toEqual([signers]);
        // The keys it made become the node's own only once the server applied the batch.
        expect(h.settled).toEqual({ commit: [A], drop: [] });
    });

    test('a rotation that cannot load the trust set stops before anything is re-sealed', async () => {
        for (const signers of [
            undefined,
            async () => {
                throw new Error('settings refused as rolled back');
            },
        ]) {
            const h = harness();
            const client = createDriveClient(h.rpc, h.api, {
                trustGrantee: h.trustGrantee,
                ledger: ledgerOf({ shares: {}, links: {} }),
                signers,
            });
            await client.open('owner');
            await expect(client.rotate(node(A, ROOT) as never)).rejects.toThrow();
            expect(h.rotated).toEqual([]);
            expect(h.wired).toEqual([]);
        }
    });

    test('a listing carries each row’s verdict; an item without a version has none', async () => {
        const h = harness();
        const signers = { maya: { current: 'maya-key', retired: ['maya-old'] } };
        const client = createDriveClient(h.rpc, h.api, { signers: async () => signers });
        await client.open('owner');
        const listing = await client.listFolder(ROOT);
        expect(listing.children.map((child) => [child.id, child.integrity])).toEqual([
            [A, { metadata: 'unknown-signer', version: null }],
        ]);
        expect(h.verified.at(-1)!.signers).toEqual(signers);
    });

    test('a check that cannot run marks every row unchecked, never clean', async () => {
        const failing = [
            // No trust set wired up at all.
            { signers: undefined, rpc: undefined },
            // The settings would not load (refused as rolled back, offline).
            {
                signers: async () => {
                    throw new Error('The server sent older settings than this device has seen.');
                },
                rpc: undefined,
            },
            // The worker's check throws.
            { signers: async () => ({}), rpc: 'driveVerify' },
        ];
        for (const { signers, rpc } of failing) {
            const h = harness();
            const throwing = (async (operation: string, input: unknown) => {
                if (operation === rpc) throw new Error('worker died');
                return (h.rpc as unknown as (o: string, i: unknown) => Promise<unknown>)(
                    operation,
                    input,
                );
            }) as unknown as typeof h.rpc;
            const client = createDriveClient(throwing, h.api, { signers });
            await client.open('owner');
            const listing = await client.listFolder(ROOT);
            expect(listing.children.map((child) => child.integrity)).toEqual([
                { metadata: 'unchecked', version: null },
            ]);
            expect(integrityIssues(listing.children[0]!)).toHaveLength(1);
        }
    });

    test('nothing reached through a link is checked or marked', async () => {
        const h = harness();
        const linkApi = {
            open: async () => ({
                link: {
                    id: 'l',
                    workspaceId: 'linked-ws',
                    keyEpoch: 2,
                    hasPassword: false,
                    kdfVersion: 2,
                    linkSalt: 's',
                    linkEnvelope: 'e',
                    expiresAt: null,
                },
                node: { ...node('linked', null), workspaceId: 'linked-ws' },
            }),
        };
        const client = createDriveClient(h.rpc, h.api, {
            signers: async () => ({}),
            linkApi: linkApi as never,
        });
        const { node: opened } = await client.openLink('token', 'secret', null);
        expect(opened.integrity).toBeNull();
        expect(h.verified).toEqual([]);
    });

    test('a rename re-signs as one’s own only metadata that verified', async () => {
        const h = harness();
        const client = createDriveClient(h.rpc, h.api, { signers: async () => ({}) });
        await client.open('owner');
        const listing = await client.listFolder(ROOT);
        // The harness's worker calls A's metadata someone not checked, and the root's verified.
        await client.rename(listing.children[0]!, 'renamed');
        await client.rename(listing.folder, 'top');
        expect(h.sealedMetadata).toEqual([
            { nodeId: A, signAs: 'resealed' },
            { nodeId: ROOT, signAs: 'ordinary' },
        ]);
    });

    test('a rename keeps a copy saved from a link saved only when it verified as saved', async () => {
        const h = harness({}, 'saved-from-link');
        const client = createDriveClient(h.rpc, h.api, { signers: async () => ({}) });
        await client.open('owner');
        const listing = await client.listFolder(ROOT);
        await client.rename(listing.folder, 'top');
        await client.rename(listing.children[0]!, 'renamed');
        expect(h.sealedMetadata).toEqual([
            { nodeId: ROOT, signAs: 'saved' },
            { nodeId: A, signAs: 'resealed' },
        ]);
    });

    test('a rename that cannot check the record re-locks it rather than vouch for it', async () => {
        const h = harness();
        let failing = false;
        const client = createDriveClient(h.rpc, h.api, {
            signers: async () => {
                if (failing) throw new Error('settings refused as rolled back');
                return {};
            },
        });
        await client.open('owner');
        const listing = await client.listFolder(ROOT);
        failing = true;
        await client.rename(listing.folder, 'top');
        expect(h.sealedMetadata).toEqual([{ nodeId: ROOT, signAs: 'resealed' }]);
    });

    test('a share sealed under keys the granter replaced asks for it to be shared again', async () => {
        const h = harness();
        const client = createDriveClient(h.rpc, h.api, {
            trustGranter: async () => ({
                signingPublicKey: 'ed25519-granter-newer',
                mlDsaPublicKey: 'ml-dsa-granter-newer',
                replaced: { name: 'Maya' },
            }),
            signers: async () => ({}),
        });
        await client.open('owner');
        const [mount] = await client.mountShares();
        expect(mount!.error).toBe(
            'Maya replaced their sharing keys since sharing this. Ask Maya to share it again.',
        );
    });

    test('a share is opened against the granter’s current key only', async () => {
        const h = harness();
        const client = createDriveClient(h.rpc, h.api, {
            trustGranter: async () => ({
                signingPublicKey: 'ed25519-granter-now',
                mlDsaPublicKey: 'ml-dsa-granter-now',
            }),
            signers: async () => ({}),
        });
        await client.open('owner');
        const [mount] = await client.mountShares();
        expect(mount!.error).toBeNull();
        expect(h.opened.map((o) => o.granterSigningPublicKey)).toEqual(['ed25519-granter-now']);
    });
});

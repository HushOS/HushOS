import { describe, expect, test } from 'vitest';
import type { DriveApi, NodeView, ServedIdentity } from './api';
import { createDriveClient, type Rpc, type SharingLedger } from './client';
import type { TreeMirror } from './mirror';
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
    const groupWith: unknown[] = [];
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
                groupWith.push(input.group ?? null);
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
        groupWith,
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

    test('a family folder’s walk whose trust fails to load stops before the worker re-signs anything', async () => {
        const failing = harness();
        const refused = createDriveClient(failing.rpc, failing.api, {
            trustGrantee: failing.trustGrantee,
            signers: async () => ({}),
            rotationTrust: async () => {
                throw new Error('HushOS couldn’t load the family’s members.');
            },
        });
        await refused.open('owner');
        await expect(refused.walkRotation({ nodeId: A, targetEpoch: 9 })).rejects.toThrow(
            /family’s members/,
        );
        expect(failing.rotated).toEqual([]);
        expect(failing.wired).toEqual([]);
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

/*
 * Re-keyed records (docs/integrity-design.md, "Re-keyed records"): a row a
 * rotation re-keyed reads as its writer's, with the re-keyer kept apart,
 * where the verifier read the origin (family folders, rekeyedFor); one it did
 * not read reads by its legacy columns; and a
 * rotation carries a served origin to the worker and sends back only what the
 * worker made (the server copies the origin itself).
 */
describe('re-keyed records', () => {
    const SAM = 'sam';
    const MAYA = 'maya';
    const rekey = {
        origin: { envelope: 'oe', signer: { id: SAM }, signature: 'osig', keyEnvelope: 'ok' },
        signature: 'rsig',
    };
    const rekeyedA = (): NodeView => ({
        ...node(A, ROOT),
        metadataSigner: { id: MAYA },
        metadataSignature: null,
        metadataRekey: rekey,
    });
    function withRekeyed(answer: (input: { id: string }) => Record<string, unknown>) {
        const h = harness();
        const sent: unknown[] = [];
        const api = {
            ...h.api,
            children: async (_ws: string, folderId: string) => ({
                folder: node(folderId, folderId === ROOT ? null : ROOT),
                ancestors: folderId === ROOT ? [] : [node(ROOT, null)],
                children: folderId === ROOT ? [rekeyedA()] : [],
                nextCursor: null,
            }),
        } as unknown as DriveApi;
        const rpc = (async (operation: string, input: Record<string, unknown>) => {
            if (operation !== 'driveVerify')
                return (h.rpc as unknown as (o: string, i: unknown) => Promise<unknown>)(
                    operation,
                    input,
                );
            const nodes = input.nodes as { id: string }[];
            sent.push(...nodes);
            return { nodes: nodes.map((n) => ({ id: n.id, versions: [], ...answer(n) })) };
        }) as unknown as Rpc;
        return { client: createDriveClient(rpc, api, { signers: async () => ({}) }), sent };
    }

    test('a re-keyed row reads as its writer’s, the re-keyer apart, and the worker gets what opens it', async () => {
        const { client, sent } = withRekeyed((n) =>
            n.id === A
                ? { metadata: 'verified', metadataRekey: { rekeyer: 'verified', bound: true } }
                : { metadata: 'verified' },
        );
        await client.open('owner');
        const listing = await client.listFolder(ROOT);
        const row = listing.children[0]!;
        expect(row.integrity).toEqual({
            metadata: 'verified',
            version: null,
            rekeyed: {
                metadata: {
                    writer: { id: SAM },
                    by: { id: MAYA },
                    integrity: 'verified',
                    via: null,
                    bound: true,
                },
                version: null,
            },
        });
        expect(integrityIssues(row)).toEqual([]);
        // The node's epoch (its key there opens both envelopes) and the origin, the writer by id.
        expect(sent.find((n) => (n as { id: string }).id === A)).toMatchObject({
            keyEpoch: 2,
            metadataSigner: MAYA,
            metadataRekey: {
                origin: { envelope: 'oe', signerId: SAM, signature: 'osig', keyEnvelope: 'ok' },
                signature: 'rsig',
            },
        });
    });

    test('an origin the verifier did not read (a personal row, for now) is read by the legacy columns, as shipped apps read it', async () => {
        const { client } = withRekeyed(() => ({ metadata: 'resealed' }));
        await client.open('owner');
        const row = (await client.listFolder(ROOT)).children[0]!;
        expect(row.integrity).toEqual({ metadata: 'resealed', version: null });
        // Named after who signed the legacy columns (the re-keyer), never the unread origin's writer.
        expect(integrityIssues(row)).toEqual([
            { record: 'metadata', integrity: 'resealed', signer: { id: MAYA } },
        ]);
    });

    test('a rotation carries the served origin to the worker and sends back only the re-key it made', async () => {
        const h = harness();
        const toWorker: unknown[] = [];
        const api = {
            ...h.api,
            rotationWork: async () =>
                toWorker.length === 0
                    ? {
                          done: false,
                          nextCursor: null,
                          nodes: [
                              {
                                  ...rekeyedA(),
                                  depth: 1,
                                  versions: [],
                                  shares: [],
                                  links: [],
                              },
                          ],
                      }
                    : { done: true, nextCursor: null, nodes: [] },
        } as unknown as DriveApi;
        const rpc = (async (operation: string, input: Record<string, unknown>) => {
            if (operation !== 'driveRotateNodes')
                return (h.rpc as unknown as (o: string, i: unknown) => Promise<unknown>)(
                    operation,
                    input,
                );
            toWorker.push(...(input.nodes as unknown[]));
            return {
                nodes: (input.nodes as { id: string }[]).map((n) => ({
                    id: n.id,
                    keyEnvelope: 'k',
                    metadataEnvelope: 'm',
                    metadataSignature: null,
                    metadataRekey: { originKeyEnvelope: 'wrap', signature: 'rekeyed' },
                    versions: [],
                    shares: [],
                    links: [],
                })),
            };
        }) as unknown as Rpc;
        const client = createDriveClient(rpc, api, {
            trustGrantee: h.trustGrantee,
            ledger: ledgerOf({ shares: {}, links: {} }),
            signers: async () => ({}),
        });
        await client.open('owner');
        await client.rotate(node(A, ROOT) as never);
        expect(toWorker).toMatchObject([
            { id: A, metadataRekey: { origin: { signerId: SAM }, signature: 'rsig' } },
        ]);
        // No legacy signature beside it, and no origin of the client's: the server copies its own.
        expect(h.wired).toEqual([
            expect.objectContaining({
                id: A,
                rotated: expect.objectContaining({
                    metadataSignature: null,
                    metadataRekey: { originKeyEnvelope: 'wrap', signature: 'rekeyed' },
                }),
            }),
        ]);
        expect(JSON.stringify(h.wired)).not.toContain('osig');
    });
    test('a family walk refuses a node the server lists a share or link on, the walker’s own included, and never hands it to the worker', async () => {
        for (const served of [
            { shares: true, links: false },
            { shares: false, links: true },
        ]) {
            const h = harness();
            // The node as the harness serves it: two shares and two links.
            const listed = (await h.api.rotationWork(WS, A, null)).nodes[0]!;
            let calls = 0;
            const api = {
                ...h.api,
                // Served until the server applies it, which a refused node never is.
                rotationWork: async () => {
                    calls++;
                    if (h.wired.length) return { done: true, nextCursor: null, nodes: [] };
                    return {
                        done: false,
                        nextCursor: null,
                        nodes: [
                            {
                                ...listed,
                                shares: served.shares ? listed.shares : [],
                                links: served.links ? listed.links : [],
                            },
                        ],
                    };
                },
            } as unknown as DriveApi;
            const trusted: string[] = [];
            const client = createDriveClient(h.rpc, api, {
                trustGrantee: async (grantee, identity) => {
                    trusted.push(grantee);
                    return h.trustGrantee(grantee, identity);
                },
                // Every share and link served is in the walker’s own ledger: still refused.
                ledger: ledgerOf({ shares: { [A]: ['g1', 'g2'] }, links: { l1: A, l2: A } }),
                signers: async () => ({}),
                rotationTrust: async () => ({ groupId: 'family', staged: null, writers: [] }),
            });
            await client.open('owner');
            const walk = client.rotate(node(A, ROOT) as never);
            await expect(walk).rejects.toThrow(/has shares or links/);
            // The message names no one to blame: the share may well be the walker’s own.
            await expect(walk).rejects.not.toThrow(/server/);
            // Bounded, and the node never reached the worker or the server, sealed to nobody.
            expect(calls).toBe(4);
            expect(h.rotated).toEqual([]);
            expect(h.wired).toEqual([]);
            expect(trusted).toEqual([]);
        }
    });
});

describe('a rotation stopped mid-batch', () => {
    test('a batch the worker could not sign drops every key it made, so a retry in the same tab walks the node again', async () => {
        const h = harness();
        // The worker's pending keys, as its ledger keeps them: a node pending is not walked again.
        const pending = new Set<string>();
        let signs = false;
        const api = {
            ...h.api,
            rotationWork: async () =>
                h.wired.length
                    ? { done: true, nextCursor: null, nodes: [] }
                    : {
                          done: false,
                          nextCursor: null,
                          nodes: [
                              { ...node(A, ROOT), depth: 1, versions: [], shares: [], links: [] },
                          ],
                      },
        } as unknown as DriveApi;
        const rpc = (async (operation: string, input: Record<string, unknown>) => {
            const ids = (input.nodeIds as string[] | undefined) ?? [];
            switch (operation) {
                case 'driveRotateNodes':
                    return {
                        nodes: (input.nodes as { id: string }[]).map((n) => {
                            if (pending.has(n.id))
                                return {
                                    id: n.id,
                                    error: 'This item changed since it was opened. Refresh and retry.',
                                };
                            pending.add(n.id);
                            return {
                                id: n.id,
                                keyEnvelope: 'k',
                                rewrap: false,
                                metadataEnvelope: 'm',
                                metadataSignature: signs ? 'msig' : null,
                                versions: [],
                                shares: [],
                                links: [],
                            };
                        }),
                    };
                case 'driveRotateCommit':
                case 'driveRotateDrop':
                    for (const id of ids) pending.delete(id);
                    return (h.rpc as unknown as (o: string, i: unknown) => Promise<unknown>)(
                        operation,
                        input,
                    );
                default:
                    return (h.rpc as unknown as (o: string, i: unknown) => Promise<unknown>)(
                        operation,
                        input,
                    );
            }
        }) as unknown as Rpc;
        const client = createDriveClient(rpc, api, {
            trustGrantee: h.trustGrantee,
            ledger: ledgerOf({ shares: {}, links: {} }),
            signers: async () => ({}),
        });
        await client.open('owner');
        await expect(client.rotate(node(A, ROOT) as never)).rejects.toThrow(
            /could not sign what it sealed/,
        );
        expect(h.wired).toEqual([]);
        expect(h.settled).toEqual({ commit: [], drop: [A] });
        expect(pending.size).toBe(0);
        // The retry, without a reload: the node is walked afresh and lands.
        signs = true;
        await expect(client.rotate(node(A, ROOT) as never)).resolves.toEqual({ rotated: 1 });
        expect(h.wired).toMatchObject([{ id: A, rotated: { metadataSignature: 'msig' } }]);
    });
});

describe('sealing again outside one’s own Drive', () => {
    test('a share this account made in a family folder is counted refused and never sealed, even when its ledger lists it', async () => {
        const h = harness({ g1: 4, g2: 4 });
        const familyNode = { ...node('family-node', 'family-root'), workspaceId: 'family-ws' };
        const api = {
            ...h.api,
            sharedByMe: async () => ({
                shares: [
                    {
                        id: 'share-own',
                        suite: 4,
                        node: node(A, ROOT),
                        grantee: { id: 'g1' },
                        granteeIdentity: identity('g1'),
                    },
                    {
                        id: 'share-family',
                        suite: 4,
                        node: familyNode,
                        grantee: { id: 'g1' },
                        granteeIdentity: identity('g1'),
                    },
                ],
                links: [],
            }),
        } as unknown as DriveApi;
        const client = createDriveClient(h.rpc, api, {
            trustGrantee: h.trustGrantee,
            ledger: ledgerOf({ shares: { [A]: ['g1'], 'family-node': ['g1'] }, links: {} }),
        });
        await client.open('owner');
        expect(await client.upgradeShares({ all: true })).toEqual({ resealed: 1, refused: 1 });
        expect(h.resealed).toEqual(['share-own']);
        expect(h.sealedFor).toEqual(['g1']);
    });
});

describe('a lock in the middle of sealing again', () => {
    test('shares left when the client locks stay owed: failed, never refused, and the grantee is not marked done', async () => {
        const h = harness();
        const B = 'folder-b';
        let pendingAll = true;
        const done: string[][] = [];
        let client: ReturnType<typeof createDriveClient>;
        const api = {
            ...h.api,
            sharedByMe: async () => ({
                shares: [A, B].map((id) => ({
                    id: `share-${id}`,
                    suite: 4,
                    node: node(id, ROOT),
                    grantee: { id: 'g1' },
                    granteeIdentity: identity('g1'),
                })),
                links: [],
            }),
            // The person locks as soon as the first share is through.
            resealShare: async (ws: string, shareId: string, input: unknown) => {
                const result = await h.api.resealShare(ws, shareId, input as never);
                client.close();
                return result;
            },
        } as unknown as DriveApi;
        client = createDriveClient(h.rpc, api, {
            trustGrantee: h.trustGrantee,
            ledger: ledgerOf({ shares: { [A]: ['g1'], [B]: ['g1'] }, links: {} }),
            resealPending: async () => ['g1'],
            resealedTo: async (ids) => {
                done.push(ids);
            },
            resealAll: async () => pendingAll,
            resealedAll: async () => {
                pendingAll = false;
            },
        });
        await client.open('owner');
        expect(await client.upgradeShares()).toEqual({ resealed: 1, refused: 0 });
        expect(h.resealed).toEqual([`share-${A}`]);
        // The share to B never went through: g1 is still owed it, and so is the whole re-seal.
        expect(done).toEqual([]);
        expect(pendingAll).toBe(true);
    });
});

/*
 * Signing out clears the tree mirrored on this device, then closes the client. A pull of the
 * feed already on its way (the app's poll, or the catalogue being built) must not write the
 * tree back once the client is closed: the folder shape, sizes and times would outlive the
 * sign-out on disk.
 */
describe('a pull of the feed on its way when the client closes', () => {
    function mirrored() {
        const applied: number[] = [];
        let cursor = 0;
        const mirror: TreeMirror = {
            cursor: async () => cursor,
            apply: async (_ws, _from, _changes, next) => {
                applied.push(next);
                cursor = next;
                return [];
            },
            rows: async () => [],
            snapshot: async () => ({ cursor, rows: [] }),
            dropBelow: async () => {},
            clear: async () => {
                cursor = 0;
            },
            workspaces: async () => [],
        };
        return { mirror, applied };
    }

    test('writes nothing after close()', async () => {
        const h = harness();
        const { mirror, applied } = mirrored();
        let answer!: (page: Awaited<ReturnType<DriveApi['changes']>>) => void;
        const api = {
            ...h.api,
            changes: () => new Promise((resolve) => (answer = resolve)),
        } as unknown as DriveApi;
        const client = createDriveClient(h.rpc, api, { signers: async () => ({}), mirror });
        const building = client.buildCatalogue(WS);
        await expect.poll(() => answer).toBeDefined();
        client.close();
        answer({
            changes: [{ kind: 'node', changeSeq: 1, node: node(A, ROOT) }],
            nextCursor: 1,
            hasMore: false,
        } as unknown as Awaited<ReturnType<DriveApi['changes']>>);
        await building;
        expect(applied).toEqual([]);
    });

    test('still writes when nothing closed it', async () => {
        const h = harness();
        const { mirror, applied } = mirrored();
        const api = {
            ...h.api,
            changes: async () => ({
                changes: [{ kind: 'node', changeSeq: 1, node: node(A, ROOT) }],
                nextCursor: 1,
                hasMore: false,
            }),
        } as unknown as DriveApi;
        const client = createDriveClient(h.rpc, api, { signers: async () => ({}), mirror });
        await client.buildCatalogue(WS);
        expect(applied).toEqual([1]);
    });
});

describe('trash and restore', () => {
    /*
     * Trashing and restoring in place change only where an item stands, so the
     * client answers with the node it already opened and never asks the worker
     * to open it again. A server's answer carrying other envelopes must not
     * reach that node either: its metadata was decrypted from the old ones.
     */
    const held = {
        ...node(A, ROOT),
        metadata: { name: 'Report.pdf', mime: 'application/pdf', size: 10, modified: null },
        name: 'Report.pdf',
        content: null,
        openError: null,
        integrity: { metadata: 'verified', version: null },
    } as Parameters<ReturnType<typeof createDriveClient>['trash']>[0];
    const served = (trashedAt: string | null): NodeView => ({
        ...node(A, ROOT),
        keyEnvelope: 'swapped-key',
        metadataEnvelope: 'swapped-metadata',
        metadataVersion: 7,
        trashedAt,
        changeSeq: 42,
    });

    function setup() {
        const calls: { operation: string; input: Record<string, unknown> }[] = [];
        const rpc = (async (operation: string, input: Record<string, unknown>) => {
            calls.push({ operation, input });
            switch (operation) {
                case 'driveRewrapNode':
                    return { keyEnvelope: 'rewrapped' };
                case 'driveOpenNodes':
                    return {
                        nodes: (input.nodes as unknown[]).map(() => ({
                            metadata: {
                                name: 'Report.pdf',
                                mime: null,
                                size: null,
                                modified: null,
                            },
                        })),
                    };
                default:
                    throw new Error(`unexpected ${operation}`);
            }
        }) as unknown as Rpc;
        const api = {
            trash: async () => ({ node: served('2026-10-20T10:00:00.000Z') }),
            restore: async (
                _ws: string,
                _id: string,
                toRoot?: { parentKeyEpoch: number; keyEnvelope: string },
            ) => ({
                node: toRoot
                    ? {
                          ...served(null),
                          parentKeyEpoch: toRoot.parentKeyEpoch,
                          keyEnvelope: toRoot.keyEnvelope,
                      }
                    : served(null),
            }),
        } as unknown as DriveApi;
        const client = createDriveClient(rpc, api, {
            verify: async (_ws, nodes) =>
                nodes.map((n) => ({
                    id: n.id,
                    metadata: 'verified' as const,
                    via: null,
                    metadataRekey: null,
                    versions: [],
                })),
        });
        return { client, calls };
    }

    test('trashing asks nothing of the worker and keeps the opened node, taking only where it stands', async () => {
        const { client, calls } = setup();
        const trashed = await client.trash(held);
        expect(calls.map((call) => call.operation)).toEqual([]);
        expect(trashed).toEqual({
            ...held,
            trashedAt: '2026-10-20T10:00:00.000Z',
            changeSeq: 42,
        });
    });

    test('restoring in place asks nothing of the worker and keeps the opened node', async () => {
        const { client, calls } = setup();
        const restored = await client.restore({ ...held, trashedAt: '2026-10-20T10:00:00.000Z' });
        expect(calls.map((call) => call.operation)).toEqual([]);
        expect(restored).toEqual({ ...held, trashedAt: null, changeSeq: 42 });
    });

    test('restoring to the top folder opens the re-wrapped key under its new parent', async () => {
        const { client, calls } = setup();
        const top = { ...held, id: ROOT, parentId: null, keyEpoch: 5 };
        const restored = await client.restore(
            { ...held, parentId: 'trashed-folder', trashedAt: '2026-10-20T10:00:00.000Z' },
            top,
        );
        expect(calls.map((call) => call.operation)).toEqual(['driveRewrapNode', 'driveOpenNodes']);
        const [opened] = calls[1]!.input.nodes as {
            parentKeyEpoch: number;
            keyEnvelope: string;
        }[];
        expect(opened).toMatchObject({ parentKeyEpoch: 5, keyEnvelope: 'rewrapped' });
        expect(restored).toMatchObject({ keyEnvelope: 'rewrapped', parentKeyEpoch: 5 });
    });
});

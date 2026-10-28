import type { CryptoRequests, GroupPin, RosterCallBody } from '@hushos/crypto';
import { keyCommitment, type PinKeys } from '@hushos/crypto/pins';
import { GroupApiError, type ChainHead, type GroupsApi } from './api';
import {
    familyGuardOf,
    type GroupContext,
    type GroupOperation,
    type GroupSettings,
    type RotationSource,
    type SettingsAccess,
} from './context';
import { createMemoryFamilyGuard } from '@/lib/contact-guard';
import { createMemoryGroupStore, type GroupStore } from './store';

/*
 * A stand-in for everything the families data layer runs on, for its unit
 * tests: a server that answers the roster routes from a script and keeps a
 * head, a worker that records what it was asked (the real one is tested in
 * packages/crypto), a settings document with the server's compare-and-set,
 * and a Web Lock that says whether it is held. What the tests check is what
 * the data layer decided: what it sent, kept, dropped, wiped and wrote.
 */

export const GROUP = '0b0e0f6c-6a55-4e5b-9d1a-1f9e2f0c0a01';
export const USER = '5d2c1b0a-3f4e-4d5c-8b7a-6e5f4d3c2b1a';
export const AREA = 'a1a1a1a1-0000-4000-8000-000000000001';
export const AREA_2 = 'a2a2a2a2-0000-4000-8000-000000000002';

export type Answer = ChainHead | GroupApiError;
export const refusal = (status: number, code: string | null, data: unknown = null) =>
    new GroupApiError(`refused: ${code ?? status}`, status, code as never, data);
export const noAnswer = () => new GroupApiError('no answer', 0, null, null);

export function pinAt(version: number, overrides: Partial<GroupPin> = {}): GroupPin {
    return {
        firstEd25519PublicKey: 'first-ed',
        firstMlDsaPublicKeyDigest: 'first-mldsa',
        checkedAt: '2026-10-01T10:00:00.000Z',
        keyVersion: 1,
        groupKeyDigest: 'key-1',
        rosterVersion: version,
        rosterDigest: `roster-${version}`,
        areas: {},
        ...overrides,
    };
}

function rotationOf(workspaceId: string) {
    return {
        workspaceId,
        fromVersion: 1,
        toVersion: 2,
        targetEpoch: 9,
        root: {
            id: `root-${workspaceId}`,
            changeSeq: 1,
            parentKeyEpoch: 2,
            keyEnvelope: 'old-root',
            rotated: null,
        },
        previousRootKeyEnvelope: 'previous',
        selfGrant: {
            version: 1 as const,
            workspaceId,
            keyVersion: 1,
            workspaceKeyVersion: 2,
            wrappingSalt: 's',
            wrappingNonce: 'n',
            encryptedKey: 'k',
        },
        documents: [],
    };
}

export function rosterBody(tag = 'r'): RosterCallBody {
    return {
        expectedRevision: 4,
        roster: {
            statement: `statement-${tag}`,
            signature: { ed25519: 'ed', mlDsa: 'ml' },
            signerSignature: 'signer',
        },
        grants: [
            {
                workspaceId: AREA,
                workspaceKeyVersion: 2,
                granteeUserId: USER,
                granteeKeyVersion: 1,
                rosterVersion: 5,
                rosterDigest: 'roster-5',
                envelope: 'grant',
            },
        ],
        rotations: [rotationOf(AREA), rotationOf(AREA_2)],
    };
}

type Call = { operation: string; input: unknown };

export function harness(
    options: {
        store?: GroupStore;
        settings?: { doc: GroupSettings; version: number };
        rotations?: boolean;
        head?: number;
    } = {},
) {
    const store = options.store ?? createMemoryGroupStore();
    const server = {
        head: options.head ?? 5,
        script: [] as Answer[],
        sent: [] as { route: string; body: string }[],
        grants: [] as { workspaceId: string; grants: unknown[] }[],
        lockHeldAtSend: [] as boolean[],
        storedAtSend: [] as number[],
        holds: [] as string[],
    };
    const worker: (Call & { output?: unknown })[] = [];
    const failNext = new Map<string, Error>();
    const settingsDoc = options.settings ?? { doc: { version: 2, contacts: {} }, version: 1 };
    const settingsLog = {
        reads: 0,
        writes: [] as GroupSettings[],
        failWrite: null as Error | null,
    };
    const held = new Set<string>();
    const sleeps: number[] = [];
    const rotationLog = {
        finished: [] as unknown[],
        read: [] as { workspaceId: string; kinds: string[] }[][],
        returned: [] as unknown[],
    };

    const head = (): ChainHead => ({
        version: server.head,
        digest: `roster-${server.head}`,
        revision: server.head,
        groupKeyVersion: 1,
        replayed: false,
    });

    async function roster(route: string, call: unknown): Promise<ChainHead> {
        server.sent.push({ route, body: JSON.stringify(call) });
        server.lockHeldAtSend.push(held.has(GROUP));
        server.storedAtSend.push((await store.outbox(USER, GROUP)).length);
        const next = server.script.shift();
        if (next instanceof GroupApiError) throw next;
        server.head++;
        return next ?? head();
    }

    const api = {
        createGroup: async (body: unknown) => {
            await roster('create', body);
            return { group: {} };
        },
        postRoster: (_groupId: string, call: unknown) => roster('rosters', call),
        admit: (_groupId: string, _userId: string, call: unknown) => roster('admit', call),
        patchMember: (_groupId: string, _userId: string, call: unknown) => roster('member', call),
        removeMember: (_groupId: string, _userId: string, call: unknown) => roster('remove', call),
        // A removal's hold, placed again before its rotations are read again.
        hold: async (_groupId: string, userId: string) => {
            server.holds.push(userId);
            return { heldUntil: '2026-10-17T12:15:00.000Z' };
        },
        createArea: (_groupId: string, call: unknown) => roster('areas', call),
        rotateArea: (_groupId: string, _workspaceId: string, call: unknown) =>
            roster('rotation', call),
        deleteArea: (_groupId: string, _workspaceId: string, call: unknown) =>
            roster('delete', call),
        rosters: async () => ({
            rosters: [],
            successions: [],
            firstKeys: { ed25519PublicKey: 'first-ed', mlDsaPublicKey: 'first-ml' },
            signerKeys: {},
            head: head(),
            next: null,
        }),
        identities: async () => ({
            identities: [USER, 'b0b0b0b0-0000-4000-8000-000000000003'].map((userId) => ({
                userId,
                identity: {
                    keyVersion: 1,
                    encryptionPublicKey: 'x',
                    signingPublicKey: 'e',
                    mlDsaPublicKey: `ml-${userId}`,
                    kemPublicKey: `kem-${userId}`,
                    keysSignature: 'ks',
                },
                links: [],
            })),
            next: null,
        }),
        spaces: async () => ({ spaces: [] }),
        group: async () => ({ head: head() }),
        keySeal: async () => ({
            groupKeyVersion: 1,
            holderKeyVersion: 1,
            sealerUserId: USER,
            rosterVersion: 1,
            rosterDigest: 'roster-1',
            envelope: 'seal',
        }),
        postGrants: async (_groupId: string, workspaceId: string, grants: unknown[]) => {
            server.grants.push({ workspaceId, grants });
            return { stored: grants.length };
        },
        putSelfGrant: async () => ({ ok: true }),
        listGroups: async () => ({ groups: [] }),
    } as unknown as GroupsApi;

    const results: { [K in GroupOperation]?: (input: CryptoRequests[K]) => unknown } = {
        groupStoreSeal: (input) => ({ envelope: `sealed:${JSON.stringify(input.value)}` }),
        groupStoreOpen: (input) => ({ value: JSON.parse(input.envelope.slice('sealed:'.length)) }),
        groupDrop: () => ({ dropped: true }),
        groupForget: () => ({ forgotten: true, guard: null }),
        groupOpenSeal: () => ({ groupKeyVersion: 1 }),
        groupAccept: () => ({
            status: 'accepted',
            view: { rosterVersion: server.head, areas: { [AREA]: 1 } },
            record: `record-${server.head}`,
            pin: pinAt(server.head),
            dropped: [],
        }),
        groupGrants: (input) => ({
            grants: input.missing.map((at) => ({
                workspaceId: at.workspaceId,
                granteeUserId: at.userId,
                envelope: `grant-to-${at.kemPublicKey}`,
            })),
        }),
        groupRestage: (input) => ({
            outboxId: 'restaged',
            stagedEnvelope: input.stagedEnvelope,
            replaced: [],
            body: {
                ...input.body,
                rotations: input.body.rotations?.map((rotation) => ({
                    ...rotation,
                    targetEpoch: rotation.targetEpoch + 1,
                    documents: (
                        input.rebuild?.rotations.find(
                            (at) => at.workspaceId === rotation.workspaceId,
                        )?.documents ?? rotation.documents
                    ).map((document) => ({ ...document, version: document.version })),
                })),
            },
        }),
        groupStage: async (input) => ({
            outboxId: 'staged-admit',
            body: { ...rosterBody('admit'), expectedRevision: input.expectedRevision },
            stagedEnvelope: 'staged-secrets',
            joinCode: { rosterVersion: server.head + 1, code: Array(12).fill('word') },
            needsCheck: [],
            replaced: [],
            // As the worker does: an admission over the contact pin in the settings it opened, kept
            // by the key commitment of that pin.
            admits:
                input.op.kind === 'admit'
                    ? {
                          userId: input.op.userId,
                          keys: (await keyCommitment(
                              (settingsDoc.doc.contacts as Record<string, PinKeys>)[
                                  input.op.userId
                              ]!,
                          ))!,
                      }
                    : null,
            previousRosterDigest: 'head',
            rosterDigest: 'staged',
        }),
        groupCreate: () => ({
            outboxId: 'create-1',
            groupId: GROUP,
            body: { id: GROUP, name: 'Lindqvist family' },
            stagedEnvelope: 'creator-seed',
        }),
    };

    const rpc = (async (operation: GroupOperation, input: never) => {
        worker.push({ operation, input });
        const failure = failNext.get(operation);
        if (failure) {
            failNext.delete(operation);
            throw failure;
        }
        const result = results[operation];
        if (!result) throw new Error(`unexpected worker call ${operation}`);
        const output = await (result as (input: never) => unknown)(input);
        worker.at(-1)!.output = output;
        return output;
    }) as GroupContext['rpc'];

    const settings: SettingsAccess = {
        read: async () => {
            settingsLog.reads++;
            return { settings: structuredClone(settingsDoc.doc), version: settingsDoc.version };
        },
        write: async (version, doc) => {
            if (settingsLog.failWrite) {
                const error = settingsLog.failWrite;
                settingsLog.failWrite = null;
                throw error;
            }
            if (version !== settingsDoc.version) return false;
            settingsDoc.doc = structuredClone(doc);
            settingsDoc.version++;
            settingsLog.writes.push(structuredClone(doc));
            return true;
        },
    };

    const rotations: RotationSource = {
        read: async (_groupId, areas) => {
            rotationLog.read.push(areas);
            const returned = areas.map((area) => ({
                workspaceId: area.workspaceId,
                targetEpoch: 10,
                root: {} as never,
                documents: area.kinds.map((kind) => ({
                    kind,
                    version: 3,
                    envelope: `doc-${kind}`,
                })),
            }));
            rotationLog.returned.push(returned);
            return returned;
        },
        writers: async () => [],
        finish: async (_groupId, rotation) => {
            rotationLog.finished.push(rotation);
        },
    };

    const mirrorsDeleted: string[][] = [];
    const guard = createMemoryFamilyGuard();
    const ctx: GroupContext = {
        userId: USER,
        api,
        rpc,
        store,
        settings,
        guard: familyGuardOf(() => guard, USER),
        lock: async (groupId, work) => {
            if (held.has(groupId)) throw new Error('The write lock was taken twice.');
            held.add(groupId);
            try {
                return await work();
            } finally {
                held.delete(groupId);
            }
        },
        sleep: async (ms) => void sleeps.push(ms),
        now: () => new Date('2026-10-16T12:00:00.000Z'),
        identities: async () => ({ identity: {} as never, history: [] }),
        deleteMirrors: async (ids) => void mirrorsDeleted.push([...ids]),
        rotations: options.rotations === false ? null : rotations,
    };

    const calls = (operation: string) =>
        worker.filter((call) => call.operation === operation).map((call) => call.input);
    /* What the worker answered each call of `operation`. */
    const outputs = (operation: string) =>
        worker.filter((call) => call.operation === operation).map((call) => call.output);

    return {
        ctx,
        store,
        server,
        worker,
        calls,
        outputs,
        failNext,
        settings: settingsDoc,
        settingsLog,
        sleeps,
        rotationLog,
        mirrorsDeleted,
        results,
        guard,
    };
}

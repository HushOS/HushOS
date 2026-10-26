import { describe, expect, test } from 'vitest';
import type { ContactPin, SettingsEnvelope, SettingsKeyEnvelope } from './contacts';
import { createDeviceKey, rememberAccountKey } from './device';
import { fingerprint, hexBytes, keyDigest } from './fingerprint';
import type { GroupChainCache, JoinMark } from './group-trust';
import {
    groupKeyPair,
    newGroupSeed,
    parseRoster,
    rosterDigest,
    signGroup,
    type GroupRole,
} from './groups';
import {
    createIdentity,
    publicIdentity,
    verifySuccessionConsent,
    type IdentityEnvelope,
    type SuccessionLink,
} from './identity';
import { CONTENT_SUITE, openNodeKey, wrapNodeKey, wrapPreviousRootKey } from './drive';
import { decode, encode } from './keys';
import type { GroupPin } from './pins';
import { FAMILY_SHARING, KEY_CHANGE_PENDING, NOT_CARRIED, SHARED_IN_FAMILY } from './protocol';
import { createCryptoSession, type CryptoRequests, type CryptoResults } from './session';
import { openAreaSelfGrant } from './workspace';
import { createAreaLedger } from './area-ledger';
import { chains, PERSONAL } from './area-ledger-testkit';
import {
    AREA,
    AREA_SEED,
    areaKeyAt,
    GROUP,
    OTHER_GROUP,
    pattern,
    rootKeyAt,
} from './group-testkit';
import {
    createGroupSession,
    openDeviceRecord,
    sealDeviceRecord,
    type AreaRotationInput,
    type GroupHost,
    type GroupMessage,
    type GroupResults,
    type GroupWriter,
    type RosterCallBody,
    type ServedChain,
    type SignedStatementWire,
} from './session-groups';
import {
    digest,
    metadataRekeyedStatement,
    metadataResealedStatement,
    metadataStatement,
    verifyStatement,
} from './signatures';

/*
 * The crypto worker's group plumbing (milestone 1c, plan section 1.2), driven
 * through real sessions the way the app drives them: each account has its own
 * root and identity, and a tiny in-test server keeps exactly what the roster
 * routes would store (the signed rosters and successions) and serves it back.
 * Nothing here hands a chain object across the session boundary: every input
 * is plain data, as postMessage would carry it.
 */

const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001';
const BOB = 'b2b2b2b2-0000-4000-8000-000000000002';
const CAROL = 'c3c3c3c3-0000-4000-8000-000000000003';
const CHILD = 'c4c4c4c4-0000-4000-8000-000000000004';
const LATER = 'c5c5c5c5-0000-4000-8000-000000000005';
const GRAND = 'c6c6c6c6-0000-4000-8000-000000000006';
const PLANTED = 'cdcdcdcd-0000-4000-8000-00000000000d';
const OTHER_WS = 'd6d6d6d6-0000-4000-8000-000000000006';
const CHECKED = '2026-10-16T00:00:00.000Z';
// The worker's answer to a write under keys the device no longer has as current (session.ts).
const KEYS_CHANGED = 'This folder’s keys changed. Reload to continue.';
const folder = (name: string) => ({ name, mime: null, size: null, modified: null });

type Call = <K extends keyof CryptoRequests>(
    operation: K,
    input: CryptoRequests[K],
) => Promise<CryptoResults[K]>;

async function deviceOf(userId: string, root: Uint8Array<ArrayBuffer>) {
    const deviceKey = await createDeviceKey();
    const bundle = await rememberAccountKey(root, deviceKey, {
        userId,
        keyVersion: 1,
        credentialVersion: 1,
        deviceKeyId: crypto.randomUUID(),
    });
    const session = createCryptoSession();
    let id = 0;
    const call: Call = (operation, input) =>
        session.handle({ id: ++id, operation, input } as Parameters<
            typeof session.handle
        >[0]) as Promise<never>;
    const restore = () => call('restore', { deviceKey, bundle });
    await restore();
    return { session, call, restore };
}

/* The account's settings as the server keeps them: the group pins its devices saved live here. */
type AccountSettings = {
    key: SettingsKeyEnvelope | null;
    version: number;
    envelope: SettingsEnvelope | null;
    groups: Record<string, GroupPin>;
    /* The people whose words this account checked: the worker admits only over these pins. */
    contacts?: Record<string, ContactPin>;
};
type Device = {
    userId: string;
    call: Call;
    session: ReturnType<typeof createCryptoSession>;
    restore: () => Promise<unknown>;
    settings: AccountSettings;
};
/* Fetches the account's settings into the device's worker, as every sync does first. */
async function loadSettings(device: Device) {
    const { userId, settings } = device;
    await device.call('settingsKeyOpen', { userId, settingsKey: settings.key! });
    await device.call('settingsOpen', { userId, envelope: settings.envelope! });
}
/* Saves the account's settings, with its group pins, from this device. */
async function saveSettings(device: Device) {
    const { userId, settings } = device;
    const settingsVersion = settings.version + 1;
    const { envelope } = await device.call('settingsSeal', {
        userId,
        settingsVersion,
        settings: {
            version: 2,
            contacts: { ...settings.contacts },
            groups: { ...settings.groups },
        },
    });
    Object.assign(settings, { version: settingsVersion, envelope });
}

/* The account's words check of `people`: their pins saved in its settings, opened again by the worker. */
async function checkWords(
    device: Device,
    ...people: { userId: string; served: Account['served'] }[]
) {
    device.settings.contacts ??= {};
    for (const who of people) device.settings.contacts[who.userId] = await pinOf(who);
    await saveSettings(device);
    await loadSettings(device);
}

/* An account with its own root, identity and settings, unlocked on one device. */
async function account(userId: string) {
    const root = crypto.getRandomValues(new Uint8Array(32));
    const identity = await createIdentity(root, userId);
    const settings: AccountSettings = { key: null, version: 0, envelope: null, groups: {} };
    const device = async (
        open: IdentityEnvelope = identity,
        earlier: IdentityEnvelope[] = [],
    ): Promise<Device> => {
        const unlocked = await deviceOf(userId, root);
        await unlocked.call('identityOpen', { userId, identity: open, history: earlier });
        const opened = { ...unlocked, userId, settings };
        if (settings.key) await loadSettings(opened);
        else {
            settings.key = (await opened.call('settingsKeyCreate', { userId })).settingsKey;
            await saveSettings(opened);
            await loadSettings(opened);
        }
        return opened;
    };
    /*
     * A fresh device that has read only `envelope`, an earlier copy of the settings: within one
     * unlock a document older than one opened is refused, so it must be the first one read.
     */
    const deviceAt = async (envelope: SettingsEnvelope): Promise<Device> => {
        const unlocked = await deviceOf(userId, root);
        await unlocked.call('identityOpen', { userId, identity, history: [] });
        await unlocked.call('settingsKeyOpen', { userId, settingsKey: settings.key! });
        await unlocked.call('settingsOpen', { userId, envelope });
        return { ...unlocked, userId, settings };
    };
    return {
        ...(await device()),
        root,
        identity,
        served: publicIdentity(identity),
        device,
        deviceAt,
    };
}
type Account = Awaited<ReturnType<typeof account>>;

/*
 * A joins record for `mark`, sealed as only the worker writes one after a
 * match: for what acceptance does with a code the served chain may or may not
 * still give (the join flow itself is groupJoinCheck's, tested beside it).
 */
async function joinsRecordFor(
    who: { userId: string; root: Uint8Array<ArrayBuffer> },
    groupId: string,
    mark: JoinMark,
) {
    return sealDeviceRecord(who.root.slice(), who.userId, groupId, 'joins', {
        v: 3,
        groupId,
        joinMark: { rosterVersion: mark.rosterVersion, code: mark.code },
        checkedAt: CHECKED,
    });
}

/* A version 3 pin of `who`, as comparing words with them writes it. */
async function pinOf(who: { userId: string; served: Account['served'] }): Promise<ContactPin> {
    const s = who.served;
    const mlDsaPublicKeyHash = await keyDigest(decode(s.mlDsaPublicKey));
    const kemPublicKeyHash = await keyDigest(decode(s.kemPublicKey));
    return {
        userId: who.userId,
        email: `${who.userId}@example.com`,
        name: 'Someone',
        keyVersion: s.keyVersion,
        pinnedAt: CHECKED,
        encryptionPublicKey: s.encryptionPublicKey,
        signingPublicKey: s.signingPublicKey,
        mlDsaPublicKeyHash,
        kemPublicKeyHash,
        fingerprint: await fingerprint(
            decode(s.encryptionPublicKey, 32),
            decode(s.signingPublicKey, 32),
            hexBytes(mlDsaPublicKeyHash),
            hexBytes(kemPublicKeyHash),
        ),
    };
}
async function writerPinOf(who: { userId: string; served: Account['served'] }) {
    const pin = await pinOf(who);
    return {
        keyVersion: pin.keyVersion!,
        encryptionPublicKey: pin.encryptionPublicKey,
        signingPublicKey: pin.signingPublicKey,
        mlDsaPublicKeyHash: pin.mlDsaPublicKeyHash!,
        trustedVia: null,
    };
}

/* What the roster routes store, served back as route 5 does. */
function serverOf(created: CryptoResults['groupCreate']) {
    const rosters: SignedStatementWire[] = [created.body.roster];
    const successions: SignedStatementWire[] = [];
    const signerKeys: Record<string, string> = {};
    return {
        rosters,
        async signer(...people: { served: { mlDsaPublicKey: string } }[]) {
            for (const who of people)
                signerKeys[await digest(decode(who.served.mlDsaPublicKey))] =
                    who.served.mlDsaPublicKey;
        },
        served(): ServedChain {
            return {
                rosters: [...rosters],
                successions: [...successions],
                firstKeys: created.body.groupKey,
                signerKeys: { ...signerKeys },
            };
        },
        store(body: RosterCallBody) {
            rosters.push(body.roster);
            if (body.succession) successions.push(body.succession);
        },
    };
}
type Marks = { record: string | null };

/*
 * A family as 1c makes one: Alice creates it (the first committed acceptance
 * vouching for the keys her outbox entry made), opens its key and its folder,
 * checks Bob's words and admits him, and Bob joins with the join code.
 */
async function family(bobRoles: GroupRole[] = []) {
    const alice = await account(ALICE);
    const bob = await account(BOB);
    const created = await alice.call('groupCreate', {
        userId: ALICE,
        name: 'Lindqvist',
        identities: { identity: alice.identity, history: [] },
    });
    const { groupId } = created;
    const server = serverOf(created);
    await server.signer(alice);
    const marks: Record<'alice' | 'bob', Marks> = {
        alice: { record: null },
        bob: { record: null },
    };
    /*
     * A sync as the data layer runs it: the settings fetched into the worker, the
     * chain accepted against them and the device record, then the record kept and
     * the pin saved back to the settings.
     */
    const sync = async (
        who: Device,
        mark: Marks,
        extra: Partial<CryptoRequests['groupAccept']> = {},
    ) => {
        await loadSettings(who);
        const result = await who.call('groupAccept', {
            userId: who.userId,
            groupId,
            served: server.served(),
            record: mark.record,
            checkedAt: CHECKED,
            ...extra,
        });
        if (result.status !== 'accepted')
            throw new Error(
                result.status === 'fork' ? `fork at ${result.fork.version}` : result.status,
            );
        if (result.record && result.pin) {
            mark.record = result.record;
            who.settings.groups[groupId] = result.pin;
            await saveSettings(who);
        }
        return result;
    };
    // The staged change is dropped first: only what the server served commits.
    await alice.call('groupDrop', { outboxId: created.outboxId });
    const first = await sync(alice, marks.alice, {
        creating: { stagedEnvelope: created.stagedEnvelope },
    });
    const area = created.body.area;
    const ws = area.workspaceId;
    await alice.call('groupOpenSeal', {
        groupId,
        seal: {
            groupKeyVersion: 1,
            holderKeyVersion: 1,
            sealerUserId: ALICE,
            rosterVersion: 1,
            rosterDigest: first.view.rosterDigest,
            envelope: created.body.keySeal.envelope,
        },
        sealerMlDsaPublicKey: alice.served.mlDsaPublicKey,
    });
    await alice.call('groupOpenArea', {
        groupId,
        workspaceId: ws,
        idSeed: area.idSeed,
        servedVersion: 1,
        grant: null,
        selfGrant: area.selfGrant,
    });
    const rootListing = {
        id: area.root.id,
        parentId: ws,
        parentKeyEpoch: 1,
        keyEpoch: 1,
        keyEnvelope: area.root.keyEnvelope,
        metadataVersion: 1,
        metadataEnvelope: area.root.metadataEnvelope,
    };
    await alice.call('driveOpenNodes', { workspaceId: ws, nodes: [rootListing] });

    await checkWords(alice, bob);
    const admit = await alice.call('groupStage', {
        groupId,
        expectedRevision: 1,
        op: {
            kind: 'admit',
            userId: BOB,
            served: bob.served,
            roles: bobRoles,
        },
        kems: { [BOB]: bob.served.kemPublicKey },
    });
    if (admit.outboxId === null) throw new Error('nothing staged');
    await alice.call('groupDrop', { outboxId: admit.outboxId });
    server.store(admit.body);
    await sync(alice, marks.alice);
    await sync(bob, marks.bob, {
        joining: { joinsRecord: await joinsRecordFor(bob, groupId, admit.joinCode!) },
    });
    const bobGrant = admit.body.grants!.find((grant) => grant.granteeUserId === BOB)!;
    const bobOpened = await bob.call('groupOpenArea', {
        groupId,
        workspaceId: ws,
        idSeed: area.idSeed,
        servedVersion: 1,
        grant: { ...bobGrant, granterUserId: ALICE },
        granterMlDsaPublicKey: alice.served.mlDsaPublicKey,
        selfGrant: null,
    });
    /* The area root as the rotation work serves it, before any rotation. */
    const rootInput = (
        over: Partial<AreaRotationInput['root']> = {},
    ): AreaRotationInput['root'] => ({
        id: area.root.id,
        kind: 'folder',
        parentId: ws,
        parentKeyEpoch: 2,
        keyEpoch: 1,
        wrappedParentKeyEpoch: 1,
        keyEnvelope: area.root.keyEnvelope,
        metadataVersion: 1,
        metadataEnvelope: area.root.metadataEnvelope,
        metadataSigner: ALICE,
        metadataSignature: area.root.metadataSignature,
        versions: [],
        shares: [],
        links: [],
        changeSeq: 1,
        ...over,
    });
    return {
        alice,
        bob,
        created,
        groupId,
        server,
        marks,
        sync,
        ws,
        area,
        rootListing,
        admit,
        bobOpened,
        rootInput,
    };
}
type Family = Awaited<ReturnType<typeof family>>;

/*
 * Family's key rotated on route 24 at target epoch 5, after Alice made a
 * folder under the root (which the Drive walk has not reached) and sealed a
 * document under area key 1. Both have re-synced to the rotated roster.
 */
async function rotated(f: Family) {
    const { alice, bob, groupId, ws, area, server, marks, sync } = f;
    const child = await alice.call('driveCreateNodes', {
        workspaceId: ws,
        nodes: [
            {
                id: CHILD,
                kind: 'folder',
                parentId: area.root.id,
                parentKeyEpoch: 1,
                keyEpoch: 1,
                metadata: folder('Inside'),
            },
        ],
    });
    // And one under it: the walk reaches it only after the child.
    const grand = await alice.call('driveCreateNodes', newFolder(ws, CHILD, 1, GRAND));
    const document = await alice.call('driveSealDocument', {
        workspaceId: ws,
        kind: 'tags',
        version: 1,
        document: { tags: ['beach'] },
    });
    const staged = await alice.call('groupStage', {
        groupId,
        expectedRevision: 2,
        op: {
            kind: 'rotate',
            rotation: {
                workspaceId: ws,
                targetEpoch: 5,
                root: f.rootInput(),
                documents: [{ kind: 'tags', version: 1, envelope: document.envelope }],
            },
        },
        kems: { [BOB]: bob.served.kemPublicKey },
        writers: [],
    });
    if (staged.outboxId === null) throw new Error('nothing staged');
    await alice.call('groupDrop', { outboxId: staged.outboxId });
    server.store(staged.body);
    await sync(alice, marks.alice);
    await sync(bob, marks.bob);
    const rotation = staged.body.rotation!;
    const grantTo = (userId: string) => {
        const grant = staged.body.grants!.find((at) => at.granteeUserId === userId)!;
        return { ...grant, granterUserId: ALICE };
    };
    /* The rotated root as route 25 serves it: its new key, and its old one under the new area key. */
    const rotatedRoot = (withPrevious = true) => ({
        id: area.root.id,
        parentId: ws,
        parentKeyEpoch: 2,
        keyEpoch: 5,
        keyEnvelope: rotation.root.keyEnvelope,
        metadataVersion: 1,
        metadataEnvelope: rotation.root.rotated!.metadataEnvelope,
        ...(withPrevious
            ? {
                  prevKeyEnvelope: rotation.previousRootKeyEnvelope,
                  prevKeyEpoch: 1,
                  prevParentKeyEpoch: 2,
              }
            : {}),
    });
    const childListing = {
        id: CHILD,
        parentId: area.root.id,
        parentKeyEpoch: 1,
        keyEpoch: 1,
        keyEnvelope: child.nodes[0]!.keyEnvelope,
        metadataVersion: 1,
        metadataEnvelope: child.nodes[0]!.metadataEnvelope,
    };
    /* The grandchild as the walk is handed it: still under the child's key 1. */
    const grandInput = {
        id: GRAND,
        kind: 'folder' as const,
        parentId: CHILD,
        parentKeyEpoch: 1,
        keyEpoch: 9,
        wrappedParentKeyEpoch: 1,
        keyEnvelope: grand.nodes[0]!.keyEnvelope,
        metadataVersion: 1,
        metadataEnvelope: grand.nodes[0]!.metadataEnvelope,
        metadataSigner: ALICE,
        metadataSignature: grand.nodes[0]!.metadataSignature,
        versions: [],
        shares: [],
        links: [],
    };
    return { child, document, staged, rotation, grantTo, rotatedRoot, childListing, grandInput };
}

/* A folder made under `parentId` at `parentKeyEpoch`: the write every F9 check guards. */
function newFolder(workspaceId: string, parentId: string, parentKeyEpoch: number, id = LATER) {
    return {
        workspaceId,
        nodes: [
            {
                id,
                kind: 'folder' as const,
                parentId,
                parentKeyEpoch,
                keyEpoch: 9,
                metadata: folder('New'),
            },
        ],
    };
}
/* A device that never opened its settings: the worker has no settings marks to take. */
async function bareDevice(who: Account) {
    const unlocked = await deviceOf(who.userId, who.root);
    await unlocked.call('identityOpen', { userId: who.userId, identity: who.identity });
    return { ...unlocked, userId: who.userId, settings: who.settings };
}

describe('creating, accepting and opening a family', () => {
    test('a created family is accepted from what the server stored, and both members open its folder', async () => {
        const f = await family();
        const { alice, bob, ws, area, rootListing, groupId } = f;
        const view = (await f.sync(alice, f.marks.alice)).view;
        expect(view.members.map((m) => [m.userId, m.status, m.roles])).toEqual([
            [ALICE, 'active', ['billing', 'members']],
            [BOB, 'active', []],
        ]);
        expect(view.areas).toEqual({ [ws]: 1 });
        expect(alice.settings.groups[groupId]).toMatchObject({ rosterVersion: 2 });
        // Bob has the key and has not opened the root yet: he reads, and writes once a listing opens it.
        expect(f.bobOpened).toMatchObject({ version: 1, writable: false, reason: 'root-unknown' });
        // Bob's area grant came from Alice, so he writes his own self-grant from it.
        expect(f.bobOpened.selfGrantToStore).toMatchObject({
            workspaceId: ws,
            workspaceKeyVersion: 1,
        });
        const made = await alice.call('driveCreateNodes', {
            workspaceId: ws,
            nodes: [
                {
                    id: CHILD,
                    kind: 'folder',
                    parentId: area.root.id,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: folder('Photos'),
                },
            ],
        });
        const opened = await bob.call('driveOpenNodes', {
            workspaceId: ws,
            nodes: [
                rootListing,
                {
                    id: CHILD,
                    parentId: area.root.id,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    keyEnvelope: made.nodes[0]!.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: made.nodes[0]!.metadataEnvelope,
                },
            ],
        });
        expect(opened.nodes.map((node) => node.metadata?.name)).toEqual(['Family', 'Photos']);
    });

    test('a refused acceptance holds the family folder back: no cached or listed key opens until the next accepted sync, and a retried attempt holds nothing back', async () => {
        const f = await family();
        const { alice, ws, area, rootListing, groupId, server } = f;
        const versions = () =>
            alice.call('driveOpenVersions', {
                workspaceId: ws,
                nodeId: area.root.id,
                versions: [],
            });
        const listed = async () =>
            (await alice.call('driveOpenNodes', { workspaceId: ws, nodes: [rootListing] }))
                .nodes[0];
        await expect(versions()).resolves.toEqual({ versions: [] });
        expect(await listed()).toMatchObject({ metadata: { name: 'Family' } });
        // Junk where the head roster's group signature goes.
        const junk = () => {
            const served = server.served();
            const last = served.rosters.at(-1)!;
            served.rosters[served.rosters.length - 1] = {
                ...last,
                signature: { ...last.signature, ed25519: encode(new Uint8Array(64)) },
            };
            return served;
        };
        const accept = (retried: boolean) =>
            alice.call('groupAccept', {
                userId: ALICE,
                groupId,
                served: junk(),
                record: f.marks.alice.record,
                checkedAt: CHECKED,
                ...(retried ? { retried } : {}),
            });
        // An attempt the ladder retries: refused, and the family stays committed and readable.
        await expect(accept(true)).rejects.toThrow(/not signed by the group key/);
        await expect(versions()).resolves.toEqual({ versions: [] });
        expect(await listed()).toMatchObject({ metadata: { name: 'Family' } });
        // The last attempt refused: the cached key and the listed one are both held back.
        await expect(accept(false)).rejects.toThrow(/not signed by the group key/);
        await expect(versions()).rejects.toThrow('Open the containing folder first.');
        expect(await listed()).toEqual({
            id: area.root.id,
            error: 'Check the family’s member list first.',
        });
        // The next accepted sync: both read again, with no grant opened again.
        await f.sync(alice, f.marks.alice);
        await expect(versions()).resolves.toEqual({ versions: [] });
        expect(await listed()).toMatchObject({ metadata: { name: 'Family' } });
    });

    test('creation refuses an identity the account has already replaced, or one that is not its own', async () => {
        const alice = await account(ALICE);
        // Another device replaced the identity; this one still has the old one open.
        const next = await alice.call('identitySucceed', {
            userId: ALICE,
            identity: alice.identity,
        });
        await expect(
            alice.call('groupCreate', {
                userId: ALICE,
                name: 'Lindqvist',
                identities: { identity: next.identity, history: [alice.identity] },
            }),
        ).rejects.toThrow(/Your keys changed on another device/);
        const stranger = await createIdentity(crypto.getRandomValues(new Uint8Array(32)), ALICE);
        await expect(
            alice.call('groupCreate', {
                userId: ALICE,
                name: 'Lindqvist',
                identities: { identity: alice.identity, history: [stranger] },
            }),
        ).rejects.toThrow(/could not be opened/);
        await expect(
            alice.call('groupCreate', {
                userId: ALICE,
                name: 'Lindqvist',
                identities: { identity: alice.identity, history: [] },
            }),
        ).resolves.toMatchObject({ body: { kind: 'family', name: 'Lindqvist' } });
    });
});

describe('who may vouch for a family’s first keys', () => {
    test('with any mark, joining vouches for nothing: the marks decide, and the join mark only adds to them', async () => {
        const f = await family();
        const { bob, groupId, server, admit } = f;
        const madeUp = (await groupKeyPair(newGroupSeed())).publicKey;
        const join = async (
            who: Device,
            record: string | null,
            over: { firstKeys?: typeof madeUp; code?: string[] | null } = {},
        ) =>
            who.call('groupAccept', {
                userId: BOB,
                groupId,
                served: {
                    ...server.served(),
                    ...(over.firstKeys ? { firstKeys: over.firstKeys } : {}),
                },
                record,
                checkedAt: CHECKED,
                joining: {
                    // A join without a joins record is refused at run time; the type never allows one.
                    joinsRecord: (over.code === null
                        ? null
                        : await joinsRecordFor(bob, groupId, {
                              rosterVersion: admit.joinCode!.rosterVersion,
                              code: over.code ?? admit.joinCode!.code,
                          })) as string,
                },
            });
        // The record and the pin hold, and the right code with them: accepted.
        await expect(join(bob, f.marks.bob.record)).resolves.toMatchObject({ status: 'accepted' });
        // A code that is not the served roster's, beside the marks: the fork, from the join.
        const wrong = [...admit.joinCode!.code];
        wrong[0] = wrong[0] === 'abandon' ? 'ability' : 'abandon';
        await expect(join(bob, f.marks.bob.record, { code: wrong })).resolves.toMatchObject({
            status: 'fork',
            fork: { of: 'roster', version: 2 },
        });
        // A fresh device with only the settings pin: made-up first keys are refused, never vouched for.
        const fresh = await bob.device();
        await expect(join(fresh, null, { firstKeys: madeUp })).rejects.toThrow(
            /not the group keys this person checked/,
        );
        await expect(join(fresh, null)).resolves.toMatchObject({ status: 'accepted' });
        // Without the pin and the record, a chain this session committed vouches for nothing either.
        delete bob.settings.groups[groupId];
        await saveSettings(fresh);
        await loadSettings(fresh);
        // With no code, joining is refused outright: there is no joining before the code.
        await expect(join(fresh, null, { code: null })).rejects.toThrow(
            /Compare the join code first/,
        );
        // Creation's vouching is refused wherever marks exist.
        await expect(
            f.alice.call('groupAccept', {
                userId: ALICE,
                groupId,
                served: server.served(),
                record: f.marks.alice.record,
                checkedAt: CHECKED,
                creating: { stagedEnvelope: f.created.stagedEnvelope },
            }),
        ).rejects.toThrow(/already checked this family/);
    });

    test('settings that opened never give way to none: a server answering none cannot reopen joining (D7)', async () => {
        const f = await family();
        const { bob, groupId, server } = f;
        const madeUp = (await groupKeyPair(newGroupSeed())).publicKey;
        // A device of Bob's with only the settings pin: it opened settings holding it.
        const fresh = await bob.device();
        // The server then answers "no settings", or a version 1 document (which opens as none).
        await expect(fresh.call('settingsOpen', { userId: BOB, envelope: null })).rejects.toThrow(
            /older settings/,
        );
        await expect(
            fresh.call('settingsOpen', {
                userId: BOB,
                envelope: { ...bob.settings.envelope!, version: 1 },
            }),
        ).rejects.toThrow(/older settings/);
        // The pin is still a mark: no join code is worked out over other first keys.
        await expect(
            fresh.call('groupJoinPreview', {
                userId: BOB,
                groupId,
                served: { ...server.served(), firstKeys: madeUp },
                record: null,
            }),
        ).rejects.toThrow(/not the group keys this person checked/);
    });

    test('with no mark nothing is accepted without the join code, and the preview works out the code from settings it opened only', async () => {
        const f = await family();
        const carol = await account(CAROL);
        const accept = (extra: Partial<CryptoRequests['groupAccept']> = {}) =>
            carol.call('groupAccept', {
                userId: CAROL,
                groupId: f.groupId,
                served: f.server.served(),
                record: null,
                checkedAt: CHECKED,
                ...extra,
            });
        await expect(accept()).rejects.toThrow(/compare the join code first/);
        await expect(accept({ joining: { joinsRecord: null as never } })).rejects.toThrow(
            /Compare the join code first/,
        );
        const preview = (who: { call: Call }) =>
            who.call('groupJoinPreview', {
                userId: CAROL,
                groupId: f.groupId,
                served: f.server.served(),
                record: null,
            });
        // The worker takes settings marks only from settings it opened itself.
        const bare = await bareDevice(carol);
        await expect(preview(bare)).rejects.toThrow(/Open your settings first/);
        // A new account has no settings stored: reading none is a reading, for that account only.
        await expect(bare.call('settingsOpen', { userId: ALICE, envelope: null })).rejects.toThrow(
            /Unlock your account first/,
        );
        await expect(preview(bare)).rejects.toThrow(/Open your settings first/);
        // A version 1 document is not "no settings": the preview still has no settings to go on.
        await bare.call('settingsOpen', {
            userId: CAROL,
            envelope: { ...carol.settings.envelope!, version: 1 },
        });
        await expect(preview(bare)).rejects.toThrow(/Open your settings first/);
        await bare.call('settingsOpen', { userId: CAROL, envelope: null });
        // Carol is on no member list yet: nothing to compare.
        await expect(preview(bare)).resolves.toEqual({ status: 'not-admitted' });
        await expect(preview(carol)).resolves.toEqual({ status: 'not-admitted' });
    });

    test('committed but not yet pinned: after a reload the outbox entry’s seed vouches for the keys it made, and only those', async () => {
        const alice = await account(ALICE);
        const created = await alice.call('groupCreate', {
            userId: ALICE,
            name: 'Lindqvist',
            identities: { identity: alice.identity, history: [] },
        });
        const other = await alice.call('groupCreate', {
            userId: ALICE,
            name: 'Other',
            identities: { identity: alice.identity, history: [] },
        });
        const server = serverOf(created);
        await server.signer(alice);
        const accept = (who: Device, extra: Partial<CryptoRequests['groupAccept']>) =>
            who.call('groupAccept', {
                userId: ALICE,
                groupId: created.groupId,
                served: server.served(),
                record: null,
                checkedAt: CHECKED,
                ...extra,
            });
        // On the creating device, acceptance takes the served roster and lets the staged one go,
        // named in `dropped` (the data layer keeps the creator's own outbox entry regardless).
        await expect(
            accept(alice, { creating: { stagedEnvelope: created.stagedEnvelope } }),
        ).resolves.toMatchObject({ status: 'accepted', dropped: [created.outboxId] });
        // The server stored the call; the device reloaded before writing its record and pin.
        const reloaded = await alice.device();
        await expect(accept(reloaded, {})).rejects.toThrow(/compare the join code first/);
        await expect(
            accept(reloaded, { creating: { stagedEnvelope: other.stagedEnvelope } }),
        ).rejects.toThrow(/could not be opened/);
        const madeUp = await groupKeyPair(newGroupSeed());
        await expect(
            accept(reloaded, {
                creating: { stagedEnvelope: created.stagedEnvelope },
                served: { ...server.served(), firstKeys: madeUp.publicKey },
            }),
        ).rejects.toThrow(/not the family keys this device made/);
        const result = await accept(reloaded, {
            creating: { stagedEnvelope: created.stagedEnvelope },
        });
        if (result.status !== 'accepted') throw new Error('fork');
        expect(result.pin).toMatchObject({ rosterVersion: 1 });
        // From here the record is the mark: the next sync needs no vouching.
        await expect(accept(reloaded, { record: result.record })).resolves.toMatchObject({
            status: 'accepted',
        });
    });
});

describe('the join code a newcomer compares (groupJoinPreview)', () => {
    /* Alice signs Carol's admission on top of the committed chain (version 2, Bob a member). */
    async function admitCarol(f: Family, carol: Account, roles: GroupRole[] = []) {
        await checkWords(f.alice, carol);
        const staged = await f.alice.call('groupStage', {
            groupId: f.groupId,
            expectedRevision: 2,
            op: {
                kind: 'admit',
                userId: CAROL,
                served: carol.served,
                roles,
            },
            kems: { [BOB]: f.bob.served.kemPublicKey, [CAROL]: carol.served.kemPublicKey },
        });
        if (staged.outboxId === null) throw new Error('nothing staged');
        await f.alice.call('groupDrop', { outboxId: staged.outboxId });
        return staged;
    }
    const previewOf = (
        f: Family,
        who: { call: Call },
        userId: string,
        record: string | null = null,
    ) =>
        who.call('groupJoinPreview', {
            userId,
            groupId: f.groupId,
            served: f.server.served(),
            record,
        });

    test('it is the code of the roster that let the newcomer in, as the admin’s screen shows it, and nothing is kept', async () => {
        const f = await family();
        const { alice, groupId, server, marks } = f;
        const carol = await account(CAROL);
        await expect(previewOf(f, carol, CAROL)).resolves.toEqual({ status: 'not-admitted' });
        const admitted = await admitCarol(f, carol);
        server.store(admitted.body);
        await f.sync(alice, marks.alice);
        // The head moves on after the admission: the code is still the admitting roster's.
        const later = await alice.call('groupStage', {
            groupId,
            expectedRevision: 3,
            op: { kind: 'area', name: 'Photos' },
            kems: { [BOB]: f.bob.served.kemPublicKey, [CAROL]: carol.served.kemPublicKey },
        });
        if (later.outboxId === null) throw new Error('nothing staged');
        await alice.call('groupDrop', { outboxId: later.outboxId });
        server.store(later.body);
        await f.sync(alice, marks.alice);
        const shown = await previewOf(f, carol, CAROL);
        expect(shown).toMatchObject({
            status: 'code',
            rosterVersion: 3,
            code: admitted.joinCode!.code,
        });
        // Alice's screen works out the same code from her committed chain, compared with the
        // contact pin of Carol in the settings her worker opened: none, Carol's, or Bob's keys.
        const joinCode = () =>
            alice.call('groupJoinCode', { groupId, userId: CAROL, rosters: server.rosters });
        delete alice.settings.contacts![CAROL];
        await saveSettings(alice);
        await loadSettings(alice);
        await expect(joinCode()).resolves.toEqual({
            rosterVersion: 3,
            code: admitted.joinCode!.code,
            pinMatches: null,
        });
        await checkWords(alice, carol);
        await expect(joinCode()).resolves.toMatchObject({ pinMatches: true });
        alice.settings.contacts![CAROL] = { ...(await pinOf(f.bob)), userId: CAROL };
        await saveSettings(alice);
        await loadSettings(alice);
        await expect(joinCode()).resolves.toMatchObject({ pinMatches: false });
        // Nothing was committed or marked on Carol's side: no chain and no fork to forget, and
        // nothing opens, trusts or shows a code through what the preview verified.
        await expect(carol.call('groupForget', { groupId })).resolves.toEqual({ forgotten: false });
        await expect(
            carol.call('groupJoinCode', { groupId, userId: CAROL, rosters: server.rosters }),
        ).rejects.toThrow(/Check the family’s member list first/);
        await expect(
            carol.call('groupOpenArea', {
                groupId,
                workspaceId: f.ws,
                idSeed: f.area.idSeed,
                servedVersion: 1,
                grant: null,
                selfGrant: null,
            }),
        ).rejects.toThrow(/Check the family’s member list first/);
        const accept = (extra: Partial<CryptoRequests['groupAccept']> = {}) =>
            carol.call('groupAccept', {
                userId: CAROL,
                groupId,
                served: server.served(),
                record: null,
                checkedAt: CHECKED,
                ...extra,
            });
        await expect(accept()).rejects.toThrow(/compare the join code first/);
        // Carol says the codes match: accepted, with the code as her mark.
        if (shown.status !== 'code') throw new Error(shown.status);
        // A bare code is no join: only the record a match sealed is.
        await expect(accept({ joining: { joinMark: shown } as never })).rejects.toThrow(
            /Compare the join code first/,
        );
        const checked = await carol.call('groupJoinCheck', {
            userId: CAROL,
            groupId,
            served: server.served(),
            record: null,
            mark: { rosterVersion: shown.rosterVersion, code: shown.code },
            hidden: shown.hidden,
            session: shown.session,
            typed: shown.hidden.map((at) => shown.code[at]!),
            now: CHECKED,
        });
        if (checked.status !== 'matched') throw new Error(checked.status);
        await expect(
            accept({ joining: { joinsRecord: checked.joinsRecord } }),
        ).resolves.toMatchObject({ status: 'accepted', pin: { rosterVersion: 4 } });
        // Once: the same record joins no second time in this session.
        await expect(accept({ joining: { joinsRecord: checked.joinsRecord } })).rejects.toThrow(
            /already used to join/,
        );
    });

    test('another admission than the one read out gives another code, and the code read out then forks; made-up first keys give none', async () => {
        const f = await family();
        const carol = await account(CAROL);
        const readOut = await admitCarol(f, carol);
        const stored = await admitCarol(f, carol, ['guardian']);
        f.server.store(stored.body);
        const shown = await previewOf(f, carol, CAROL);
        expect(shown).toMatchObject({
            status: 'code',
            rosterVersion: 3,
            code: stored.joinCode!.code,
        });
        expect(stored.joinCode!.code).not.toEqual(readOut.joinCode!.code);
        // Acceptance takes only the code the person confirmed: the admin's, which this history
        // does not pass through.
        await expect(
            carol.call('groupAccept', {
                userId: CAROL,
                groupId: f.groupId,
                served: f.server.served(),
                record: null,
                checkedAt: CHECKED,
                joining: {
                    joinsRecord: await joinsRecordFor(carol, f.groupId, readOut.joinCode!),
                },
            }),
        ).resolves.toMatchObject({ status: 'fork', fork: { of: 'roster', version: 3 } });
        // First keys that sign none of the served member lists: no code at all.
        const other = await account(CAROL);
        const madeUp = (await groupKeyPair(newGroupSeed())).publicKey;
        await expect(
            other.call('groupJoinPreview', {
                userId: CAROL,
                groupId: f.groupId,
                served: { ...f.server.served(), firstKeys: madeUp },
                record: null,
            }),
        ).rejects.toThrow(/not signed by the group key/);
        await expect(other.call('groupForget', { groupId: f.groupId })).resolves.toEqual({
            forgotten: false,
        });
    });

    test('rosters re-signed under made-up first keys give a code that is not Alice’s, and her code then forks', async () => {
        const f = await family();
        const { alice, groupId, server, marks } = f;
        const carol = await account(CAROL);
        const admitted = await admitCarol(f, carol);
        server.store(admitted.body);
        await f.sync(alice, marks.alice);
        const alices = await alice.call('groupJoinCode', {
            groupId,
            userId: CAROL,
            rosters: server.rosters,
        });
        // The server's own version 1 keys, every roster group-signed again under them (the
        // statements name no group key, so they verify).
        const made = await groupKeyPair(newGroupSeed());
        const remade = await Promise.all(
            server.rosters.map(async (roster) => {
                const signature = await signGroup(decode(roster.statement), made);
                return {
                    ...roster,
                    signature: {
                        ed25519: encode(signature.ed25519),
                        mlDsa: encode(signature.mlDsa),
                    },
                };
            }),
        );
        const served = { ...server.served(), firstKeys: made.publicKey, rosters: remade };
        const shown = await carol.call('groupJoinPreview', {
            userId: CAROL,
            groupId,
            served,
            record: null,
        });
        expect(shown).toMatchObject({ status: 'code', rosterVersion: 3 });
        if (shown.status !== 'code') throw new Error(shown.status);
        expect(shown.code).not.toEqual(alices.code);
        expect(alices).toMatchObject({ rosterVersion: 3, code: admitted.joinCode!.code });
        // Carol's device takes only Alice's code, which this history does not pass through.
        await expect(
            carol.call('groupAccept', {
                userId: CAROL,
                groupId,
                served,
                record: null,
                checkedAt: CHECKED,
                joining: { joinsRecord: await joinsRecordFor(carol, groupId, alices) },
            }),
        ).resolves.toMatchObject({ status: 'fork', fork: { of: 'roster', version: 3 } });
    });

    test('after a key holder’s removal the admission is under key 2, and both screens and acceptance agree on its code', async () => {
        const f = await family(['members']);
        const { alice, groupId, ws, server, marks } = f;
        const removal = await alice.call('groupStage', {
            groupId,
            expectedRevision: 2,
            op: {
                kind: 'remove',
                userId: BOB,
                rotations: [
                    { workspaceId: ws, targetEpoch: 7, root: f.rootInput(), documents: [] },
                ],
            },
            kems: {},
            writers: [],
        });
        if (removal.outboxId === null) throw new Error('nothing staged');
        expect(removal.body.succession).toBeTruthy();
        server.store(removal.body);
        await alice.call('groupDrop', { outboxId: removal.outboxId });
        await f.sync(alice, marks.alice);
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: f.area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: removal.body.rotations![0]!.selfGrant,
        });
        await alice.call('groupOpenSeal', {
            groupId,
            seal: { ...removal.body.seals![0]!, sealerUserId: ALICE },
            sealerMlDsaPublicKey: alice.served.mlDsaPublicKey,
        });
        const carol = await account(CAROL);
        await checkWords(alice, carol);
        const admitted = await alice.call('groupStage', {
            groupId,
            expectedRevision: 3,
            op: {
                kind: 'admit',
                userId: CAROL,
                served: carol.served,
                roles: [],
            },
            kems: { [CAROL]: carol.served.kemPublicKey },
        });
        if (admitted.outboxId === null) throw new Error('nothing staged');
        await alice.call('groupDrop', { outboxId: admitted.outboxId });
        server.store(admitted.body);
        await expect(f.sync(alice, marks.alice)).resolves.toMatchObject({
            view: { rosterVersion: 4, groupKeyVersion: 2 },
        });
        const shown = await previewOf(f, carol, CAROL);
        expect(shown).toMatchObject({
            status: 'code',
            rosterVersion: 4,
            code: admitted.joinCode!.code,
        });
        await expect(
            alice.call('groupJoinCode', { groupId, userId: CAROL, rosters: server.rosters }),
        ).resolves.toEqual({ rosterVersion: 4, code: admitted.joinCode!.code, pinMatches: true });
        if (shown.status !== 'code') throw new Error(shown.status);
        await expect(
            carol.call('groupAccept', {
                userId: CAROL,
                groupId,
                served: server.served(),
                record: null,
                checkedAt: CHECKED,
                joining: {
                    joinsRecord: await joinsRecordFor(carol, groupId, {
                        rosterVersion: 4,
                        code: shown.code,
                    }),
                },
            }),
        ).resolves.toMatchObject({ status: 'accepted', view: { groupKeyVersion: 2 } });
    });

    test('a rejoin: against the settings pin, the code is the roster that let them in again, and another history is a fork the preview leaves unset', async () => {
        const f = await family();
        const { alice, bob, groupId, ws, server, marks } = f;
        const removal = await alice.call('groupStage', {
            groupId,
            expectedRevision: 2,
            op: {
                kind: 'remove',
                userId: BOB,
                rotations: [
                    { workspaceId: ws, targetEpoch: 7, root: f.rootInput(), documents: [] },
                ],
            },
            kems: {},
            writers: [],
        });
        if (removal.outboxId === null) throw new Error('nothing staged');
        server.store(removal.body);
        await alice.call('groupDrop', { outboxId: removal.outboxId });
        await f.sync(alice, marks.alice);
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: f.area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: removal.body.rotations![0]!.selfGrant,
        });
        const readmit = async (roles: GroupRole[]) => {
            await checkWords(alice, bob);
            const staged = await alice.call('groupStage', {
                groupId,
                expectedRevision: 3,
                op: {
                    kind: 'admit',
                    userId: BOB,
                    served: bob.served,
                    roles,
                },
                kems: { [BOB]: bob.served.kemPublicKey },
            });
            if (staged.outboxId === null) throw new Error('nothing staged');
            await alice.call('groupDrop', { outboxId: staged.outboxId });
            return staged;
        };
        const again = await readmit([]);
        const rival = await readmit(['guardian']);
        server.store(again.body);
        // A device of Bob's with only the settings pin (version 2): the code is version 4's, not 2's.
        const fresh = await bob.device();
        const shown = await previewOf(f, fresh, BOB);
        expect(shown).toMatchObject({
            status: 'code',
            rosterVersion: 4,
            code: again.joinCode!.code,
        });
        await f.sync(
            fresh,
            { record: null },
            { joining: { joinsRecord: await joinsRecordFor(bob, groupId, again.joinCode!) } },
        );
        expect(bob.settings.groups[groupId]).toMatchObject({ rosterVersion: 4 });
        // The server then serves the rival re-admission at version 4: the pin's history forks.
        server.rosters[3] = rival.body.roster;
        const another = await bob.device();
        await expect(previewOf(f, another, BOB)).resolves.toMatchObject({
            status: 'fork',
            fork: { of: 'roster', version: 4 },
        });
        // The preview set no fork: nothing to forget.
        await expect(another.call('groupForget', { groupId })).resolves.toEqual({
            forgotten: false,
        });
    });
});

describe('staged chains', () => {
    test('a staged roster never becomes a mark, and losing a stale race then re-syncing raises no fork', async () => {
        const f = await family();
        const { alice, groupId, server, marks } = f;
        const stage = (name: string) =>
            alice.call('groupStage', {
                groupId,
                expectedRevision: 2,
                op: { kind: 'area', name },
                kems: { [BOB]: f.bob.served.kemPublicKey },
            });
        const loser = await stage('Photos');
        const winner = await stage('Documents');
        if (loser.outboxId === null || winner.outboxId === null) throw new Error('nothing staged');
        // The staged roster is not on the committed chain: served beside it, it is not read.
        await expect(
            alice.call('groupJoinCode', {
                groupId,
                userId: BOB,
                rosters: [...server.served().rosters, loser.body.roster],
            }),
        ).resolves.toEqual({ rosterVersion: 2, code: f.admit.joinCode!.code, pinMatches: true });
        const cacheOf = async (record: string) =>
            (
                (await openDeviceRecord(alice.root, ALICE, groupId, 'chains', record)) as {
                    cache: GroupChainCache;
                }
            ).cache;
        const unchanged = await f.sync(alice, { ...marks.alice });
        expect((await cacheOf(unchanged.record!)).rosterDigests).toHaveLength(2);
        // Another device's call won (here the same worker staged it: it goes once acceptance took it).
        server.store(winner.body);
        const synced = await f.sync(alice, marks.alice);
        expect(synced).toMatchObject({
            status: 'accepted',
            view: { rosterVersion: 3 },
            dropped: [winner.outboxId],
        });
        const winnerDigest = await rosterDigest(decode(winner.body.roster.statement));
        expect((await cacheOf(marks.alice.record!)).rosterDigests.at(-1)).toBe(winnerDigest);
        // The loser was built on a head that is gone: its secrets went with that commit.
        await expect(alice.call('groupDrop', { outboxId: loser.outboxId })).resolves.toEqual({
            dropped: false,
        });
        const next = await alice.call('groupStage', {
            groupId,
            expectedRevision: 3,
            op: { kind: 'roles', userId: BOB, roles: ['billing'] },
            kems: {},
        });
        if (next.outboxId === null) throw new Error('nothing staged');
        expect(parseRoster(decode(next.body.roster.statement)).previousRosterDigest).toBe(
            winnerDigest,
        );
    });

    test('a restage re-derives the staged chain from the same bytes, and only for the roster its secrets were made for', async () => {
        const f = await family();
        const { alice, groupId } = f;
        const rotation = (targetEpoch: number) => ({
            workspaceId: f.ws,
            targetEpoch,
            root: f.rootInput(),
            documents: [],
        });
        const staged = await alice.call('groupStage', {
            groupId,
            expectedRevision: 2,
            op: { kind: 'rotate', rotation: rotation(5) },
            kems: { [BOB]: f.bob.served.kemPublicKey },
            writers: [],
        });
        if (staged.outboxId === null) throw new Error('nothing staged');
        const again = await alice.call('groupRestage', {
            groupId,
            stagedEnvelope: staged.stagedEnvelope,
            body: staged.body,
            rebuild: { rotations: [rotation(6)], writers: [] },
        });
        expect(again.outboxId).toBe(staged.outboxId);
        expect(again.body.roster).toEqual(staged.body.roster);
        expect(again.body.grants).toEqual(staged.body.grants);
        expect(again.body.rotation).toMatchObject({ targetEpoch: 6, toVersion: 2 });
        expect(again.body.rotation!.root.keyEnvelope).not.toBe(
            staged.body.rotation!.root.keyEnvelope,
        );
        // 409 document-stale names a kind this build left out (another member wrote it): the
        // rebuild reads it under the current key and carries it, the roster bytes unchanged.
        const late = await alice.call('driveSealDocument', {
            workspaceId: f.ws,
            kind: 'tags',
            version: 3,
            document: { tags: ['late'] },
        });
        const withLate = await alice.call('groupRestage', {
            groupId,
            stagedEnvelope: staged.stagedEnvelope,
            body: again.body,
            rebuild: {
                rotations: [
                    {
                        ...rotation(6),
                        documents: [{ kind: 'tags', version: 3, envelope: late.envelope }],
                    },
                ],
                writers: [],
            },
        });
        expect(withLate.body.roster).toEqual(staged.body.roster);
        expect(withLate.body.rotation!.documents).toMatchObject([{ kind: 'tags', version: 3 }]);
        // A change with no new keys: only its own roster restages under its outbox id.
        const roles = (role: GroupRole[]) =>
            alice.call('groupStage', {
                groupId,
                expectedRevision: 2,
                op: { kind: 'roles', userId: BOB, roles: role },
                kems: {},
            });
        const mine = await roles(['billing']);
        const theirs = await roles(['guardian']);
        if (mine.outboxId === null || theirs.outboxId === null) throw new Error('nothing staged');
        await expect(
            alice.call('groupRestage', {
                groupId,
                stagedEnvelope: mine.stagedEnvelope,
                body: theirs.body,
            }),
        ).rejects.toThrow(/does not match its member list/);
        await expect(
            alice.call('groupRestage', {
                groupId,
                stagedEnvelope: mine.stagedEnvelope,
                body: mine.body,
            }),
        ).resolves.toMatchObject({ outboxId: mine.outboxId });
    });
});

describe('workspace documents in a rotation', () => {
    test('one that does not open under the folder’s key goes on as an empty document of its kind, and the rotation stages', async () => {
        const f = await family();
        const { alice, bob, groupId, ws, area, server, marks, sync } = f;
        // Bytes a member wrote that are no document under the folder's key.
        const junk = encode(crypto.getRandomValues(new Uint8Array(120)));
        const rotate = (kind: string) =>
            alice.call('groupStage', {
                groupId,
                expectedRevision: 2,
                op: {
                    kind: 'rotate',
                    rotation: {
                        workspaceId: ws,
                        targetEpoch: 5,
                        root: f.rootInput(),
                        documents: [{ kind, version: 4, envelope: junk }],
                    },
                },
                kems: { [BOB]: bob.served.kemPublicKey },
                writers: [],
            });
        // A kind with no empty form this build knows is refused, never invented.
        await expect(rotate('notes')).rejects.toThrow(/could not be opened/);
        // Junk where the tags are: aborting would let one member block every removal.
        const staged = await rotate('tags');
        if (staged.outboxId === null) throw new Error('nothing staged');
        const [carried] = staged.body.rotation!.documents;
        expect(carried).toMatchObject({ kind: 'tags', version: 4 });
        // Reported, so the data layer reads it again once before letting it go, and says so.
        expect(staged.replaced).toEqual([{ workspaceId: ws, kind: 'tags' }]);
        // Once the roster lands, it opens under the new key at its next version, and is empty.
        await alice.call('groupDrop', { outboxId: staged.outboxId });
        server.store(staged.body);
        await sync(alice, marks.alice);
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: staged.body.rotation!.selfGrant,
        });
        await expect(
            alice.call('driveOpenDocument', {
                workspaceId: ws,
                kind: 'tags',
                version: 5,
                envelope: carried!.envelope,
            }),
        ).resolves.toEqual({
            document: { version: 2, tags: [], items: {} },
            workspaceKeyVersion: 2,
        });
    });
});

describe('the write version (F9)', () => {
    test('two acceptances sent at once, as a background sync and the foreground send them: the later chain is what the session holds, in either order', async () => {
        const f = await family();
        const { bob, groupId, server } = f;
        const before = { record: f.marks.bob.record, envelope: bob.settings.envelope! };
        const servedBefore = server.served();
        await rotated(f);
        for (const order of ['later first', 'older first'] as const) {
            const device = await bob.deviceAt(before.envelope);
            const accept = (served: ServedChain) =>
                device.call('groupAccept', {
                    userId: BOB,
                    groupId,
                    served,
                    record: before.record,
                    checkedAt: CHECKED,
                });
            // The worker runs its calls one at a time, in the order sent; neither waits for the other.
            const runs =
                order === 'later first'
                    ? [accept(server.served()), accept(servedBefore)]
                    : [accept(servedBefore), accept(server.served())];
            const settled = await Promise.allSettled(runs);
            if (order === 'later first') {
                expect(settled[0]).toMatchObject({ status: 'fulfilled' });
                expect(settled[1]).toMatchObject({
                    status: 'rejected',
                    reason: { message: expect.stringMatching(/already holds a later member list/) },
                });
            } else expect(settled.map((run) => run.status)).toEqual(['fulfilled', 'fulfilled']);
            // Either way the session holds version 3, and the older chain was never committed over it.
            await expect(accept(server.served())).resolves.toMatchObject({
                view: { rosterVersion: 3 },
            });
            await expect(accept(servedBefore)).rejects.toThrow(/already holds a later member list/);
        }
    });

    test('another roster at the version this session committed is the fork, never committed, even with the device record and settings from before both', async () => {
        const f = await family();
        const { alice, bob, groupId, server } = f;
        const carol = await account(CAROL);
        const before = { record: f.marks.bob.record, envelope: bob.settings.envelope! };
        const servedBefore = server.served();
        // Alice signs two rosters at version 3: Carol's admission (never stored), then the rotation.
        await checkWords(alice, carol);
        const rival = await alice.call('groupStage', {
            groupId,
            expectedRevision: 2,
            op: {
                kind: 'admit',
                userId: CAROL,
                served: carol.served,
                roles: [],
            },
            kems: { [BOB]: bob.served.kemPublicKey, [CAROL]: carol.served.kemPublicKey },
        });
        if (rival.outboxId === null) throw new Error('nothing staged');
        await alice.call('groupDrop', { outboxId: rival.outboxId });
        await rotated(f);
        const device = await bob.deviceAt(before.envelope);
        const accept = (served: ServedChain) =>
            device.call('groupAccept', {
                userId: BOB,
                groupId,
                served,
                record: before.record,
                checkedAt: CHECKED,
            });
        await expect(accept(server.served())).resolves.toMatchObject({
            status: 'accepted',
            view: { rosterVersion: 3 },
        });
        // The server shows this session the rival version 3: the person's own mark (the chain this
        // session committed) disagrees with what is served, so it is the hard warning.
        const split = { ...servedBefore, rosters: [...servedBefore.rosters, rival.body.roster] };
        await expect(accept(split)).resolves.toMatchObject({
            status: 'fork',
            fork: { of: 'roster', version: 3 },
        });
    });

    test('an acceptance that lost a race with a later one is refused and keeps nothing: no record, no pin, no older write version', async () => {
        const f = await family();
        const { bob, groupId, server } = f;
        // What a background acceptance started from: the record and settings before the rotation.
        const before = { record: f.marks.bob.record, envelope: bob.settings.envelope! };
        const servedBefore = server.served();
        await rotated(f);
        // A second device of Bob's, opened on those older settings, as both runs began.
        const device = await bob.deviceAt(before.envelope);
        const accept = (served: ServedChain) =>
            device.call('groupAccept', {
                userId: BOB,
                groupId,
                served,
                record: before.record,
                checkedAt: CHECKED,
            });
        // The foreground's run, through the rotation, lands first.
        await expect(accept(server.served())).resolves.toMatchObject({
            status: 'accepted',
            view: { rosterVersion: 3 },
        });
        // The background's, over what the server served before, finishes after: refused, so the
        // data layer writes neither its record nor its pin, and the committed chain stays at 3.
        await expect(accept(servedBefore)).rejects.toThrow(/already holds a later member list/);
        await expect(accept(server.served())).resolves.toMatchObject({
            view: { rosterVersion: 3 },
        });
    });

    test('writes and documents need the area’s write version, the top level takes no node, and older documents are refused', async () => {
        const f = await family();
        const r = await rotated(f);
        const { alice, groupId, ws, area } = f;
        // The chain lists key 2 now, and this device holds only key 1 and has listed the root
        // only under it: nothing is written, and the write waits for the listing (a sync between
        // its acceptance and its root listing), as an upload waits out a key change.
        await expect(
            alice.call('driveCreateNodes', newFolder(ws, area.root.id, 1)),
        ).rejects.toThrow(KEY_CHANGE_PENDING);
        await expect(
            alice.call('driveSealDocument', {
                workspaceId: ws,
                kind: 'tags',
                version: 2,
                document: {},
            }),
        ).rejects.toThrow(KEY_CHANGE_PENDING);
        const opened = await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: r.rotation.selfGrant,
        });
        // The root this device listed was under key 1: behind, until the rotated one is listed.
        expect(opened).toMatchObject({ version: 2, writable: false, reason: 'root-behind' });
        await alice.call('driveOpenNodes', { workspaceId: ws, nodes: [r.rotatedRoot()] });
        await expect(
            alice.call('driveCreateNodes', newFolder(ws, area.root.id, 5)),
        ).resolves.toBeTruthy();
        // Nothing in Drive wraps a key directly under the area key: the roster makes the root.
        for (const epoch of [1, 2])
            await expect(alice.call('driveCreateNodes', newFolder(ws, ws, epoch))).rejects.toThrow(
                /top level changes only with the family’s member list/,
            );
        await expect(
            alice.call('driveRewrapNode', {
                workspaceId: ws,
                nodeId: LATER,
                parentId: ws,
                parentKeyEpoch: 2,
                keyEpoch: 9,
            }),
        ).rejects.toThrow(/top level changes only with the family’s member list/);
        // The document travelled with the rotation, sealed for its next version under key 2.
        const [carried] = r.rotation.documents;
        expect(carried).toMatchObject({ kind: 'tags', version: 1 });
        await expect(
            alice.call('driveOpenDocument', {
                workspaceId: ws,
                kind: 'tags',
                version: 2,
                envelope: carried!.envelope,
            }),
        ).resolves.toEqual({ document: { tags: ['beach'] }, workspaceKeyVersion: 2 });
        // One under the replaced key is what a removed member could have written: refused.
        await expect(
            alice.call('driveOpenDocument', {
                workspaceId: ws,
                kind: 'tags',
                version: 1,
                envelope: r.document.envelope,
            }),
        ).rejects.toThrow(/not sealed under the folder’s current key/);
    });

    test('a write landing between a sync’s acceptance and its root listing waits, and only the listing and the walk end the wait', async () => {
        const f = await family();
        // Alice's sync has committed the removal's member list (area key 2) and not yet listed
        // the root under it: the folder she made earlier still shows writable on her page.
        const r = await rotated(f);
        const { alice, groupId, ws, area } = f;
        const intoChild = () => alice.call('driveCreateNodes', newFolder(ws, CHILD, 1));
        await expect(intoChild()).rejects.toThrow(KEY_CHANGE_PENDING);
        await expect(
            alice.call('driveCreateNodes', newFolder(ws, area.root.id, 1)),
        ).rejects.toThrow(KEY_CHANGE_PENDING);
        const open = (servedVersion: number) =>
            alice.call('groupOpenArea', {
                groupId,
                workspaceId: ws,
                idSeed: area.idSeed,
                servedVersion,
                grant: null,
                selfGrant: r.rotation.selfGrant,
            });
        // The sync opens the area at key 2: still waiting for the root.
        await expect(open(2)).resolves.toMatchObject({ writable: false, reason: 'root-behind' });
        await expect(intoChild()).rejects.toThrow(KEY_CHANGE_PENDING);
        // A server behind the member list is no wait: that stops writes until a reload.
        await expect(open(1)).resolves.toMatchObject({ reason: 'server-behind' });
        await expect(intoChild()).rejects.toThrow(KEYS_CHANGED);
        await open(2);
        // The sync lists the rotated root: the area takes writes again under it, and the child
        // the walk has not reached keeps waiting rather than failing.
        await alice.call('driveOpenNodes', { workspaceId: ws, nodes: [r.rotatedRoot()] });
        await expect(
            alice.call('driveCreateNodes', newFolder(ws, area.root.id, 5)),
        ).resolves.toBeTruthy();
        await expect(intoChild()).rejects.toThrow(KEY_CHANGE_PENDING);
    });

    test('a root opened under an older version, or a folder’s previous key, takes no new child', async () => {
        const f = await family();
        const r = await rotated(f);
        const { alice, bob, groupId, ws, area } = f;
        await bob.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: r.grantTo(BOB),
            granterMlDsaPublicKey: alice.served.mlDsaPublicKey,
            selfGrant: null,
        });
        // The server serves the root as it was before the rotation: Bob reads it under key 1...
        const before = await bob.call('driveOpenNodes', {
            workspaceId: ws,
            nodes: [f.rootListing],
        });
        expect(before.nodes[0]!.metadata?.name).toBe('Family');
        // ...and writes nothing under it, at any depth, whatever groupOpenArea was told. The
        // worker cannot tell a withheld root from one not listed yet, so it waits; the sync that
        // listed this root says the folder's keys changed (lib/groups/sync.ts, areaWrite).
        await expect(bob.call('driveCreateNodes', newFolder(ws, area.root.id, 1))).rejects.toThrow(
            KEY_CHANGE_PENDING,
        );
        await expect(
            bob.call('groupOpenArea', {
                groupId,
                workspaceId: ws,
                idSeed: area.idSeed,
                servedVersion: 2,
                grant: r.grantTo(BOB),
                granterMlDsaPublicKey: alice.served.mlDsaPublicKey,
                selfGrant: null,
            }),
        ).resolves.toMatchObject({ writable: false, reason: 'root-behind' });
        // The rotated root lifts it; the child the walk has not reached opens through its
        // previous key, and still nothing new goes under that key.
        const after = await bob.call('driveOpenNodes', {
            workspaceId: ws,
            nodes: [r.rotatedRoot(), r.childListing],
        });
        expect(after.nodes.map((node) => node.metadata?.name)).toEqual(['Family', 'Inside']);
        await expect(bob.call('driveCreateNodes', newFolder(ws, area.root.id, 1))).rejects.toThrow(
            KEYS_CHANGED,
        );
        await expect(
            bob.call('driveCreateNodes', newFolder(ws, area.root.id, 5)),
        ).resolves.toBeTruthy();
    });

    test('option A’s previous-root envelope served as the current root opens nothing and makes nothing writable', async () => {
        const f = await family();
        const r = await rotated(f);
        const fresh = await f.bob.device();
        await f.sync(fresh, f.marks.bob);
        const open = () =>
            fresh.call('groupOpenArea', {
                groupId: f.groupId,
                workspaceId: f.ws,
                idSeed: f.area.idSeed,
                servedVersion: 2,
                grant: r.grantTo(BOB),
                granterMlDsaPublicKey: f.alice.served.mlDsaPublicKey,
                selfGrant: null,
            });
        await open();
        // The server serves the root's old key, which Bob's removed predecessor holds, as current.
        const posing = await fresh.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [
                {
                    ...f.rootListing,
                    parentKeyEpoch: 2,
                    keyEnvelope: r.rotation.previousRootKeyEnvelope,
                },
            ],
        });
        expect(posing.nodes[0]!.error).toMatch(/could not be opened/);
        await expect(
            fresh.call('driveCreateNodes', newFolder(f.ws, f.area.root.id, 1)),
        ).rejects.toThrow(KEYS_CHANGED);
        await expect(open()).resolves.toMatchObject({ writable: false, reason: 'root-unknown' });
        // The genuine rotated root opens, with the old key only as its previous one.
        await fresh.call('driveOpenNodes', { workspaceId: f.ws, nodes: [r.rotatedRoot()] });
        await expect(open()).resolves.toMatchObject({ writable: true, reason: null });
        await expect(
            fresh.call('driveCreateNodes', newFolder(f.ws, f.area.root.id, 1)),
        ).rejects.toThrow(KEYS_CHANGED);
    });

    test('a root key cached under the old area key is opened again when the row names the new one', async () => {
        const f = await family();
        // Bob lists the root before the rotation: its key is cached, opened under key 1.
        await f.bob.call('driveOpenNodes', { workspaceId: f.ws, nodes: [f.rootListing] });
        const r = await rotated(f);
        await f.bob.call('groupOpenArea', {
            groupId: f.groupId,
            workspaceId: f.ws,
            idSeed: f.area.idSeed,
            servedVersion: 2,
            grant: r.grantTo(BOB),
            granterMlDsaPublicKey: f.alice.served.mlDsaPublicKey,
            selfGrant: null,
        });
        // The server keeps the old root and only changes the row's parent epoch to the new version.
        const stale = await f.bob.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [{ ...f.rootListing, parentKeyEpoch: 2 }],
        });
        expect(stale.nodes[0]!.error).toMatch(/could not be opened/);
        // Nothing is written: the root seen is still the one under key 1, so the write waits.
        await expect(
            f.bob.call('driveCreateNodes', newFolder(f.ws, f.area.root.id, 1)),
        ).rejects.toThrow(KEY_CHANGE_PENDING);
        await expect(
            f.bob.call('groupOpenArea', {
                groupId: f.groupId,
                workspaceId: f.ws,
                idSeed: f.area.idSeed,
                servedVersion: 2,
                grant: r.grantTo(BOB),
                granterMlDsaPublicKey: f.alice.served.mlDsaPublicKey,
                selfGrant: null,
            }),
        ).resolves.toMatchObject({ writable: false, reason: 'root-behind' });
    });

    test('a Drive walk never re-keys, re-wraps or caches a family folder’s root', async () => {
        const f = await family();
        const r = await rotated(f);
        const { groupId, ws, area } = f;
        // The removed member's key: the root as it was, its envelope under area key 1.
        const oldRoot = (over: Partial<AreaRotationInput['root']> = {}) => ({
            ...f.rootInput(),
            parentKeyEpoch: 2,
            keyEpoch: 1,
            wrappedParentKeyEpoch: 1,
            ...over,
        });
        const walk = (device: Device, targetEpoch: number) =>
            device.call('driveRotateNodes', {
                workspaceId: ws,
                targetEpoch,
                granterUserId: device.userId,
                signers: {},
                group: { groupId, staged: null, writers: [] },
                nodes: [oldRoot()],
            });
        const openArea = (
            device: Device,
            grant: ReturnType<typeof r.grantTo> | null,
            selfGrant = null as typeof r.rotation.selfGrant | null,
        ) =>
            device.call('groupOpenArea', {
                groupId,
                workspaceId: ws,
                idSeed: area.idSeed,
                servedVersion: 2,
                grant,
                granterMlDsaPublicKey: f.alice.served.mlDsaPublicKey,
                selfGrant,
            });
        // Alice, writable at key 2 with the rotated root cached: a batch at a target at or below
        // the old root's epoch would re-wrap the old key under key 2; a higher one, re-key it.
        await openArea(f.alice, null, r.rotation.selfGrant);
        await f.alice.call('driveOpenNodes', { workspaceId: ws, nodes: [r.rotatedRoot()] });
        for (const target of [1, 8]) {
            const { nodes } = await walk(f.alice, target);
            expect(nodes).toEqual([
                { id: area.root.id, error: expect.stringMatching(/top level changes only/) },
            ]);
        }
        // Whatever a server makes of that, a root row at key 2 counts only if its envelope opens
        // there: the old root's does not, so the root Alice holds stays the rotated one, and the
        // old key (her removed member's) never takes a child.
        const served = await f.alice.call('driveOpenNodes', {
            workspaceId: ws,
            nodes: [{ ...f.rootListing, parentKeyEpoch: 2 }],
        });
        expect(served.nodes[0]!.error).toMatch(/could not be opened/);
        await expect(
            f.alice.call('driveCreateNodes', newFolder(ws, area.root.id, 1)),
        ).rejects.toThrow(KEYS_CHANGED);
        await expect(
            f.alice.call('driveCreateNodes', newFolder(ws, area.root.id, 5)),
        ).resolves.toBeTruthy();
        // The uncached variant: a device that never listed the root caches nothing from a walk.
        const fresh = await f.bob.device();
        await f.sync(fresh, f.marks.bob);
        await openArea(fresh, r.grantTo(BOB));
        // Never writable without a root it opened, it refuses the whole walk before opening anything.
        await expect(walk(fresh, 1)).rejects.toThrow(KEYS_CHANGED);
        await expect(
            fresh.call('driveCreateNodes', newFolder(ws, area.root.id, 1)),
        ).rejects.toThrow(KEYS_CHANGED);
        await expect(openArea(fresh, r.grantTo(BOB))).resolves.toMatchObject({
            writable: false,
            reason: 'root-unknown',
        });
    });

    test('option A: holding only the new area key, the unrotated part opens through the root’s previous envelope', async () => {
        const f = await family();
        const r = await rotated(f);
        const fresh = await f.bob.device();
        await f.sync(fresh, f.marks.bob);
        await fresh.call('groupOpenArea', {
            groupId: f.groupId,
            workspaceId: f.ws,
            idSeed: f.area.idSeed,
            servedVersion: 2,
            grant: r.grantTo(BOB),
            granterMlDsaPublicKey: f.alice.served.mlDsaPublicKey,
            selfGrant: null,
        });
        await expect(
            fresh.call('driveOpenNodes', { workspaceId: f.ws, nodes: [f.rootListing] }),
        ).resolves.toMatchObject({
            nodes: [{ error: expect.stringMatching(/older workspace key/) }],
        });
        const bare = await fresh.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [r.rotatedRoot(false), r.childListing],
        });
        expect(bare.nodes[0]!.metadata?.name).toBe('Family');
        expect(bare.nodes[1]!.error).toMatch(/older folder key/);
        const full = await fresh.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [r.rotatedRoot(), r.childListing],
        });
        expect(full.nodes.map((node) => node.metadata?.name)).toEqual(['Family', 'Inside']);
    });

    test('opening an area: each reason it may not be written, and every write refused while it holds', async () => {
        const f = await family();
        const r = await rotated(f);
        const fresh = await f.alice.device();
        await f.sync(fresh, f.marks.alice);
        const open = (over: Partial<CryptoRequests['groupOpenArea']>) =>
            fresh.call('groupOpenArea', {
                groupId: f.groupId,
                workspaceId: f.ws,
                idSeed: f.area.idSeed,
                servedVersion: 2,
                grant: null,
                selfGrant: null,
                granterMlDsaPublicKey: f.alice.served.mlDsaPublicKey,
                ...over,
            });
        // A self-grant from before the rotation is not the area's key now, whatever the server says.
        await expect(open({ selfGrant: f.area.selfGrant })).rejects.toThrow(/Couldn’t check/);
        await expect(open({ selfGrant: f.area.selfGrant, servedVersion: 1 })).rejects.toThrow(
            /Couldn’t check/,
        );
        const fromGrant = await open({ selfGrant: f.area.selfGrant, grant: r.grantTo(ALICE) });
        // The key is right, and the root not seen yet: nothing is written until a listing opens it.
        expect(fromGrant).toMatchObject({ version: 2, writable: false, reason: 'root-unknown' });
        expect(fromGrant.selfGrantToStore).toMatchObject({ workspaceKeyVersion: 2 });
        await fresh.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [r.rotatedRoot(), r.childListing],
        });
        const write = () => fresh.call('driveCreateNodes', newFolder(f.ws, f.area.root.id, 5));
        // The folder just made under the rotated root: CHILD itself is reached only through the
        // root's previous key, so it takes nothing until the walk re-keys it (design 2.10, F14).
        const rename = (nodeId = LATER) =>
            fresh.call('driveSealMetadata', {
                workspaceId: f.ws,
                nodeId,
                kind: 'folder',
                metadataVersion: 2,
                metadata: folder('Renamed'),
            });
        await expect(write()).resolves.toBeTruthy();
        await expect(rename(CHILD)).rejects.toThrow(KEY_CHANGE_PENDING);
        for (const [over, reason] of [
            [{ servedVersion: 1 }, 'server-behind'],
            // A server ahead of the chain also makes the self-grant suspect: the area grant opens.
            [{ servedVersion: 3, grant: r.grantTo(ALICE) }, 'server-ahead'],
        ] as const) {
            await expect(open({ selfGrant: r.rotation.selfGrant, ...over })).resolves.toMatchObject(
                { version: 2, writable: false, reason },
            );
            // Not only at the root: nothing anywhere in the area.
            await expect(write()).rejects.toThrow(KEYS_CHANGED);
            await expect(rename()).rejects.toThrow(KEYS_CHANGED);
        }
        // With the server back at the chain's version, the root already seen keeps it writable.
        await expect(open({ selfGrant: r.rotation.selfGrant })).resolves.toMatchObject({
            writable: true,
            reason: null,
        });
        await expect(rename()).resolves.toBeTruthy();
        // A member whose newest grant is of key 1 reads, and writes nothing.
        const bob = await f.bob.device();
        await f.sync(bob, f.marks.bob);
        const bobGrant = f.admit.body.grants!.find((grant) => grant.granteeUserId === BOB)!;
        await expect(
            bob.call('groupOpenArea', {
                groupId: f.groupId,
                workspaceId: f.ws,
                idSeed: f.area.idSeed,
                servedVersion: 2,
                grant: { ...bobGrant, granterUserId: ALICE },
                granterMlDsaPublicKey: f.alice.served.mlDsaPublicKey,
                selfGrant: null,
            }),
        ).resolves.toMatchObject({ version: 1, writable: false, reason: 'no-grant-at-latest' });
    });

    test('design 2.10 (F14): a top folder under the right folder key but not the key the roster committed to opens nothing and makes nothing writable', async () => {
        const f = await family();
        // Every roster this worker writes is format 2, and the folder's first key commits to its root.
        const first = parseRoster(decode(f.created.body.roster.statement));
        expect(first.format).toBe(2);
        expect(first.areas![0]!.rootCommitment).toEqual(expect.any(String));
        expect(parseRoster(decode(f.admit.body.roster.statement)).format).toBe(2);
        // A root key wrapped under folder key 1, in the root's own context, by someone holding the
        // folder key (a server keeping an envelope a revoked recipient's root key sits in).
        const areaKey = await openAreaSelfGrant(f.alice.root, ALICE, f.groupId, f.area.selfGrant);
        const posing = encode(
            await wrapNodeKey(crypto.getRandomValues(new Uint8Array(32)), areaKey, {
                workspaceId: f.ws,
                nodeId: f.area.root.id,
                parentId: f.ws,
                parentKeyEpoch: 1,
                keyEpoch: 1,
            }),
        );
        const fresh = await f.alice.device();
        await f.sync(fresh, f.marks.alice);
        const open = () =>
            fresh.call('groupOpenArea', {
                groupId: f.groupId,
                workspaceId: f.ws,
                idSeed: f.area.idSeed,
                servedVersion: 1,
                grant: null,
                selfGrant: f.area.selfGrant,
            });
        await open();
        const listed = await fresh.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [{ ...f.rootListing, keyEnvelope: posing }],
        });
        expect(listed.nodes[0]!.error).toBeTruthy();
        await expect(open()).resolves.toMatchObject({ writable: false, reason: 'root-unknown' });
        await expect(
            fresh.call('driveCreateNodes', newFolder(f.ws, f.area.root.id, 1)),
        ).rejects.toThrow(KEYS_CHANGED);
        // The committed root opens, and then the folder is written.
        await fresh.call('driveOpenNodes', { workspaceId: f.ws, nodes: [f.rootListing] });
        await expect(open()).resolves.toMatchObject({ writable: true, reason: null });
        await expect(
            fresh.call('driveCreateNodes', newFolder(f.ws, f.area.root.id, 1)),
        ).resolves.toBeTruthy();
    });

    test('design 2.10 (F14): a folder reached only through a previous key takes no write until the walk re-keys it', async () => {
        const f = await family();
        const r = await rotated(f);
        const { alice, bob, groupId, ws, area } = f;
        const below = (who: typeof alice, epoch: number, id: string) =>
            who.call('driveCreateNodes', newFolder(ws, CHILD, epoch, id));
        const rename = (who: typeof alice) =>
            who.call('driveSealMetadata', {
                workspaceId: ws,
                nodeId: CHILD,
                kind: 'folder',
                metadataVersion: 2,
                metadata: folder('Renamed'),
            });
        // Bob, with only the new folder key, opens the child through the root's previous key: he
        // reads it, and puts nothing under it (a server saying no walk is running changes nothing).
        await bob.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: r.grantTo(BOB),
            granterMlDsaPublicKey: alice.served.mlDsaPublicKey,
            selfGrant: null,
        });
        const listed = await bob.call('driveOpenNodes', {
            workspaceId: ws,
            nodes: [r.rotatedRoot(), r.childListing],
        });
        expect(listed.nodes.map((node) => node.metadata?.name)).toEqual(['Family', 'Inside']);
        await expect(below(bob, 1, LATER)).rejects.toThrow(KEY_CHANGE_PENDING);
        await expect(rename(bob)).rejects.toThrow(KEY_CHANGE_PENDING);
        // Nor does a walk: told to re-key the grandchild while the child is still at key 1 (a
        // server leaving the child out of the walk), it wraps no fresh key under a key reached
        // through the root's previous one, so nothing new is ever written where a removed member
        // could open it, and nothing is cached as rooted.
        const walkGrand = await bob.call('driveRotateNodes', {
            workspaceId: ws,
            targetEpoch: 10,
            granterUserId: BOB,
            signers: {},
            group: { groupId, staged: null, writers: [] },
            nodes: [r.grandInput],
        });
        expect(walkGrand.nodes[0]).toEqual({ id: GRAND, error: KEY_CHANGE_PENDING });
        await expect(
            bob.call('driveRotateCommit', { workspaceId: ws, nodeIds: [GRAND] }),
        ).resolves.toEqual({ committed: 0 });
        await expect(bob.call('driveCreateNodes', newFolder(ws, GRAND, 10, LATER))).rejects.toThrow(
            'Open the containing folder first.',
        );
        // Alice made the child before the rotation: her cached key is rooted at folder key 1, and
        // takes nothing now either, though it never went near a previous envelope.
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: r.rotation.selfGrant,
        });
        await alice.call('driveOpenNodes', { workspaceId: ws, nodes: [r.rotatedRoot()] });
        await expect(below(alice, 1, LATER)).rejects.toThrow(KEY_CHANGE_PENDING);
        // The walk re-keys the child under the root's new key; then it is written.
        const walked = await alice.call('driveRotateNodes', {
            workspaceId: ws,
            targetEpoch: 5,
            granterUserId: ALICE,
            signers: {},
            group: { groupId, staged: null, writers: [] },
            nodes: [
                {
                    id: CHILD,
                    kind: 'folder',
                    parentId: area.root.id,
                    parentKeyEpoch: 5,
                    keyEpoch: 1,
                    wrappedParentKeyEpoch: 1,
                    keyEnvelope: r.child.nodes[0]!.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: r.child.nodes[0]!.metadataEnvelope,
                    metadataSigner: ALICE,
                    metadataSignature: r.child.nodes[0]!.metadataSignature,
                    versions: [],
                    shares: [],
                    links: [],
                },
            ],
        });
        const node = walked.nodes[0]!;
        if (node.error !== undefined) throw new Error(node.error);
        await alice.call('driveRotateCommit', { workspaceId: ws, nodeIds: [CHILD] });
        await expect(below(alice, 5, LATER)).resolves.toBeTruthy();
        // A later walk re-keys the child again and the grandchild under its fresh key, in one
        // batch: each fresh key is rooted as the key it is wrapped under, so the grandchild is
        // written under at once.
        const grandWalk = await alice.call('driveRotateNodes', {
            workspaceId: ws,
            targetEpoch: 10,
            granterUserId: ALICE,
            signers: {},
            group: { groupId, staged: null, writers: [] },
            nodes: [
                {
                    id: CHILD,
                    kind: 'folder',
                    parentId: area.root.id,
                    parentKeyEpoch: 5,
                    keyEpoch: 5,
                    wrappedParentKeyEpoch: 5,
                    keyEnvelope: node.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: node.metadataEnvelope,
                    metadataSigner: ALICE,
                    metadataSignature:
                        node.metadataSignature ?? r.child.nodes[0]!.metadataSignature,
                    versions: [],
                    shares: [],
                    links: [],
                },
                { ...r.grandInput, parentKeyEpoch: 10 },
            ],
        });
        expect(grandWalk.nodes.map((walked) => walked.error)).toEqual([undefined, undefined]);
        await alice.call('driveRotateCommit', { workspaceId: ws, nodeIds: [CHILD, GRAND] });
        await expect(
            alice.call('driveCreateNodes', newFolder(ws, GRAND, 10, LATER.replace('c5', 'c8'))),
        ).resolves.toBeTruthy();
        // And Bob, listing the re-keyed child under the new root, writes under it too.
        await bob.call('driveOpenNodes', {
            workspaceId: ws,
            nodes: [
                {
                    ...r.childListing,
                    parentKeyEpoch: 5,
                    keyEpoch: 5,
                    keyEnvelope: node.keyEnvelope,
                },
            ],
        });
        await expect(below(bob, 5, OTHER_WS.replace('d6d6d6d6', 'c7c7c7c7'))).resolves.toBeTruthy();
    });

    test('a family walk re-seals no share or link the server lists, re-seals what nobody signed as the walker’s, and walks a node once per target', async () => {
        const f = await family();
        const r = await rotated(f);
        const { alice, groupId, ws, area } = f;
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: r.rotation.selfGrant,
        });
        await alice.call('driveOpenNodes', { workspaceId: ws, nodes: [r.rotatedRoot()] });
        const child = {
            id: CHILD,
            kind: 'folder' as const,
            parentId: area.root.id,
            parentKeyEpoch: 5,
            keyEpoch: 1,
            wrappedParentKeyEpoch: 1,
            keyEnvelope: r.child.nodes[0]!.keyEnvelope,
            metadataVersion: 1,
            metadataEnvelope: r.child.nodes[0]!.metadataEnvelope,
            metadataSigner: ALICE as string | null,
            metadataSignature: r.child.nodes[0]!.metadataSignature as string | null,
            versions: [],
            shares: [] as CryptoRequests['driveRotateNodes']['nodes'][number]['shares'],
            links: [] as CryptoRequests['driveRotateNodes']['nodes'][number]['links'],
        };
        const walk = (node: typeof child) =>
            alice.call('driveRotateNodes', {
                workspaceId: ws,
                targetEpoch: 5,
                granterUserId: ALICE,
                signers: {},
                group: { groupId, staged: null, writers: [] },
                nodes: [node],
            });
        // A share the server lists, to a key of its choosing: the fresh key is sealed to nobody.
        const shared = await walk({
            ...child,
            shares: [
                {
                    id: OTHER_WS,
                    granteeUserId: BOB,
                    granteePublicKey: f.bob.served.encryptionPublicKey,
                    granteeKemPublicKey: f.bob.served.kemPublicKey,
                },
            ],
        });
        expect(shared.nodes[0]).toEqual({ id: CHILD, error: SHARED_IN_FAMILY });
        const linked = await walk({
            ...child,
            links: [{ id: OTHER_WS, hasPassword: false, secretEnvelope: null }],
        });
        expect(linked.nodes[0]).toEqual({ id: CHILD, error: SHARED_IN_FAMILY });
        await expect(
            alice.call('driveRotateCommit', { workspaceId: ws, nodeIds: [CHILD] }),
        ).resolves.toEqual({ committed: 0 });
        // Its metadata stripped of its signer: re-sealed as Alice's (decision D6), never kept as hers.
        const unsigned = (await walk({ ...child, metadataSigner: null, metadataSignature: null }))
            .nodes[0]!;
        if (unsigned.error !== undefined) throw new Error(unsigned.error);
        expect(unsigned.metadataSignature).not.toBeNull();
        expect(unsigned.metadataRekey).toBeNull();
        await alice.call('driveRotateDrop', { workspaceId: ws, nodeIds: [CHILD] });
        // The honest node walks, once: a second walk to the same target while it is pending is refused.
        expect((await walk(child)).nodes[0]!.error).toBeUndefined();
        expect((await walk(child)).nodes[0]).toEqual({
            id: CHILD,
            error: 'This item changed since it was opened. Refresh and retry.',
        });
        await expect(
            alice.call('driveRotateCommit', { workspaceId: ws, nodeIds: [CHILD] }),
        ).resolves.toEqual({ committed: 1 });
    });

    test('design 2.10 (F14): a key a walk made before the folder’s next roster landed takes no write', async () => {
        const f = await family();
        const r = await rotated(f);
        const { alice, bob, groupId, ws, area, server, marks, sync } = f;
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: r.rotation.selfGrant,
        });
        await alice.call('driveOpenNodes', { workspaceId: ws, nodes: [r.rotatedRoot()] });
        // The walk re-keys CHILD; the batch is not confirmed yet.
        const walked = await alice.call('driveRotateNodes', {
            workspaceId: ws,
            targetEpoch: 5,
            granterUserId: ALICE,
            signers: {},
            group: { groupId, staged: null, writers: [] },
            nodes: [
                {
                    id: CHILD,
                    kind: 'folder',
                    parentId: area.root.id,
                    parentKeyEpoch: 5,
                    keyEpoch: 1,
                    wrappedParentKeyEpoch: 1,
                    keyEnvelope: r.child.nodes[0]!.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: r.child.nodes[0]!.metadataEnvelope,
                    metadataSigner: ALICE,
                    metadataSignature: r.child.nodes[0]!.metadataSignature,
                    versions: [],
                    shares: [],
                    links: [],
                },
            ],
        });
        expect(walked.nodes[0]!.error).toBeUndefined();
        // Until then, what is made under the pending key is rooted as that key is, and takes writes.
        await expect(
            alice.call('driveCreateNodes', newFolder(ws, CHILD, 5, LATER)),
        ).resolves.toBeTruthy();
        await expect(
            alice.call('driveCreateNodes', newFolder(ws, LATER, 9, GRAND.replace('c6', 'cf'))),
        ).resolves.toBeTruthy();
        // Meanwhile the folder's next roster lands: its keys move to version 3.
        const rotatedRoot = r.rotation.root.rotated!;
        const second = await alice.call('groupStage', {
            groupId,
            expectedRevision: 3,
            op: {
                kind: 'rotate',
                rotation: {
                    workspaceId: ws,
                    targetEpoch: 7,
                    root: f.rootInput({
                        parentKeyEpoch: 3,
                        keyEpoch: 5,
                        wrappedParentKeyEpoch: 2,
                        keyEnvelope: r.rotation.root.keyEnvelope,
                        metadataEnvelope: rotatedRoot.metadataEnvelope,
                        metadataSignature: rotatedRoot.metadataSignature ?? null,
                        metadataRekey: rotatedRoot.metadataRekey
                            ? {
                                  origin: {
                                      envelope: area.root.metadataEnvelope,
                                      signerId: ALICE,
                                      signature: area.root.metadataSignature!,
                                      keyEnvelope: rotatedRoot.metadataRekey.originKeyEnvelope,
                                  },
                                  signature: rotatedRoot.metadataRekey.signature,
                              }
                            : null,
                        changeSeq: 2,
                    }),
                    documents: [],
                },
            },
            kems: { [BOB]: bob.served.kemPublicKey },
            writers: [],
        });
        if (second.outboxId === null) throw new Error('nothing staged');
        await alice.call('groupDrop', { outboxId: second.outboxId });
        server.store(second.body);
        await sync(alice, marks.alice);
        const third = second.body.rotation!;
        await expect(
            alice.call('groupOpenArea', {
                groupId,
                workspaceId: ws,
                idSeed: area.idSeed,
                servedVersion: 3,
                grant: null,
                selfGrant: third.selfGrant,
            }),
        ).resolves.toMatchObject({ version: 3 });
        await alice.call('driveOpenNodes', {
            workspaceId: ws,
            nodes: [
                {
                    ...r.rotatedRoot(false),
                    parentKeyEpoch: 3,
                    keyEpoch: 7,
                    keyEnvelope: third.root.keyEnvelope,
                    metadataEnvelope: third.root.rotated!.metadataEnvelope,
                },
            ],
        });
        // The walk's pending key for CHILD is rooted at version 2: nothing more goes under it.
        await expect(
            alice.call('driveCreateNodes', newFolder(ws, CHILD, 5, LATER.replace('c5', 'ce'))),
        ).rejects.toThrow(KEY_CHANGE_PENDING);
    });

    test('design 2.10 (F14): a node planted at the walk’s target under a folder’s old key is not carried into the new tree', async () => {
        const f = await family();
        const r = await rotated(f);
        const { alice, groupId, ws, area } = f;
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: r.rotation.selfGrant,
        });
        await alice.call('driveOpenNodes', { workspaceId: ws, nodes: [r.rotatedRoot()] });
        // A removed member holds CHILD's key 1 (any member did before the rotation). With the
        // server, they plant a node under it already at the walk's target, under a key of theirs.
        const areaKey = await openAreaSelfGrant(alice.root, ALICE, groupId, area.selfGrant);
        const rootKey = await openNodeKey(decode(f.rootListing.keyEnvelope), areaKey, {
            workspaceId: ws,
            nodeId: area.root.id,
            parentId: ws,
            parentKeyEpoch: 1,
            keyEpoch: 1,
        });
        const childKey = await openNodeKey(decode(r.childListing.keyEnvelope), rootKey, {
            workspaceId: ws,
            nodeId: CHILD,
            parentId: area.root.id,
            parentKeyEpoch: 1,
            keyEpoch: 1,
        });
        const theirs = crypto.getRandomValues(new Uint8Array(32));
        const planted = {
            ...r.grandInput,
            id: PLANTED,
            keyEpoch: 5,
            parentKeyEpoch: 5,
            keyEnvelope: encode(
                await wrapNodeKey(theirs, childKey, {
                    workspaceId: ws,
                    nodeId: PLANTED,
                    parentId: CHILD,
                    parentKeyEpoch: 1,
                    keyEpoch: 5,
                }),
            ),
        };
        // The walk re-keys CHILD, and is handed the planted node to re-wrap under CHILD's new key.
        const walked = await alice.call('driveRotateNodes', {
            workspaceId: ws,
            targetEpoch: 5,
            granterUserId: ALICE,
            signers: {},
            group: { groupId, staged: null, writers: [] },
            nodes: [
                {
                    id: CHILD,
                    kind: 'folder',
                    parentId: area.root.id,
                    parentKeyEpoch: 5,
                    keyEpoch: 1,
                    wrappedParentKeyEpoch: 1,
                    keyEnvelope: r.child.nodes[0]!.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: r.child.nodes[0]!.metadataEnvelope,
                    metadataSigner: ALICE,
                    metadataSignature: r.child.nodes[0]!.metadataSignature,
                    versions: [],
                    shares: [],
                    links: [],
                },
                planted,
                // Alice's own grandchild, cached since she made it under CHILD's key 1 (which the
                // removed member held too), and served as already at the target.
                { ...r.grandInput, parentKeyEpoch: 5 },
            ],
        });
        // The honest part of the walk completes; neither key is wrapped under the new one.
        expect(walked.nodes[0]!.error).toBeUndefined();
        expect(walked.nodes.slice(1)).toEqual([
            { id: PLANTED, error: NOT_CARRIED },
            { id: GRAND, error: NOT_CARRIED },
        ]);
        await alice.call('driveRotateCommit', { workspaceId: ws, nodeIds: [CHILD] });
        // Nor is it cached as anything a write may go under.
        await expect(
            alice.call('driveCreateNodes', newFolder(ws, PLANTED, 5, LATER)),
        ).rejects.toThrow();
        await expect(
            alice.call('driveCreateNodes', newFolder(ws, CHILD, 5, LATER)),
        ).resolves.toBeTruthy();
        // A key rooted at the folder's key (the folder just made) handed to a walk as if it sat
        // under the grandchild, whose key the removed member holds: never wrapped under it.
        const misplaced = await alice.call('driveRotateNodes', {
            workspaceId: ws,
            targetEpoch: 5,
            granterUserId: ALICE,
            signers: {},
            group: { groupId, staged: null, writers: [] },
            nodes: [
                {
                    ...r.grandInput,
                    id: LATER,
                    parentId: GRAND,
                    parentKeyEpoch: 9,
                    wrappedParentKeyEpoch: 9,
                },
            ],
        });
        expect(misplaced.nodes[0]).toEqual({ id: LATER, error: KEY_CHANGE_PENDING });
    });

    test('design 2.10 (F14): no write that seals under a folder’s key takes one reached through a previous key', async () => {
        const f = await family();
        const r = await rotated(f);
        const { alice, bob, groupId, ws, area } = f;
        await bob.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: r.grantTo(BOB),
            granterMlDsaPublicKey: alice.served.mlDsaPublicKey,
            selfGrant: null,
        });
        await bob.call('driveOpenNodes', {
            workspaceId: ws,
            nodes: [r.rotatedRoot(), r.childListing],
        });
        // A folder Bob makes under the rotated root is rooted at the folder key: every write below
        // takes it. CHILD, opened through the root's previous key, takes none of them.
        const ROOTED = 'c9c9c9c9-0000-4000-8000-000000000009';
        await bob.call('driveCreateNodes', newFolder(ws, area.root.id, 5, ROOTED));
        const both = async (
            write: (nodeId: string, keyEpoch: number) => Promise<unknown>,
        ): Promise<void> => {
            await expect(write(ROOTED, 9)).resolves.toBeTruthy();
            await expect(write(CHILD, 1)).rejects.toThrow(KEY_CHANGE_PENDING);
        };
        // Re-wrapped under the rotated root, whose key is rooted: the node's own key still is not.
        await both((nodeId, keyEpoch) =>
            bob.call('driveRewrapNode', {
                workspaceId: ws,
                nodeId,
                parentId: area.root.id,
                parentKeyEpoch: 5,
                keyEpoch,
            }),
        );
        const OBJECT = 'cbcbcbcb-0000-4000-8000-00000000000b';
        const VERSION = 'cccccccc-0000-4000-8000-00000000000c';
        await both((nodeId) =>
            bob.call('driveUploadPrepare', {
                workspaceId: ws,
                nodeId,
                versionId: VERSION,
                objectId: OBJECT,
                plaintextSize: 5,
            }),
        );
        // An upload prepared in the rooted folder, moved: never into CHILD.
        await bob.call('driveUploadPrepare', {
            workspaceId: ws,
            nodeId: ROOTED,
            versionId: VERSION,
            objectId: OBJECT,
            plaintextSize: 5,
        });
        await both((nodeId) =>
            bob.call('driveUploadRewrap', {
                workspaceId: ws,
                objectId: OBJECT,
                nodeId,
                versionId: VERSION,
            }),
        );
    });

    test('design 3.4: a family folder seals no share or link, in a folder that takes every other write', async () => {
        const f = await family();
        const r = await rotated(f);
        const { alice, bob, groupId, ws, area } = f;
        await bob.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: r.grantTo(BOB),
            granterMlDsaPublicKey: alice.served.mlDsaPublicKey,
            selfGrant: null,
        });
        await bob.call('driveOpenNodes', { workspaceId: ws, nodes: [r.rotatedRoot()] });
        const ROOTED = 'c9c9c9c9-0000-4000-8000-000000000009';
        // Writable: Bob makes it, and a folder under it.
        await bob.call('driveCreateNodes', newFolder(ws, area.root.id, 5, ROOTED));
        await expect(
            bob.call('driveCreateNodes', newFolder(ws, ROOTED, 9, LATER.replace('c5', 'cf'))),
        ).resolves.toBeTruthy();
        const LINK = 'cacacaca-0000-4000-8000-00000000000a';
        await expect(
            bob.call('driveSealShare', {
                workspaceId: ws,
                nodeId: ROOTED,
                keyEpoch: 9,
                granterUserId: BOB,
                granteeUserId: ALICE,
                granteePublicKey: alice.served.encryptionPublicKey,
                granteeKemPublicKey: alice.served.kemPublicKey,
            }),
        ).rejects.toThrow(FAMILY_SHARING);
        await expect(
            bob.call('driveSealLink', {
                workspaceId: ws,
                nodeId: ROOTED,
                keyEpoch: 9,
                linkId: LINK,
                password: null,
            }),
        ).rejects.toThrow(FAMILY_SHARING);
        await expect(
            bob.call('driveResealLink', {
                workspaceId: ws,
                nodeId: ROOTED,
                keyEpoch: 9,
                linkId: LINK,
                secretEnvelope: encode(new Uint8Array(136)),
                password: 'new',
            }),
        ).rejects.toThrow(FAMILY_SHARING);
        // The top folder too, whose key only the roster moves.
        await expect(
            bob.call('driveSealLink', {
                workspaceId: ws,
                nodeId: area.root.id,
                keyEpoch: 5,
                linkId: LINK,
                password: null,
            }),
        ).rejects.toThrow(FAMILY_SHARING);
    });

    test('design 2.10 (F11): deleting a folder stages its tombstone alone, and the folder is written and opened no more', async () => {
        const f = await family();
        const staged = await f.alice.call('groupStage', {
            groupId: f.groupId,
            expectedRevision: 2,
            op: { kind: 'retire', workspaceId: f.ws },
            kems: { [BOB]: f.bob.served.kemPublicKey },
        });
        if (staged.outboxId === null) throw new Error('nothing staged');
        // The tombstone, at the folder's next version, and nothing else: no grant, no rotation.
        expect(parseRoster(decode(staged.body.roster.statement)).areas).toEqual([
            { workspaceId: f.ws, workspaceKeyVersion: 2, commitment: '', retired: true },
        ]);
        expect(staged.body.grants ?? []).toEqual([]);
        expect(staged.body.rotations ?? []).toEqual([]);
        await f.alice.call('groupDrop', { outboxId: staged.outboxId });
        f.server.store(staged.body);
        const synced = await f.sync(f.alice, f.marks.alice);
        expect(synced.view.areas).toEqual({});
        // Nothing more is written there, on the device that had it open and writable.
        await expect(
            f.alice.call('driveCreateNodes', newFolder(f.ws, f.area.root.id, 1)),
        ).rejects.toThrow();
        // And a second deletion, or a rotation of it, is refused before anything is signed.
        await expect(
            f.alice.call('groupStage', {
                groupId: f.groupId,
                expectedRevision: 3,
                op: { kind: 'retire', workspaceId: f.ws },
                kems: {},
            }),
        ).rejects.toThrow();
    });

    test('an admission after a folder was deleted grants only the live folders', async () => {
        const f = await family();
        const retired = await f.alice.call('groupStage', {
            groupId: f.groupId,
            expectedRevision: 2,
            op: { kind: 'retire', workspaceId: f.ws },
            kems: { [BOB]: f.bob.served.kemPublicKey },
        });
        if (retired.outboxId === null) throw new Error('nothing staged');
        await f.alice.call('groupDrop', { outboxId: retired.outboxId });
        f.server.store(retired.body);
        await f.sync(f.alice, f.marks.alice);
        // The deleted folder's key was asked for, and the admission refused, before this.
        const carol = await account(CAROL);
        await checkWords(f.alice, carol);
        const admit = await f.alice.call('groupStage', {
            groupId: f.groupId,
            expectedRevision: 3,
            op: {
                kind: 'admit',
                userId: CAROL,
                served: carol.served,
                roles: [],
            },
            kems: { [BOB]: f.bob.served.kemPublicKey },
        });
        if (admit.outboxId === null) throw new Error('nothing staged');
        expect(admit.body.grants ?? []).toEqual([]);
        expect(parseRoster(decode(admit.body.roster.statement)).rosterVersion).toBe(4);
    });

    test('the organizer lets go of billing only once someone else active holds it', async () => {
        const f = await family();
        const stage = (userId: string, roles: GroupRole[], expectedRevision: number) =>
            f.alice.call('groupStage', {
                groupId: f.groupId,
                expectedRevision,
                op: { kind: 'roles', userId, roles },
                kems: { [BOB]: f.bob.served.kemPublicKey },
            });
        await expect(stage(ALICE, ['members'], 2)).rejects.toThrow(
            'Make someone else the organizer first.',
        );
        const handed = await stage(BOB, ['billing'], 2);
        if (handed.outboxId === null) throw new Error('nothing staged');
        await f.alice.call('groupDrop', { outboxId: handed.outboxId });
        f.server.store(handed.body);
        await f.sync(f.alice, f.marks.alice);
        const down = await stage(ALICE, ['members'], 3);
        if (down.outboxId === null) throw new Error('nothing staged');
        const roster = parseRoster(decode(down.body.roster.statement));
        expect(roster.members.find((member) => member.userId === ALICE)?.roles).toEqual([
            'members',
        ]);
    });

    test('a family folder’s self-grant never opens as a personal workspace, even before the family loads', async () => {
        const f = await family();
        const fresh = await f.alice.device();
        await expect(
            fresh.call('driveOpenWorkspace', { userId: ALICE, grant: f.area.selfGrant }),
        ).rejects.toThrow(/could not be opened/);
        // Once the family is known here, it is refused by name too.
        await expect(
            f.alice.call('driveOpenWorkspace', { userId: ALICE, grant: f.area.selfGrant }),
        ).rejects.toThrow(/family folder/);
    });
});
describe('group verdicts', () => {
    async function bobsFolder(f: Family) {
        await f.bob.call('driveOpenNodes', { workspaceId: f.ws, nodes: [f.rootListing] });
        const made = await f.bob.call('driveCreateNodes', {
            workspaceId: f.ws,
            nodes: [
                {
                    id: CHILD,
                    kind: 'folder',
                    parentId: f.area.root.id,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    metadata: folder('Bob’s'),
                },
            ],
        });
        const node = made.nodes[0]!;
        return {
            ...node,
            signed: {
                id: CHILD,
                kind: 'folder' as const,
                metadataVersion: 1,
                metadataEnvelope: node.metadataEnvelope,
                metadataSigner: BOB,
                metadataSignature: node.metadataSignature,
            },
        };
    }
    const writer = (over: Partial<GroupWriter>, served: Account['served']): GroupWriter => ({
        userId: BOB,
        pinned: null,
        served,
        links: [],
        personal: null,
        ...over,
    });

    test('a family folder’s records are never judged by personal pins alone', async () => {
        const f = await family();
        const folderOf = await bobsFolder(f);
        const personal = { [BOB]: { current: f.bob.served.signingPublicKey, retired: [] } };
        // Alice pinned Bob personally: driveVerify would call his record verified, by her pin alone.
        await expect(
            f.alice.call('driveVerify', {
                workspaceId: f.ws,
                signers: personal,
                nodes: [folderOf.signed],
            }),
        ).rejects.toThrow(/family’s member list/);
        // Nor copied with its records re-signed on personal pins.
        await expect(
            f.alice.call('driveCopyFile', {
                workspaceId: f.ws,
                signers: personal,
                source: {
                    nodeId: CHILD,
                    metadataVersion: 1,
                    metadataEnvelope: folderOf.metadataEnvelope,
                    metadataSigner: BOB,
                    metadataSignature: folderOf.metadataSignature,
                    signer: BOB,
                    signature: folderOf.metadataSignature,
                    id: LATER,
                    objectId: LATER,
                    contentKeyEnvelope: folderOf.metadataEnvelope,
                    contentSuite: 2,
                    plaintextSize: null,
                },
                node: {
                    id: LATER,
                    parentId: f.area.root.id,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: folder('Copy'),
                },
                versionId: LATER,
            }),
        ).rejects.toThrow(/only with the family’s trust/);
        // Her own workspace is still checked as ever.
        await expect(
            f.alice.call('driveVerify', { workspaceId: OTHER_WS, signers: personal, nodes: [] }),
        ).resolves.toEqual({ nodes: [] });
    });

    test('verified through the family, through one’s own check, a key conflict, and a bad signature only when the links loaded', async () => {
        const f = await family();
        const folderOf = await bobsFolder(f);
        const verify = async (who: GroupWriter, node = folderOf.signed) =>
            (
                await f.alice.call('groupVerify', {
                    groupId: f.groupId,
                    workspaceId: f.ws,
                    writers: [who],
                    nodes: [node],
                })
            ).nodes[0]!;
        await expect(verify(writer({}, f.bob.served))).resolves.toMatchObject({
            metadata: 'verified',
            via: f.groupId,
        });
        // The family is the one the folder was opened under, never the caller's word for it.
        await expect(
            f.alice.call('groupVerify', {
                groupId: crypto.randomUUID(),
                workspaceId: f.ws,
                writers: [],
                nodes: [],
            }),
        ).rejects.toThrow(/not one of this family’s/);
        await expect(
            verify(writer({ pinned: await writerPinOf(f.bob) }, f.bob.served)),
        ).resolves.toMatchObject({ metadata: 'verified', via: null });
        // Alice's own check of Bob named other keys, and nothing links them.
        const carol = await account(CAROL);
        await expect(
            verify(
                writer(
                    { pinned: await writerPinOf({ userId: BOB, served: carol.served }) },
                    f.bob.served,
                ),
            ),
        ).resolves.toMatchObject({ metadata: 'key-conflict', via: null });
        // A signature none of Bob's keys holds: bad when his links loaded, unchecked when they did not.
        const flipped = decode(folderOf.metadataSignature);
        flipped[0]! ^= 1;
        const tampered = { ...folderOf.signed, metadataSignature: encode(flipped) };
        await expect(verify(writer({}, f.bob.served), tampered)).resolves.toMatchObject({
            metadata: 'bad-signature',
        });
        await expect(
            verify(writer({ served: null, links: null }, f.bob.served), tampered),
        ).resolves.toMatchObject({ metadata: 'unchecked' });
        // A member list that did not verify vouches for nobody.
        await expect(
            f.alice.call('groupAccept', {
                userId: ALICE,
                groupId: f.groupId,
                served: {
                    ...f.server.served(),
                    firstKeys: (await groupKeyPair(newGroupSeed())).publicKey,
                },
                record: f.marks.alice.record,
                checkedAt: CHECKED,
            }),
        ).rejects.toThrow(/not the group keys this person checked/);
        await expect(verify(writer({}, f.bob.served))).resolves.toMatchObject({
            metadata: 'unchecked',
        });
        // But a stripped signature is unsigned whatever did not load: never hidden as unchecked.
        await expect(
            verify(writer({}, f.bob.served), { ...folderOf.signed, metadataSignature: '' }),
        ).resolves.toMatchObject({ metadata: 'unsigned' });
    });

    test('a walk keeps a member’s record as theirs, re-keyed, with no word of who is leaving, and one nobody can check no longer stops it', async () => {
        const f = await family();
        const bobs = await bobsFolder(f);
        await f.alice.call('driveOpenNodes', { workspaceId: f.ws, nodes: [f.rootListing] });
        const node = (metadataSignature: string) => ({
            id: CHILD,
            kind: 'folder' as const,
            parentId: f.area.root.id,
            parentKeyEpoch: 1,
            keyEpoch: 1,
            wrappedParentKeyEpoch: 1,
            keyEnvelope: bobs.keyEnvelope,
            metadataVersion: 1,
            metadataEnvelope: bobs.metadataEnvelope,
            metadataSigner: BOB,
            metadataSignature,
            versions: [],
            shares: [],
            links: [],
        });
        // Each walk starts over, the last one's batch dropped (a node is walked once per target).
        const walk = async (writers: GroupWriter[], metadataSignature = bobs.metadataSignature) => {
            await f.alice.call('driveRotateDrop', { workspaceId: f.ws, nodeIds: [CHILD] });
            return f.alice.call('driveRotateNodes', {
                workspaceId: f.ws,
                targetEpoch: 7,
                granterUserId: ALICE,
                signers: {},
                group: { groupId: f.groupId, staged: null, writers },
                nodes: [node(metadataSignature)],
            });
        };
        const aliceKey = decode(f.alice.served.signingPublicKey, 32);
        const ctx = {
            workspaceId: f.ws,
            nodeId: CHILD,
            kind: 'folder' as const,
            metadataVersion: 1,
        };
        /* What the walk signed: nothing in Alice's name as writer, only the binding to Bob's record. */
        const signedOver = async (
            result: CryptoResults['driveRotateNodes'],
            originSignature: string,
        ) => {
            const rotated = result.nodes[0]!;
            if (rotated.error !== undefined) throw new Error(rotated.error);
            expect(rotated.metadataSignature).toBeNull();
            expect(rotated.metadataDropOrigin).toBeUndefined();
            const rekey = rotated.metadataRekey!;
            return verifyStatement(
                await metadataRekeyedStatement(
                    { ...ctx, keyEpoch: 7 },
                    decode(rotated.metadataEnvelope),
                    {
                        envelope: decode(bobs.metadataEnvelope),
                        signerId: BOB,
                        signature: decode(originSignature),
                        keyEnvelope: decode(rekey.originKeyEnvelope),
                    },
                ),
                decode(rekey.signature),
                aliceKey,
            );
        };
        // Bob is active on the committed chain, and the walk need not know he is leaving.
        expect(
            await signedOver(await walk([writer({}, f.bob.served)]), bobs.metadataSignature),
        ).toBe(true);
        // A record nobody can check (a signature none of Bob's keys holds, his links withheld)
        // stopped the walk before: it is kept as it is, for readers to judge.
        const flipped = decode(bobs.metadataSignature);
        flipped[0]! ^= 1;
        const tampered = encode(flipped);
        expect(
            await signedOver(
                await walk([writer({ served: null, links: null }, f.bob.served)], tampered),
                tampered,
            ),
        ).toBe(true);
        // Nor does the walk depend on who the family's list names at all.
        expect(await signedOver(await walk([]), bobs.metadataSignature)).toBe(true);
    });

    test('a removal’s rotation keeps the removed member’s records as theirs and never re-signs them as the remover’s', async () => {
        const f = await family();
        const { alice, bob, groupId, ws, area, server, marks } = f;
        const bobs = await bobsFolder(f);
        // Bob renamed the family folder: the root's record is his.
        const renamed = await bob.call('driveSealMetadata', {
            workspaceId: ws,
            nodeId: area.root.id,
            kind: 'folder',
            metadataVersion: 2,
            metadata: folder('Family (Bob)'),
        });
        const bobWriter = writer({}, bob.served);
        const removal = await alice.call('groupStage', {
            groupId,
            expectedRevision: 2,
            op: {
                kind: 'remove',
                userId: BOB,
                rotations: [
                    {
                        workspaceId: ws,
                        targetEpoch: 7,
                        root: f.rootInput({
                            metadataVersion: 2,
                            metadataEnvelope: renamed.metadataEnvelope,
                            metadataSigner: BOB,
                            metadataSignature: renamed.metadataSignature,
                        }),
                        documents: [],
                    },
                ],
            },
            kems: {},
            writers: [bobWriter],
        });
        if (removal.outboxId === null) throw new Error('nothing staged');
        const [rotation] = removal.body.rotations!;
        // Bob's record stays his: re-keyed over his envelope and signature, and nothing beside it
        // in Alice's name, ordinary or re-sealed (readers then name Bob, who has left).
        const ctx = {
            workspaceId: ws,
            nodeId: area.root.id,
            kind: 'folder' as const,
            metadataVersion: 2,
        };
        const rotated = rotation!.root.rotated!;
        expect(rotated.metadataSignature).toBeNull();
        const aliceKey = decode(alice.served.signingPublicKey, 32);
        expect(
            await verifyStatement(
                await metadataRekeyedStatement(
                    { ...ctx, keyEpoch: 7 },
                    decode(rotated.metadataEnvelope),
                    {
                        envelope: decode(renamed.metadataEnvelope),
                        signerId: BOB,
                        signature: decode(renamed.metadataSignature),
                        keyEnvelope: decode(rotated.metadataRekey!.originKeyEnvelope),
                    },
                ),
                decode(rotated.metadataRekey!.signature),
                aliceKey,
            ),
        ).toBe(true);
        // A record nobody can check no longer stops the removal: staged all the same.
        const flipped = decode(renamed.metadataSignature);
        flipped[0]! ^= 1;
        const unreadable = await alice.call('groupStage', {
            groupId,
            expectedRevision: 2,
            op: {
                kind: 'remove',
                userId: BOB,
                rotations: [
                    {
                        workspaceId: ws,
                        targetEpoch: 7,
                        root: f.rootInput({
                            metadataVersion: 2,
                            metadataEnvelope: renamed.metadataEnvelope,
                            metadataSigner: BOB,
                            metadataSignature: encode(flipped),
                        }),
                        documents: [],
                    },
                ],
            },
            kems: {},
            writers: [writer({ served: null, links: null }, bob.served)],
        });
        if (unreadable.outboxId === null) throw new Error('nothing staged');
        expect(unreadable.body.rotations![0]!.root.rotated!.metadataRekey).toBeTruthy();
        await alice.call('groupDrop', { outboxId: unreadable.outboxId });
        // Only the remaining member is granted the new key.
        expect(removal.body.grants!.map((grant) => grant.granteeUserId)).toEqual([ALICE]);
        // A walk in a family folder is never judged personally, nor by another group's roster.
        const walk = (group: CryptoRequests['driveRotateNodes']['group']) =>
            alice.call('driveRotateNodes', {
                workspaceId: ws,
                targetEpoch: 7,
                granterUserId: ALICE,
                signers: { [BOB]: { current: bob.served.signingPublicKey, retired: [] } },
                group,
                nodes: [],
            });
        await expect(walk(null)).rejects.toThrow(/only with the family’s trust/);
        await expect(
            walk({ groupId: crypto.randomUUID(), staged: null, writers: [] }),
        ).rejects.toThrow(/not one of this family’s/);
        // Nor by the roster of another family this device holds, which lists other folders.
        const second = await alice.call('groupCreate', {
            userId: ALICE,
            name: 'Second',
            identities: { identity: alice.identity, history: [] },
        });
        await alice.call('groupDrop', { outboxId: second.outboxId });
        const secondServer = serverOf(second);
        await secondServer.signer(alice);
        await alice.call('groupAccept', {
            userId: ALICE,
            groupId: second.groupId,
            served: secondServer.served(),
            record: null,
            checkedAt: CHECKED,
            creating: { stagedEnvelope: second.stagedEnvelope },
        });
        await expect(walk({ groupId: second.groupId, staged: null, writers: [] })).rejects.toThrow(
            /not one of this family’s/,
        );

        // It lands; the walk then judges with the committed chain, where Bob has left.
        server.store(removal.body);
        await alice.call('groupDrop', { outboxId: removal.outboxId });
        const { view } = await f.sync(alice, marks.alice);
        expect(view.members.find((m) => m.userId === BOB)?.status).toBe('left');
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: rotation!.selfGrant,
        });
        await alice.call('driveOpenNodes', {
            workspaceId: ws,
            nodes: [
                {
                    id: area.root.id,
                    parentId: ws,
                    parentKeyEpoch: 2,
                    keyEpoch: 7,
                    keyEnvelope: rotation!.root.keyEnvelope,
                    metadataVersion: 2,
                    metadataEnvelope: rotation!.root.rotated!.metadataEnvelope,
                    prevKeyEnvelope: rotation!.previousRootKeyEnvelope,
                    prevKeyEpoch: 1,
                    prevParentKeyEpoch: 2,
                },
            ],
        });
        const walked = await alice.call('driveRotateNodes', {
            workspaceId: ws,
            targetEpoch: 7,
            granterUserId: ALICE,
            signers: {},
            group: { groupId, staged: null, writers: [bobWriter] },
            nodes: [
                {
                    id: CHILD,
                    kind: 'folder',
                    parentId: area.root.id,
                    parentKeyEpoch: 7,
                    keyEpoch: 1,
                    wrappedParentKeyEpoch: 1,
                    keyEnvelope: bobs.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: bobs.metadataEnvelope,
                    metadataSigner: BOB,
                    metadataSignature: bobs.metadataSignature,
                    versions: [],
                    shares: [],
                    links: [],
                },
            ],
        });
        const node = walked.nodes[0]!;
        if (node.error !== undefined) throw new Error(node.error);
        const childCtx = {
            workspaceId: ws,
            nodeId: CHILD,
            kind: 'folder' as const,
            metadataVersion: 1,
        };
        // Nothing in Alice's name as its writer: no legacy signature, only her re-key.
        expect(node.metadataSignature).toBeNull();
        const rekey = node.metadataRekey!;
        expect(
            await verifyStatement(
                await metadataRekeyedStatement(
                    { ...childCtx, keyEpoch: 7 },
                    decode(node.metadataEnvelope),
                    {
                        envelope: decode(bobs.metadataEnvelope),
                        signerId: BOB,
                        signature: decode(bobs.metadataSignature),
                        keyEnvelope: decode(rekey.originKeyEnvelope),
                    },
                ),
                decode(rekey.signature),
                aliceKey,
            ),
        ).toBe(true);
        // Bob's original record reads as a former member's, never as verified.
        const verdict = await alice.call('groupVerify', {
            groupId,
            workspaceId: ws,
            writers: [bobWriter],
            nodes: [bobs.signed],
        });
        expect(verdict.nodes[0]).toMatchObject({ metadata: 'former-member', via: null });
        // And so does the re-keyed record, as the server serves it once applied: named after
        // Bob, who has left, with Alice as the re-keyer the family vouches for.
        await alice.call('driveRotateCommit', { workspaceId: ws, nodeIds: [CHILD] });
        const served = {
            ...bobs.signed,
            metadataEnvelope: node.metadataEnvelope,
            metadataSigner: ALICE,
            metadataSignature: null,
            keyEpoch: 7,
            metadataRekey: {
                origin: {
                    envelope: bobs.metadataEnvelope,
                    signerId: BOB,
                    signature: bobs.metadataSignature,
                    keyEnvelope: rekey.originKeyEnvelope,
                },
                signature: rekey.signature,
            },
        };
        const rekeyed = await alice.call('groupVerify', {
            groupId,
            workspaceId: ws,
            writers: [bobWriter],
            nodes: [served],
        });
        expect(rekeyed.nodes[0]).toMatchObject({
            metadata: 'former-member',
            metadataRekey: { rekeyer: 'verified', bound: true },
        });
        // A current envelope the node's key does not open (the server's own doing, for all a
        // reader knows): couldn't confirm, never Bob's verdict and never Alice's fault.
        const swapped = await alice.call('groupVerify', {
            groupId,
            workspaceId: ws,
            writers: [bobWriter],
            nodes: [{ ...served, metadataEnvelope: bobs.metadataEnvelope }],
        });
        expect(swapped.nodes[0]).toMatchObject({
            metadata: 'unchecked',
            metadataRekey: { bound: null },
        });

        // The next walk carries Bob's origin byte for byte, under a new wrap at the new epoch,
        // after its own bound check, and the record still reads as his.
        const walkAgain = (
            from: typeof node,
            keyEpoch: number,
            targetEpoch: number,
            rekey: unknown,
        ) =>
            alice.call('driveRotateNodes', {
                workspaceId: ws,
                targetEpoch,
                granterUserId: ALICE,
                signers: {},
                group: { groupId, staged: null, writers: [bobWriter] },
                nodes: [
                    {
                        id: CHILD,
                        kind: 'folder',
                        parentId: area.root.id,
                        parentKeyEpoch: 7,
                        keyEpoch,
                        wrappedParentKeyEpoch: 7,
                        keyEnvelope: from.keyEnvelope,
                        metadataVersion: 1,
                        metadataEnvelope: from.metadataEnvelope,
                        metadataSigner: ALICE,
                        metadataSignature: null,
                        metadataRekey: rekey as never,
                        versions: [],
                        shares: [],
                        links: [],
                    },
                ],
            });
        const again = (await walkAgain(node, 7, 9, served.metadataRekey)).nodes[0]!;
        if (again.error !== undefined) throw new Error(again.error);
        expect(again.metadataDropOrigin).toBeUndefined();
        expect(again.metadataRekey!.originKeyEnvelope).not.toBe(rekey.originKeyEnvelope);
        await alice.call('driveRotateCommit', { workspaceId: ws, nodeIds: [CHILD] });
        const carried = {
            ...served,
            metadataEnvelope: again.metadataEnvelope,
            keyEpoch: 9,
            metadataRekey: {
                origin: {
                    ...served.metadataRekey.origin,
                    keyEnvelope: again.metadataRekey!.originKeyEnvelope,
                },
                signature: again.metadataRekey!.signature,
            },
        };
        const reread = await alice.call('groupVerify', {
            groupId,
            workspaceId: ws,
            writers: [bobWriter],
            nodes: [carried],
        });
        expect(reread.nodes[0]).toMatchObject({
            metadata: 'former-member',
            metadataRekey: { rekeyer: 'verified', bound: true },
        });
        // An origin that does not bind (the wrap opens no such envelope): dropped and re-sealed,
        // never carried under Alice's name.
        const dropped = (
            await walkAgain(again, 9, 11, {
                ...carried.metadataRekey,
                origin: { ...carried.metadataRekey.origin, envelope: bobs.keyEnvelope },
            })
        ).nodes[0]!;
        if (dropped.error !== undefined) throw new Error(dropped.error);
        expect(dropped.metadataDropOrigin).toBe(true);
        expect(dropped.metadataRekey ?? null).toBeNull();
        expect(
            await verifyStatement(
                await metadataResealedStatement(childCtx, decode(dropped.metadataEnvelope)),
                decode(dropped.metadataSignature!),
                aliceKey,
            ),
        ).toBe(true);
    });
});

describe('holders and the group key', () => {
    test('removing a key holder carries the succession and its seals, and the remaining holder signs on under the new key', async () => {
        const f = await family(['members']);
        const { alice, bob, groupId, ws, server, marks } = f;
        // A new holder is sealed the current key in the admitting call, and opens it.
        const keySeal = f.admit.body.keySeal!;
        expect(keySeal).toMatchObject({ holderUserId: BOB, groupKeyVersion: 1, rosterVersion: 2 });
        await expect(
            bob.call('groupOpenSeal', {
                groupId,
                seal: { ...keySeal, sealerUserId: ALICE },
                sealerMlDsaPublicKey: alice.served.mlDsaPublicKey,
            }),
        ).resolves.toEqual({ groupKeyVersion: 1 });
        const removal = await alice.call('groupStage', {
            groupId,
            expectedRevision: 2,
            op: {
                kind: 'remove',
                userId: BOB,
                rotations: [
                    { workspaceId: ws, targetEpoch: 7, root: f.rootInput(), documents: [] },
                ],
            },
            kems: {},
            writers: [],
        });
        if (removal.outboxId === null) throw new Error('nothing staged');
        expect(removal.body.succession).toBeTruthy();
        // The new seed goes to every holder who remains, and to nobody removed.
        expect(
            removal.body.seals!.map((seal) => [seal.holderUserId, seal.groupKeyVersion]),
        ).toEqual([[ALICE, 2]]);
        expect(removal.body.keySeal).toBeUndefined();
        server.store(removal.body);
        await alice.call('groupDrop', { outboxId: removal.outboxId });
        const { view } = await f.sync(alice, marks.alice);
        expect(view).toMatchObject({ rosterVersion: 3, groupKeyVersion: 2, successionDue: false });
        // Until the new seal is opened, nothing more is signed; then the next change is.
        const next = {
            groupId,
            expectedRevision: 3,
            op: { kind: 'area' as const, name: 'Photos' },
            kems: {},
        };
        await expect(alice.call('groupStage', next)).rejects.toThrow(/Open the family’s key first/);
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: f.area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: removal.body.rotations![0]!.selfGrant,
        });
        await alice.call('groupOpenSeal', {
            groupId,
            seal: { ...removal.body.seals![0]!, sealerUserId: ALICE },
            sealerMlDsaPublicKey: alice.served.mlDsaPublicKey,
        });
        const staged = await alice.call('groupStage', next);
        if (staged.outboxId === null) throw new Error('nothing staged');
        server.store(staged.body);
        await alice.call('groupDrop', { outboxId: staged.outboxId });
        await expect(f.sync(alice, marks.alice)).resolves.toMatchObject({
            view: { rosterVersion: 4, groupKeyVersion: 2 },
        });
    });

    test('grants and seals owed on the committed chain open for their recipients', async () => {
        const f = await family();
        const { alice, bob, groupId, ws, area } = f;
        const { grants } = await alice.call('groupGrants', {
            groupId,
            missing: [{ workspaceId: ws, userId: BOB, kemPublicKey: bob.served.kemPublicKey }],
        });
        expect(grants).toMatchObject([
            { workspaceId: ws, workspaceKeyVersion: 1, rosterVersion: 2 },
        ]);
        const fresh = await bob.device();
        await f.sync(fresh, f.marks.bob);
        await expect(
            fresh.call('groupOpenArea', {
                groupId,
                workspaceId: ws,
                idSeed: area.idSeed,
                servedVersion: 1,
                grant: { ...grants[0]!, granterUserId: ALICE },
                granterMlDsaPublicKey: alice.served.mlDsaPublicKey,
                selfGrant: null,
            }),
        ).resolves.toMatchObject({ version: 1 });
        // Only holders are sealed the key, and only by a holder who has it.
        await expect(
            alice.call('groupReseal', {
                groupId,
                holders: [{ userId: BOB, kemPublicKey: bob.served.kemPublicKey }],
            }),
        ).rejects.toThrow(/only to members who hold it/);
        const { seals } = await alice.call('groupReseal', {
            groupId,
            holders: [{ userId: ALICE, kemPublicKey: alice.served.kemPublicKey }],
        });
        const other = await alice.device();
        await f.sync(other, f.marks.alice);
        await expect(
            other.call('groupOpenSeal', {
                groupId,
                seal: { ...seals[0]!, sealerUserId: ALICE },
                sealerMlDsaPublicKey: alice.served.mlDsaPublicKey,
            }),
        ).resolves.toEqual({ groupKeyVersion: 1 });
    });
});

describe('more roster changes', () => {
    test('marking a departed member left rotates every folder, grants only who remains, and needs no succession', async () => {
        const f = await family();
        const { alice, groupId, ws, area, server, marks } = f;
        const op = (rotations: AreaRotationInput[]) => ({
            groupId,
            expectedRevision: 2,
            op: { kind: 'markLeft' as const, userIds: [BOB], rotations },
            kems: {},
            writers: [],
        });
        // A departure that leaves a folder's key unchanged is refused before anything is signed.
        await expect(alice.call('groupStage', op([]))).rejects.toThrow(
            /Every family folder must get new keys/,
        );
        await expect(
            alice.call('groupStage', {
                ...op([]),
                op: { kind: 'markLeft', userIds: [CAROL], rotations: [] },
            }),
        ).rejects.toThrow(/not in the family now/);
        const staged = await alice.call(
            'groupStage',
            op([{ workspaceId: ws, targetEpoch: 3, root: f.rootInput(), documents: [] }]),
        );
        if (staged.outboxId === null) throw new Error('nothing staged');
        expect(staged.body.succession).toBeUndefined();
        expect(
            staged.body.rotations!.map((r) => [r.workspaceId, r.fromVersion, r.toVersion]),
        ).toEqual([[ws, 1, 2]]);
        expect(staged.body.grants!.map((grant) => grant.granteeUserId)).toEqual([ALICE]);
        server.store(staged.body);
        await alice.call('groupDrop', { outboxId: staged.outboxId });
        const { view } = await f.sync(alice, marks.alice);
        expect(view).toMatchObject({ rosterVersion: 3, groupKeyVersion: 1, areas: { [ws]: 2 } });
        expect(view.members.find((m) => m.userId === BOB)?.status).toBe('left');
        // Bob keeps nothing new: the only grant of key 2 is Alice's, and his own key 1 no longer writes.
        await f.sync(f.bob, f.marks.bob);
        await expect(
            f.bob.call('driveCreateNodes', {
                workspaceId: ws,
                nodes: [
                    {
                        id: LATER,
                        kind: 'folder',
                        parentId: ws,
                        parentKeyEpoch: 1,
                        keyEpoch: 9,
                        metadata: folder('Late'),
                    },
                ],
            }),
        ).rejects.toThrow(KEYS_CHANGED);
        await expect(
            alice.call('groupOpenArea', {
                groupId,
                workspaceId: ws,
                idSeed: area.idSeed,
                servedVersion: 2,
                grant: null,
                selfGrant: staged.body.rotations![0]!.selfGrant,
            }),
        ).resolves.toMatchObject({ version: 2 });
    });

    test('a new folder’s grant, once its roster lands, opens for another member from what the server serves', async () => {
        const f = await family();
        const { alice, bob, groupId, server, marks } = f;
        const staged = await alice.call('groupStage', {
            groupId,
            expectedRevision: 2,
            op: { kind: 'area', name: 'Photos' },
            kems: { [BOB]: bob.served.kemPublicKey },
        });
        if (staged.outboxId === null) throw new Error('nothing staged');
        const made = staged.body.area!;
        expect(
            staged.body.grants!.map((grant) => [grant.granteeUserId, grant.workspaceId]),
        ).toEqual([
            [ALICE, made.workspaceId],
            [BOB, made.workspaceId],
        ]);
        // Before it lands, the folder is on no member list a device committed to.
        const grant = {
            ...staged.body.grants!.find((at) => at.granteeUserId === BOB)!,
            granterUserId: ALICE,
        };
        const openNew = (who: { call: Call }) =>
            who.call('groupOpenArea', {
                groupId,
                workspaceId: made.workspaceId,
                idSeed: made.idSeed,
                servedVersion: 1,
                grant,
                granterMlDsaPublicKey: alice.served.mlDsaPublicKey,
                selfGrant: null,
            });
        await expect(openNew(bob)).rejects.toThrow(/not on the family’s member list/);
        server.store(staged.body);
        await alice.call('groupDrop', { outboxId: staged.outboxId });
        await f.sync(alice, marks.alice);
        // Bob on a fresh device: the roster, then the grant, all from what was served.
        const fresh = await bob.device();
        const { view } = await f.sync(fresh, marks.bob);
        expect(view.areas).toMatchObject({ [made.workspaceId]: 1 });
        await expect(openNew(fresh)).resolves.toMatchObject({ version: 1 });
        // Another area's id seed does not pass for this one.
        await expect(
            fresh.call('groupOpenArea', {
                groupId,
                workspaceId: made.workspaceId,
                idSeed: f.area.idSeed,
                servedVersion: 1,
                grant,
                granterMlDsaPublicKey: alice.served.mlDsaPublicKey,
                selfGrant: null,
            }),
        ).rejects.toThrow(/does not belong to the family/);
        const root = await fresh.call('driveOpenNodes', {
            workspaceId: made.workspaceId,
            nodes: [
                {
                    id: made.root.id,
                    parentId: made.workspaceId,
                    parentKeyEpoch: 1,
                    keyEpoch: 1,
                    keyEnvelope: made.root.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: made.root.metadataEnvelope,
                },
            ],
        });
        expect(root.nodes[0]!.metadata?.name).toBe('Photos');
        // Alice opens it through her self-grant from the same call.
        await expect(
            alice.call('groupOpenArea', {
                groupId,
                workspaceId: made.workspaceId,
                idSeed: made.idSeed,
                servedVersion: 1,
                grant: null,
                selfGrant: made.selfGrant,
            }),
        ).resolves.toMatchObject({ version: 1 });
    });
});

describe('one’s own identity', () => {
    async function succeeded(alice: Account) {
        const next = await alice.call('identitySucceed', {
            userId: ALICE,
            identity: alice.identity,
        });
        const link: SuccessionLink = {
            oldKeyVersion: alice.identity.keyVersion,
            newKeyVersion: next.identity.keyVersion,
            oldEncryptionPublicKey: alice.identity.encryptionPublicKey,
            oldSigningPublicKey: alice.identity.signingPublicKey,
            oldMlDsaPublicKey: alice.identity.mlDsa.publicKey,
            newEncryptionPublicKey: next.identity.encryptionPublicKey,
            newSigningPublicKey: next.identity.signingPublicKey,
            newMlDsaPublicKey: next.identity.mlDsa!.publicKey,
            newKemPublicKey: next.identity.kem!.publicKey,
            signature: next.signature,
            consent: next.consent,
        };
        return { next: next.identity, link };
    }

    test('one’s own fold-in is signed with the keys the old entry names, and everyone then accepts it', async () => {
        const f = await family();
        const { alice, groupId, server } = f;
        const { next, link } = await succeeded(alice);
        // The server took the succession; this device opens the new identity beside the old one.
        await alice.call('identityOpen', {
            userId: ALICE,
            identity: next,
            history: [alice.identity],
            refresh: true,
        });
        const served = publicIdentity(next);
        await expect(
            alice.call('groupStage', {
                groupId,
                expectedRevision: 2,
                op: { kind: 'area', name: 'X' },
                kems: {},
            }),
        ).rejects.toThrow(/Fold in your new keys first/);
        const op = { kind: 'foldIn' as const, members: [{ userId: ALICE, served, links: [link] }] };
        await expect(
            alice.call('groupStage', { groupId, expectedRevision: 2, op, kems: {} }),
        ).rejects.toThrow(/earlier keys are needed/);
        const staged = await alice.call('groupStage', {
            groupId,
            expectedRevision: 2,
            op: { ...op, history: [alice.identity] },
            kems: {},
        });
        if (staged.outboxId === null) throw new Error('nothing staged');
        server.store(staged.body);
        await alice.call('groupDrop', { outboxId: staged.outboxId });
        await server.signer({ served });
        // Bob, verifying on his own, takes it: the signer's old entry named the old keys.
        const { view } = await f.sync(f.bob, f.marks.bob);
        expect(view.members.find((m) => m.userId === ALICE)).toMatchObject({
            keyVersion: 2,
            signingPublicKey: served.signingPublicKey,
        });
        const mine = await f.sync(alice, f.marks.alice);
        expect(mine.view).toMatchObject({ rosterVersion: 3, ownEntryWrongAt: [] });
        // The fold-in carried Alice's grant to her new keys, which she opens with them.
        const grant = staged.body.grants!.find((at) => at.granteeUserId === ALICE)!;
        expect(grant.granteeKeyVersion).toBe(2);
        const fresh = await alice.device(next, [alice.identity]);
        await f.sync(fresh, f.marks.alice);
        await expect(
            fresh.call('groupOpenArea', {
                groupId,
                workspaceId: f.ws,
                idSeed: f.area.idSeed,
                servedVersion: 1,
                grant: { ...grant, granterUserId: ALICE },
                granterMlDsaPublicKey: served.mlDsaPublicKey,
                selfGrant: null,
            }),
        ).resolves.toMatchObject({ version: 1 });
    });

    test('identityConsent signs only two of this account’s identities opened one after the other, every key checked', async () => {
        const alice = await account(ALICE);
        const { next, link } = await succeeded(alice);
        const ask = (old: IdentityEnvelope, nxt: IdentityEnvelope, through = link) =>
            alice.call('identityConsent', { userId: ALICE, link: through, old, next: nxt });
        // The succession is not open on this device yet: not a step of its own history.
        await expect(ask(alice.identity, next)).rejects.toThrow(/one after the other/);
        await alice.call('identityOpen', {
            userId: ALICE,
            identity: next,
            history: [alice.identity],
            refresh: true,
        });
        const { consent } = await ask(alice.identity, next);
        expect(await verifySuccessionConsent(ALICE, { ...link, consent })).toBe(true);
        const bob = await account(BOB);
        expect(
            await verifySuccessionConsent(ALICE, {
                ...link,
                newSigningPublicKey: bob.served.signingPublicKey,
                consent,
            }),
        ).toBe(false);
        // An envelope served with another ML-KEM key: no consent binds the account's signing
        // keys to an encryption key the server chose.
        if (next.version !== 2) throw new Error('expected version 2');
        const tampered: IdentityEnvelope = {
            ...next,
            kem: { ...next.kem, publicKey: bob.served.kemPublicKey },
        };
        await expect(ask(alice.identity, tampered)).rejects.toThrow(
            'This identity does not open on this account.',
        );
        // An identity at the next version that is not this account's at all.
        const stranger = await createIdentity(crypto.getRandomValues(new Uint8Array(32)), ALICE, 2);
        await expect(ask(alice.identity, stranger)).rejects.toThrow(
            'This identity does not open on this account.',
        );
        await expect(ask(next, alice.identity)).rejects.toThrow(/upgraded identities/);
        // A link the old identity did not sign (a server's own), or naming other keys: no consent.
        await expect(
            ask(alice.identity, next, { ...link, signature: encode(new Uint8Array(3373)) }),
        ).rejects.toThrow('This link is not one this account made.');
        await expect(
            ask(alice.identity, next, { ...link, newKemPublicKey: bob.served.kemPublicKey }),
        ).rejects.toThrow('This link is not one this account made.');
    });
});

describe('trusting and forgetting', () => {
    test('trusting someone as the family does writes a pin carrying the family, only for an active member’s own keys', async () => {
        const f = await family();
        const { alice, bob, groupId } = f;
        const contact = { email: 'bob@example.com', name: 'Bob', pinnedAt: CHECKED };
        const { pin } = await alice.call('groupTrustAs', {
            groupId,
            userId: BOB,
            served: bob.served,
            contact,
        });
        const words = await pinOf(bob);
        expect(pin).toMatchObject({
            userId: BOB,
            trustedVia: groupId,
            signingPublicKey: bob.served.signingPublicKey,
            fingerprint: words.fingerprint,
        });
        const carol = await account(CAROL);
        await expect(
            alice.call('groupTrustAs', {
                groupId,
                userId: BOB,
                served: { ...carol.served },
                contact,
            }),
        ).rejects.toThrow(/not the keys on the group’s member list/);
    });

    test('forgetting a family drops its chain, its key and its folders’ keys', async () => {
        const f = await family();
        const { alice, groupId, ws } = f;
        await expect(alice.call('groupForget', { groupId })).resolves.toEqual({ forgotten: true });
        await expect(
            alice.call('driveOpenNodes', { workspaceId: ws, nodes: [f.rootListing] }),
        ).resolves.toMatchObject({ nodes: [{ error: expect.stringMatching(/Open Drive again/) }] });
        await expect(
            alice.call('groupStage', {
                groupId,
                expectedRevision: 2,
                op: { kind: 'area', name: 'X' },
                kems: {},
            }),
        ).rejects.toThrow(/Check the family’s member list first/);
        // Back from what the server serves, the key is still to be opened again.
        await f.sync(alice, f.marks.alice);
        await expect(
            alice.call('groupStage', {
                groupId,
                expectedRevision: 2,
                op: { kind: 'area', name: 'X' },
                kems: {},
            }),
        ).rejects.toThrow(/Open the family’s key first/);
    });
});

describe('the device store and the lock', () => {
    test('a sealed record opens only for its account, group and store', async () => {
        const f = await family();
        const { alice, bob, groupId } = f;
        const { envelope } = await alice.call('groupStoreSeal', {
            userId: ALICE,
            groupId,
            store: 'outbox',
            value: { id: 'x', body: { roster: 1 } },
        });
        await expect(
            alice.call('groupStoreOpen', { userId: ALICE, groupId, store: 'outbox', envelope }),
        ).resolves.toEqual({ value: { id: 'x', body: { roster: 1 } } });
        const otherGroup = f.created.body.area.workspaceId; // any other uuid
        await expect(
            alice.call('groupStoreOpen', {
                userId: ALICE,
                groupId: otherGroup,
                store: 'outbox',
                envelope,
            }),
        ).resolves.toEqual({ unreadable: true });
        // The joins store is the worker's alone now: the data layer neither opens nor seals it.
        await expect(
            alice.call('groupStoreOpen', {
                userId: ALICE,
                groupId,
                store: 'joins' as never,
                envelope,
            }),
        ).rejects.toThrow(/not a family record this device keeps/);
        await expect(
            bob.call('groupStoreOpen', { userId: BOB, groupId, store: 'outbox', envelope }),
        ).resolves.toEqual({ unreadable: true });
        // The chain record and the staged secrets are the worker's alone.
        await expect(
            alice.call('groupStoreOpen', {
                userId: ALICE,
                groupId,
                store: 'chains' as 'outbox',
                envelope: f.marks.alice.record!,
            }),
        ).rejects.toThrow(/not a family record this device keeps/);
        // And the chain record itself is bound to its group too.
        await expect(
            openDeviceRecord(alice.root, ALICE, otherGroup, 'chains', f.marks.alice.record!),
        ).rejects.toThrow(/could not be opened/);
    });

    test('a record sealed under another account root is reported unreadable, and nothing is accepted', async () => {
        const f = await family();
        const { alice, groupId, server } = f;
        // What a master-key rotation leaves on disk: a record under the previous root.
        const stale = await sealDeviceRecord(
            crypto.getRandomValues(new Uint8Array(32)),
            ALICE,
            groupId,
            'chains',
            { v: 1, cache: null, pin: null },
        );
        await loadSettings(alice);
        const served = server.served();
        const ask = (record: string) =>
            alice.call('groupAccept', {
                userId: ALICE,
                groupId,
                served,
                record,
                checkedAt: CHECKED,
            });
        await expect(ask(stale)).resolves.toEqual({ status: 'record-unreadable' });
        // The record of another group is no better.
        const other = await sealDeviceRecord(alice.root, ALICE, f.ws, 'chains', { v: 1 });
        await expect(ask(other)).resolves.toEqual({ status: 'record-unreadable' });
        // Without it, against the settings pin alone, the family is accepted again.
        await expect(
            alice.call('groupAccept', {
                userId: ALICE,
                groupId,
                served,
                record: null,
                checkedAt: CHECKED,
            }),
        ).resolves.toMatchObject({ status: 'accepted' });
    });

    test('a record whose cache is refused is accepted without it, and its pin still refuses an older list', async () => {
        const f = await family();
        const { alice, groupId, server } = f;
        const opened = (await openDeviceRecord(
            alice.root,
            ALICE,
            groupId,
            'chains',
            f.marks.alice.record!,
        )) as { v: 1; cache: GroupChainCache; pin: GroupPin };
        expect(opened.pin.rosterVersion).toBe(2);
        // A cache a newer release wrote: refused here over any list served.
        const newer = await sealDeviceRecord(alice.root, ALICE, groupId, 'chains', {
            ...opened,
            cache: { ...opened.cache, cacheVersion: 3 },
        });
        const served = server.served();
        // A reload: no chain held in the session to mark the family.
        const device = await alice.device();
        const ask = (chain: typeof served, extra: Partial<CryptoRequests['groupAccept']> = {}) =>
            device.call('groupAccept', {
                userId: ALICE,
                groupId,
                served: chain,
                record: newer,
                checkedAt: CHECKED,
                ...extra,
            });
        // The server cuts the list before Bob's admission and serves settings with no pin.
        alice.settings.groups = {};
        await saveSettings(device);
        await loadSettings(device);
        const cut = { ...served, rosters: served.rosters.slice(0, 1) };
        await expect(ask(cut)).rejects.toThrow('Invalid member list cache.');
        await expect(ask(cut, { withoutCache: true })).rejects.toThrow(
            'This is an older member list than this device has seen.',
        );
        // The whole list: taken without the cache, at the version the record's pin holds.
        await expect(ask(served, { withoutCache: true })).resolves.toMatchObject({
            status: 'accepted',
            view: { rosterVersion: 2 },
        });
    });

    test('a staged roster another tab landed is dropped once acceptance takes it, and junk under it drops nothing', async () => {
        const f = await family();
        const { alice, groupId, server, marks, sync } = f;
        const stage = (name: string) =>
            alice.call('groupStage', {
                groupId,
                expectedRevision: 2,
                op: { kind: 'area', name },
                kems: { [BOB]: f.bob.served.kemPublicKey },
            });
        const landed = await stage('Landed');
        if (landed.outboxId === null) throw new Error('nothing staged');
        // The server serves the staged statement under signatures nobody made: refused, still staged.
        const forged = {
            ...landed.body.roster,
            signature: { ...landed.body.roster.signature, mlDsa: encode(new Uint8Array(3309)) },
        };
        await expect(
            alice.call('groupAccept', {
                userId: ALICE,
                groupId,
                served: { ...server.served(), rosters: [...server.served().rosters, forged] },
                record: marks.alice.record,
                checkedAt: CHECKED,
            }),
        ).rejects.toThrow();
        // Another tab sent the real bytes, and the server stored them: accepted, and named dropped.
        server.store(landed.body);
        await expect(sync(alice, marks.alice)).resolves.toMatchObject({
            status: 'accepted',
            view: { rosterVersion: 3 },
            dropped: [landed.outboxId],
        });
        await expect(alice.call('groupDrop', { outboxId: landed.outboxId })).resolves.toEqual({
            dropped: false,
        });
    });

    test('a password change or a restore while unlocked keeps family state, as it keeps personal keys', async () => {
        const f = await family();
        const { alice, groupId, ws } = f;
        const writeAtRoot = (id: string) =>
            alice.call('driveCreateNodes', {
                workspaceId: ws,
                nodes: [
                    {
                        id,
                        kind: 'folder',
                        parentId: f.area.root.id,
                        parentKeyEpoch: 1,
                        keyEpoch: 9,
                        metadata: folder('After'),
                    },
                ],
            });
        // A restore of the same account while unlocked keeps the Drive keys, and the family's too.
        await alice.restore();
        await expect(writeAtRoot(CHILD)).resolves.toBeTruthy();
        await expect(
            alice.call('groupStage', {
                groupId,
                expectedRevision: 2,
                op: { kind: 'area', name: 'Photos' },
                kems: { [BOB]: f.bob.served.kemPublicKey },
            }),
        ).resolves.toMatchObject({ body: { roster: expect.anything() } });
        // Starting a password change closes the root, never the open Drive keys or the family's.
        await alice.call('securityStart', {
            password: 'correct horse battery staple',
            newPassword: 'another correct horse battery',
            action: 'password',
        });
        await expect(writeAtRoot(LATER)).resolves.toBeTruthy();
        await expect(
            alice.call('groupJoinCode', { groupId, userId: BOB, rosters: f.server.rosters }),
        ).resolves.toEqual({ rosterVersion: 2, code: f.admit.joinCode!.code, pinMatches: true });
    });

    test('a lock forgets the chains, seeds, staged secrets and area keys', async () => {
        const f = await family();
        const { alice, groupId, ws, area } = f;
        const staged = await alice.call('groupStage', {
            groupId,
            expectedRevision: 2,
            op: { kind: 'area', name: 'Photos' },
            kems: { [BOB]: f.bob.served.kemPublicKey },
        });
        if (staged.outboxId === null) throw new Error('nothing staged');
        alice.session.reset();
        await alice.restore();
        await alice.call('identityOpen', { userId: ALICE, identity: alice.identity });
        await expect(
            alice.call('groupStage', {
                groupId,
                expectedRevision: 2,
                op: { kind: 'area', name: 'X' },
                kems: {},
            }),
        ).rejects.toThrow(/Check the family’s member list first/);
        await f.sync(alice, f.marks.alice);
        await expect(
            alice.call('groupStage', {
                groupId,
                expectedRevision: 2,
                op: { kind: 'area', name: 'X' },
                kems: {},
            }),
        ).rejects.toThrow(/Open the family’s key first/);
        await expect(alice.call('groupDrop', { outboxId: staged.outboxId })).resolves.toEqual({
            dropped: false,
        });
        await expect(
            alice.call('driveOpenNodes', { workspaceId: ws, nodes: [f.rootListing] }),
        ).resolves.toMatchObject({ nodes: [{ error: expect.stringMatching(/Open Drive again/) }] });
        // The staged secrets survive only sealed in the outbox entry, for a restage.
        await alice.call('groupOpenSeal', {
            groupId,
            seal: {
                groupKeyVersion: 1,
                holderKeyVersion: 1,
                sealerUserId: ALICE,
                rosterVersion: 1,
                rosterDigest: await rosterDigest(decode(f.server.rosters[0]!.statement)),
                envelope: f.created.body.keySeal.envelope,
            },
            sealerMlDsaPublicKey: alice.served.mlDsaPublicKey,
        });
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 1,
            grant: null,
            selfGrant: area.selfGrant,
        });
        await expect(
            alice.call('groupRestage', {
                groupId,
                stagedEnvelope: staged.stagedEnvelope,
                body: staged.body,
            }),
        ).resolves.toMatchObject({ outboxId: staged.outboxId });
    });
});

describe('copying in a family folder (1c step 7)', () => {
    const FILE = 'f1f1f1f1-0000-4000-8000-000000000011';
    const COPY = 'f2f2f2f2-0000-4000-8000-000000000012';
    const VERSION = 'f3f3f3f3-0000-4000-8000-000000000013';
    const OBJECT = 'f4f4f4f4-0000-4000-8000-000000000014';
    const COPY_VERSION = 'f5f5f5f5-0000-4000-8000-000000000015';

    /* Bob's file under the family folder's top folder, opened on Alice's device too. */
    async function bobsFile(f: Family) {
        await f.bob.call('driveOpenNodes', { workspaceId: f.ws, nodes: [f.rootListing] });
        const made = await f.bob.call('driveCreateNodes', {
            workspaceId: f.ws,
            nodes: [
                {
                    id: FILE,
                    kind: 'file',
                    parentId: f.area.root.id,
                    parentKeyEpoch: 1,
                    keyEpoch: 3,
                    metadata: { name: 'notes.txt', mime: 'text/plain', size: 100, modified: null },
                },
            ],
        });
        const node = made.nodes[0]!;
        const prepared = await f.bob.call('driveUploadPrepare', {
            workspaceId: f.ws,
            nodeId: FILE,
            versionId: VERSION,
            objectId: OBJECT,
            plaintextSize: 100,
        });
        await f.alice.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [
                f.rootListing,
                {
                    id: FILE,
                    parentId: f.area.root.id,
                    parentKeyEpoch: 1,
                    keyEpoch: 3,
                    keyEnvelope: node.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: node.metadataEnvelope,
                },
            ],
        });
        return {
            nodeId: FILE,
            id: VERSION,
            objectId: OBJECT,
            contentKeyEnvelope: prepared.contentKeyEnvelope,
            contentSuite: CONTENT_SUITE,
            plaintextSize: null,
            metadataVersion: 1,
            metadataEnvelope: node.metadataEnvelope,
            metadataSigner: BOB,
            metadataSignature: node.metadataSignature,
            signer: BOB,
            signature: prepared.versionSignature,
            // Not a copy's field: what a walk of the file re-keys under.
            fileKeyEnvelope: node.keyEnvelope,
        };
    }
    const copyCtx = (ws: string) => ({
        workspaceId: ws,
        nodeId: COPY,
        kind: 'file' as const,
        metadataVersion: 1,
    });

    test('design 2.10 (F14): a copy goes into no folder whose key is not rooted at the folder’s current key', async () => {
        const f = await family();
        const source = await bobsFile(f);
        const r = await rotated(f);
        const { alice, bob, groupId, ws, area } = f;
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: r.rotation.selfGrant,
        });
        await alice.call('driveOpenNodes', { workspaceId: ws, nodes: [r.rotatedRoot()] });
        const copy = (parentId: string, parentKeyEpoch: number) =>
            alice.call('driveCopyFile', {
                workspaceId: ws,
                signers: {},
                source,
                node: {
                    id: COPY,
                    parentId,
                    parentKeyEpoch,
                    keyEpoch: 8,
                    metadata: folder('notes (copy).txt'),
                },
                versionId: COPY_VERSION,
                group: {
                    groupId,
                    staged: null,
                    writers: [
                        {
                            userId: BOB,
                            pinned: null,
                            served: bob.served,
                            links: [],
                            personal: null,
                        },
                    ],
                },
            });
        // CHILD's key is cached under the replaced root: no copy goes under it.
        await expect(copy(CHILD, 1)).rejects.toThrow(KEY_CHANGE_PENDING);
        // Under the rotated root, it does.
        await expect(copy(area.root.id, 5)).resolves.toMatchObject({
            keyEnvelope: expect.any(String),
        });
    });

    test('a copy is judged by the family: a member’s file is vouched for, a former member’s only re-sealed', async () => {
        const f = await family();
        const { alice, bob, groupId, ws, area, server, marks } = f;
        const source = await bobsFile(f);
        const bobWriter: GroupWriter = {
            userId: BOB,
            pinned: null,
            served: bob.served,
            links: [],
            personal: null,
        };
        const copy = (
            group: CryptoRequests['driveCopyFile']['group'],
            parent = { id: area.root.id, parentKeyEpoch: 1 },
        ) =>
            alice.call('driveCopyFile', {
                workspaceId: ws,
                signers: {},
                source,
                node: {
                    id: COPY,
                    parentId: parent.id,
                    parentKeyEpoch: parent.parentKeyEpoch,
                    keyEpoch: 4,
                    metadata: folder('notes (copy).txt'),
                },
                versionId: COPY_VERSION,
                group,
            });
        // Never personally, never on a staged member list, never by another group.
        await expect(copy(null)).rejects.toThrow(/only with the family’s trust/);
        await expect(copy({ groupId, staged: 'some-outbox-id', writers: [] })).rejects.toThrow(
            /as it stands/,
        );
        await expect(
            copy({ groupId: crypto.randomUUID(), staged: null, writers: [] }),
        ).rejects.toThrow(/not one of this family’s/);
        // A re-keyed source served without its key epoch: its columns are the walker's, never judged.
        await expect(
            alice.call('driveCopyFile', {
                workspaceId: ws,
                signers: {},
                source: {
                    ...source,
                    keyEpoch: undefined,
                    rekey: {
                        origin: {
                            envelope: source.contentKeyEnvelope,
                            signerId: BOB,
                            signature: source.signature!,
                            keyEnvelope: source.contentKeyEnvelope,
                        },
                        signature: source.signature!,
                    },
                },
                node: {
                    id: COPY,
                    parentId: area.root.id,
                    parentKeyEpoch: 1,
                    keyEpoch: 4,
                    metadata: folder('notes (copy).txt'),
                },
                versionId: COPY_VERSION,
                group: { groupId, staged: null, writers: [bobWriter] },
            }),
        ).rejects.toThrow(/couldn’t check who wrote this/);
        // Alice never compared Bob's words: the family's member list vouches, so the copy is hers.
        const aliceKey = decode(alice.served.signingPublicKey, 32);
        const vouched = await copy({ groupId, staged: null, writers: [bobWriter] });
        const envelope = decode(vouched.metadataEnvelope);
        expect(
            await verifyStatement(
                await metadataStatement(copyCtx(ws), envelope),
                decode(vouched.metadataSignature),
                aliceKey,
            ),
        ).toBe(true);

        // Bob is removed. The same file copied now is a former member's: re-sealed, not hers.
        const removal = await alice.call('groupStage', {
            groupId,
            expectedRevision: 2,
            op: {
                kind: 'remove',
                userId: BOB,
                rotations: [
                    { workspaceId: ws, targetEpoch: 7, root: f.rootInput(), documents: [] },
                ],
            },
            kems: {},
            writers: [bobWriter],
        });
        if (removal.outboxId === null) throw new Error('nothing staged');
        const [rotation] = removal.body.rotations!;
        server.store(removal.body);
        await alice.call('groupDrop', { outboxId: removal.outboxId });
        await f.sync(alice, marks.alice);
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: rotation!.selfGrant,
        });
        await alice.call('driveOpenNodes', {
            workspaceId: ws,
            nodes: [
                {
                    id: area.root.id,
                    parentId: ws,
                    parentKeyEpoch: 2,
                    keyEpoch: 7,
                    keyEnvelope: rotation!.root.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: rotation!.root.rotated!.metadataEnvelope,
                    prevKeyEnvelope: rotation!.previousRootKeyEnvelope,
                    prevKeyEpoch: 1,
                    prevParentKeyEpoch: 2,
                },
            ],
        });
        const resealed = await copy(
            { groupId, staged: null, writers: [bobWriter] },
            { id: area.root.id, parentKeyEpoch: 7 },
        );
        const after = decode(resealed.metadataEnvelope);
        expect(
            await verifyStatement(
                await metadataStatement(copyCtx(ws), after),
                decode(resealed.metadataSignature),
                aliceKey,
            ),
        ).toBe(false);
        expect(
            await verifyStatement(
                await metadataResealedStatement(copyCtx(ws), after),
                decode(resealed.metadataSignature),
                aliceKey,
            ),
        ).toBe(true);
    });

    test('a copy of a file a rotation re-keyed is judged on its writer’s record: vouched for, not re-sealed', async () => {
        const f = await family();
        const { alice, bob, groupId, ws, area } = f;
        const source = await bobsFile(f);
        const bobWriter: GroupWriter = {
            userId: BOB,
            pinned: null,
            served: bob.served,
            links: [],
            personal: null,
        };
        const group = { groupId, staged: null, writers: [bobWriter] };
        // Alice's walk re-keys Bob's file: it stays his (an origin), her name only on the binding.
        const fileRow = (
            await alice.call('driveRotateNodes', {
                workspaceId: ws,
                targetEpoch: 9,
                granterUserId: ALICE,
                signers: {},
                group,
                nodes: [
                    {
                        id: FILE,
                        kind: 'file',
                        parentId: area.root.id,
                        parentKeyEpoch: 1,
                        keyEpoch: 3,
                        wrappedParentKeyEpoch: 1,
                        keyEnvelope: source.fileKeyEnvelope,
                        metadataVersion: 1,
                        metadataEnvelope: source.metadataEnvelope,
                        metadataSigner: BOB,
                        metadataSignature: source.metadataSignature,
                        versions: [
                            {
                                id: VERSION,
                                objectId: OBJECT,
                                contentKeyEnvelope: source.contentKeyEnvelope,
                                contentSuite: CONTENT_SUITE,
                                plaintextSize: null,
                                signer: BOB,
                                signature: source.signature,
                            },
                        ],
                        shares: [],
                        links: [],
                    },
                ],
            })
        ).nodes[0]!;
        if (fileRow.error !== undefined) throw new Error(fileRow.error);
        await alice.call('driveRotateCommit', { workspaceId: ws, nodeIds: [FILE] });
        const version = fileRow.versions[0]!;
        // The file as the server then serves it: Alice's columns, Bob's origins, no legacy signature.
        const rekeyedSource = {
            ...source,
            metadataEnvelope: fileRow.metadataEnvelope,
            metadataSigner: ALICE,
            metadataSignature: null,
            contentKeyEnvelope: version.contentKeyEnvelope,
            signer: ALICE,
            signature: null,
            keyEpoch: 9,
            metadataRekey: {
                origin: {
                    envelope: source.metadataEnvelope,
                    signerId: BOB,
                    signature: source.metadataSignature,
                    keyEnvelope: fileRow.metadataRekey!.originKeyEnvelope,
                },
                signature: fileRow.metadataRekey!.signature,
            },
            rekey: {
                origin: {
                    envelope: source.contentKeyEnvelope,
                    signerId: BOB,
                    signature: source.signature,
                    keyEnvelope: version.rekey!.originKeyEnvelope,
                },
                signature: version.rekey!.signature,
            },
        };
        const copy = (from: typeof rekeyedSource | typeof source) =>
            alice.call('driveCopyFile', {
                workspaceId: ws,
                signers: {},
                source: from as typeof rekeyedSource,
                node: {
                    id: COPY,
                    parentId: area.root.id,
                    parentKeyEpoch: 1,
                    keyEpoch: 4,
                    metadata: folder('notes (copy).txt'),
                },
                versionId: COPY_VERSION,
                group,
            });
        const aliceKey = decode(alice.served.signingPublicKey, 32);
        const formOf = async (copied: Awaited<ReturnType<typeof copy>>) => {
            const envelope = decode(copied.metadataEnvelope);
            const signature = decode(copied.metadataSignature);
            if (
                await verifyStatement(
                    await metadataStatement(copyCtx(ws), envelope),
                    signature,
                    aliceKey,
                )
            )
                return 'ordinary';
            if (
                await verifyStatement(
                    await metadataResealedStatement(copyCtx(ws), envelope),
                    signature,
                    aliceKey,
                )
            )
                return 'resealed';
            return 'neither';
        };
        // Bob's record, which the family vouches for: the copy is vouched for too, as before the walk.
        expect(await formOf(await copy(rekeyedSource))).toBe('ordinary');
        // Judged on the re-keyer's columns alone (no signature there), it would only be re-sealed.
        const { metadataRekey: _m, rekey: _v, ...columnsOnly } = rekeyedSource;
        expect(await formOf(await copy(columnsOnly as typeof rekeyedSource))).toBe('resealed');
        // An origin that does not bind is never vouched for: the version's wrap in the metadata's
        // place (the re-key signature no longer covers it), or an epoch whose key is not held.
        const swapped = {
            ...rekeyedSource,
            metadataRekey: {
                ...rekeyedSource.metadataRekey,
                origin: {
                    ...rekeyedSource.metadataRekey.origin,
                    keyEnvelope: rekeyedSource.rekey.origin.keyEnvelope,
                },
            },
        };
        expect(await formOf(await copy(swapped))).toBe('resealed');
        expect(await formOf(await copy({ ...rekeyedSource, keyEpoch: 8 }))).toBe('resealed');
    });

    test('a group’s trust on a personal workspace is refused', async () => {
        const f = await family();
        await expect(
            f.alice.call('driveCopyFile', {
                workspaceId: OTHER_WS,
                signers: {},
                source: {
                    nodeId: CHILD,
                    id: LATER,
                    objectId: LATER,
                    contentKeyEnvelope: 'AAAA',
                    contentSuite: CONTENT_SUITE,
                    plaintextSize: null,
                    metadataVersion: 1,
                    metadataEnvelope: 'AAAA',
                    metadataSigner: null,
                    metadataSignature: null,
                    signer: null,
                    signature: null,
                },
                node: {
                    id: COPY,
                    parentId: CHILD,
                    parentKeyEpoch: 1,
                    keyEpoch: 2,
                    metadata: folder('x'),
                },
                versionId: COPY_VERSION,
                group: { groupId: f.groupId, staged: null, writers: [] },
            }),
        ).rejects.toThrow();
    });
});

describe('repairing a family folder’s previous key (route 28)', () => {
    test('a previous envelope that does not open is repaired by a member who held the old key, and then opens the unrotated part', async () => {
        const f = await family();
        // Bob lists the folder before the key change: his device holds the top folder's key.
        await f.bob.call('driveOpenNodes', { workspaceId: f.ws, nodes: [f.rootListing] });
        const r = await rotated(f);
        const junk = encode(crypto.getRandomValues(new Uint8Array(72)));
        const served = { ...r.rotatedRoot(), prevKeyEnvelope: junk };
        const check = (
            device: Device,
            root: {
                id: string;
                parentKeyEpoch: number;
                prevKeyEnvelope?: string;
                prevKeyEpoch?: number;
                prevParentKeyEpoch?: number;
            },
        ) =>
            device.call('groupPreviousRoot', {
                groupId: f.groupId,
                workspaceId: f.ws,
                root: {
                    id: root.id,
                    parentKeyEpoch: root.parentKeyEpoch,
                    prevKeyEnvelope: root.prevKeyEnvelope ?? null,
                    prevKeyEpoch: root.prevKeyEpoch ?? null,
                    prevParentKeyEpoch: root.prevParentKeyEpoch ?? null,
                },
            });
        const openV2 = async (device: Device) =>
            device.call('groupOpenArea', {
                groupId: f.groupId,
                workspaceId: f.ws,
                idSeed: f.area.idSeed,
                servedVersion: 2,
                grant: r.grantTo(BOB),
                granterMlDsaPublicKey: f.alice.served.mlDsaPublicKey,
                selfGrant: null,
            });
        await openV2(f.bob);
        // The served previous envelope is junk: the unrotated folder does not open through it...
        const listed = await f.bob.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [served],
        });
        expect(listed.nodes[0]!.metadata?.name).toBe('Family');
        const repair = await check(f.bob, served);
        if (repair.status !== 'repair') throw new Error(repair.status);

        // A fresh device holding only the new area key cannot repair, and reads nothing unrotated.
        const fresh = await f.bob.device();
        await f.sync(fresh, f.marks.bob);
        await openV2(fresh);
        expect(await check(fresh, served)).toEqual({ status: 'cannot' });
        const before = await fresh.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [served, r.childListing],
        });
        expect(before.nodes[1]!.error).toMatch(/older folder key/);
        // With the repaired envelope served, it opens the unrotated child.
        const repaired = { ...served, prevKeyEnvelope: repair.previousRootKeyEnvelope };
        expect(await check(fresh, repaired)).toEqual({ status: 'opens' });
        const after = await fresh.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [repaired, r.childListing],
        });
        expect(after.nodes.map((node) => node.metadata?.name)).toEqual(['Family', 'Inside']);
        // The rotation's own envelope opens as it is, and nothing is offered in its place.
        expect(await check(fresh, r.rotatedRoot())).toEqual({ status: 'opens' });
        // A root with no previous envelope under the current key has nothing to check.
        expect(await check(fresh, { ...served, prevParentKeyEpoch: 1 })).toEqual({
            status: 'none',
        });
    });
    test('a previous envelope that opens to another key loses to the key this device held, and is repaired', async () => {
        const f = await family();
        await f.bob.call('driveOpenNodes', { workspaceId: f.ws, nodes: [f.rootListing] });
        const r = await rotated(f);
        // A hostile manager's envelope: it opens under the new folder key, to a key nobody held.
        const areaKey = await openAreaSelfGrant(
            f.alice.root,
            ALICE,
            f.groupId,
            r.staged.body.rotation!.selfGrant,
        );
        const wrong = encode(
            await wrapPreviousRootKey(crypto.getRandomValues(new Uint8Array(32)), areaKey, {
                workspaceId: f.ws,
                nodeId: f.area.root.id,
                parentId: f.ws,
                parentKeyEpoch: 2,
                keyEpoch: 1,
            }),
        );
        const served = { ...r.rotatedRoot(), prevKeyEnvelope: wrong };
        const check = (device: Device, prevKeyEnvelope: string) =>
            device.call('groupPreviousRoot', {
                groupId: f.groupId,
                workspaceId: f.ws,
                root: {
                    id: f.area.root.id,
                    parentKeyEpoch: 2,
                    prevKeyEnvelope,
                    prevKeyEpoch: 1,
                    prevParentKeyEpoch: 2,
                },
            });
        const openV2 = (device: Device) =>
            device.call('groupOpenArea', {
                groupId: f.groupId,
                workspaceId: f.ws,
                idSeed: f.area.idSeed,
                servedVersion: 2,
                grant: r.grantTo(BOB),
                granterMlDsaPublicKey: f.alice.served.mlDsaPublicKey,
                selfGrant: null,
            });
        await openV2(f.bob);
        // Bob's device keeps the old key it opened itself: the unrotated child still opens.
        const listed = await f.bob.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [served, r.childListing],
        });
        expect(listed.nodes.map((node) => node.metadata?.name)).toEqual(['Family', 'Inside']);
        // And says the served envelope is wrong, with one that opens to the key it held.
        const repair = await check(f.bob, wrong);
        if (repair.status !== 'repair') throw new Error(repair.status);
        // Served the right envelope afterwards, then the wrong one again: the kept key still wins.
        await f.bob.call('driveOpenNodes', { workspaceId: f.ws, nodes: [r.rotatedRoot()] });
        const again = await f.bob.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [served, r.childListing],
        });
        expect(again.nodes[1]!.metadata?.name).toBe('Inside');
        // A fresh device can't tell the wrong envelope from a good one, and reads nothing unrotated
        // through it; with the repair it reads the child.
        const fresh = await f.bob.device();
        await f.sync(fresh, f.marks.bob);
        await openV2(fresh);
        expect(await check(fresh, wrong)).toEqual({ status: 'opens' });
        const before = await fresh.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [served, r.childListing],
        });
        expect(before.nodes[1]!.error).toBeDefined();
        const after = await fresh.call('driveOpenNodes', {
            workspaceId: f.ws,
            nodes: [{ ...served, prevKeyEnvelope: repair.previousRootKeyEnvelope }, r.childListing],
        });
        expect(after.nodes[1]!.metadata?.name).toBe('Inside');
    });

    test('only a key this device opened as the root’s own repairs: one a served envelope gave it never does', async () => {
        const f = await family();
        const r = await rotated(f);
        // Bob never listed the root before the key change: his previous key comes from the served
        // envelope only. A later junk envelope finds nothing of his own to repair it with.
        await f.bob.call('groupOpenArea', {
            groupId: f.groupId,
            workspaceId: f.ws,
            idSeed: f.area.idSeed,
            servedVersion: 2,
            grant: r.grantTo(BOB),
            granterMlDsaPublicKey: f.alice.served.mlDsaPublicKey,
            selfGrant: null,
        });
        await f.bob.call('driveOpenNodes', { workspaceId: f.ws, nodes: [r.rotatedRoot()] });
        const junk = encode(crypto.getRandomValues(new Uint8Array(72)));
        expect(
            await f.bob.call('groupPreviousRoot', {
                groupId: f.groupId,
                workspaceId: f.ws,
                root: {
                    id: f.area.root.id,
                    parentKeyEpoch: 2,
                    prevKeyEnvelope: junk,
                    prevKeyEpoch: 1,
                    prevParentKeyEpoch: 2,
                },
            }),
        ).toEqual({ status: 'cannot' });
    });
});

/*
 * A family's committed member list naming a folder that isn't its own: another family's folder
 * opened here, or the account's own workspace. The ledger ignores the listing (area-ledger.ts);
 * groupForeignListings only says so, for the family that lists it, and never for the family whose
 * folder it is, which would tell the wrong family its member list is suspect.
 */
describe('folders a member list names that are not its family’s own (groupForeignListings)', () => {
    async function sessionWithLedger() {
        const catalog = await chains();
        const ledger = createAreaLedger();
        // The operation reads only the ledger; nothing else of the host is reached.
        const session = createGroupSession({ ledger } as unknown as GroupHost);
        const listed = async (groupId: string) =>
            (await session.handle({
                id: 1,
                operation: 'groupForeignListings',
                input: { groupId },
            } as GroupMessage)) as GroupResults['groupForeignListings'];
        // GROUP's own folder AREA, committed, opened and its top folder listed: writable here.
        ledger.commit(catalog.get('f2-v1')!);
        await ledger.openArea(GROUP, AREA, AREA_SEED, 1, areaKeyAt(AREA, 1).slice(), 1);
        const root = '0e0e0e0e-0000-4000-8000-000000000001';
        const at = {
            workspaceId: AREA,
            nodeId: root,
            parentId: AREA,
            parentKeyEpoch: 1,
            keyEpoch: 1,
        };
        await ledger.openListedNode(AREA, {
            id: root,
            parentId: AREA,
            parentKeyEpoch: 1,
            keyEpoch: 1,
            keyEnvelope: encode(await wrapNodeKey(rootKeyAt(AREA, 1), areaKeyAt(AREA, 1), at)),
            prevKeyEnvelope: null,
            prevKeyEpoch: null,
            prevParentKeyEpoch: null,
        });
        return { catalog, ledger, listed };
    }
    /* What a ledger call answers, or why it refused: compared before and after the listing. */
    const attempt = (read: () => unknown) => {
        try {
            return read() ?? 'ok';
        } catch (error) {
            return error instanceof Error ? error.message : 'refused';
        }
    };
    const stateOf = (ledger: ReturnType<typeof createAreaLedger>, workspaceId: string) => ({
        read: attempt(() => ledger.readVersion(workspaceId)),
        write: attempt(() => ledger.writeVersion(workspaceId)),
        writable: attempt(() => ledger.requireWritable(workspaceId)),
    });

    test('another family’s folder is said for the family that lists it, with its owner, never for the owner, and moves nothing of it', async () => {
        const { catalog, ledger, listed } = await sessionWithLedger();
        const before = stateOf(ledger, AREA);
        expect(before).toEqual({ read: 1, write: 1, writable: 'ok' });
        // OTHER_GROUP's member list also names AREA, as a manager of that family could sign it.
        ledger.commit(catalog.get('other-f2-v1')!);
        expect(await listed(OTHER_GROUP)).toEqual({
            listings: [{ workspaceId: AREA, openedBy: GROUP }],
        });
        expect(await listed(GROUP)).toEqual({ listings: [] });
        // Never a lock: GROUP's folder reads and writes as it did.
        expect(stateOf(ledger, AREA)).toEqual(before);
        // A family nobody committed here lists nothing.
        expect(await listed(crypto.randomUUID())).toEqual({ listings: [] });
    });

    test('the account’s own workspace is said with no owner, for the listing family only, and stays the account’s', async () => {
        const { catalog, ledger, listed } = await sessionWithLedger();
        ledger.openPersonalWorkspace(PERSONAL, 1, pattern(32, 209));
        const before = { personal: stateOf(ledger, PERSONAL), area: stateOf(ledger, AREA) };
        expect(before.personal.writable).toBe('ok');
        ledger.commit(catalog.get('other-lists-personal')!);
        expect(await listed(OTHER_GROUP)).toEqual({
            listings: [{ workspaceId: PERSONAL, openedBy: null }],
        });
        expect(await listed(GROUP)).toEqual({ listings: [] });
        expect(ledger.isArea(PERSONAL)).toBe(false);
        expect({ personal: stateOf(ledger, PERSONAL), area: stateOf(ledger, AREA) }).toEqual(
            before,
        );
    });

    test('forgetting the family whose folder it is takes the listing away with it', async () => {
        const { catalog, ledger, listed } = await sessionWithLedger();
        ledger.commit(catalog.get('other-f2-v1')!);
        expect((await listed(OTHER_GROUP)).listings).toHaveLength(1);
        ledger.forgetGroup(GROUP);
        expect(await listed(OTHER_GROUP)).toEqual({ listings: [] });
    });

    test('a folder whose family has not opened it here is not known as anyone’s, so nothing is said (the known gap)', async () => {
        // Both member lists committed, but GROUP never opened AREA on this device (its sync
        // failed, or has not run): nothing says whose AREA is, so OTHER_GROUP's listing goes unsaid.
        const catalog = await chains();
        const ledger = createAreaLedger();
        const session = createGroupSession({ ledger } as unknown as GroupHost);
        ledger.commit(catalog.get('f2-v1')!);
        ledger.commit(catalog.get('other-f2-v1')!);
        expect(
            await session.handle({
                id: 1,
                operation: 'groupForeignListings',
                input: { groupId: OTHER_GROUP },
            } as GroupMessage),
        ).toEqual({ listings: [] });
    });
});

describe('joining on first use (docs/optional-verification.md 3.2, 3.3, 2.8)', () => {
    /* Alice checks Carol's words and lets her in at roster 3 (Bob joined at 2). */
    async function withCarol() {
        const f = await family();
        const carol = await account(CAROL);
        await checkWords(f.alice, carol);
        const staged = await f.alice.call('groupStage', {
            groupId: f.groupId,
            expectedRevision: 2,
            op: { kind: 'admit', userId: CAROL, served: carol.served, roles: [] },
            kems: { [BOB]: f.bob.served.kemPublicKey, [CAROL]: carol.served.kemPublicKey },
        });
        if (staged.outboxId === null) throw new Error('nothing staged');
        await f.alice.call('groupDrop', { outboxId: staged.outboxId });
        f.server.store(staged.body);
        await f.sync(f.alice, f.marks.alice);
        return { ...f, carol };
    }
    const firstUse = (
        who: Device,
        groupId: string,
        served: ServedChain,
        guard: GroupPin | 'unreadable' | null = null,
    ) =>
        who.call('groupJoinFirstUse', {
            userId: who.userId,
            groupId,
            served,
            record: null,
            guard,
            now: CHECKED,
        });
    const joinWith = (
        who: Device,
        groupId: string,
        served: ServedChain,
        joinsRecord: string,
        guard: GroupPin | 'unreadable' | null = null,
    ) =>
        who.call('groupAccept', {
            userId: who.userId,
            groupId,
            served,
            record: null,
            checkedAt: CHECKED,
            joining: { joinsRecord },
            guard,
        });

    test('the guard follows each acceptance with the folders opened here, and never goes back', async () => {
        const f = await family();
        const { alice, groupId, ws, area, server } = f;
        const sync = (guard: GroupPin | null, served = server.served()) =>
            alice.call('groupAccept', {
                userId: ALICE,
                groupId,
                served,
                record: f.marks.alice.record,
                checkedAt: CHECKED,
                guard,
            });
        // None held: the accepted pin, with the folder this device opened at version 1.
        const first = await sync(null);
        if (first.status !== 'accepted') throw new Error(first.status);
        expect(first.guard).toMatchObject({ rosterVersion: 2, keyVersion: 1, areas: { [ws]: 1 } });
        // Nothing new: nothing to write.
        await expect(sync(first.guard)).resolves.toMatchObject({ guard: null });
        // The rotation's roster moves it on; the folder's floor rises once it is opened at 2.
        const r = await rotated(f);
        const moved = await sync(first.guard);
        if (moved.status !== 'accepted') throw new Error(moved.status);
        expect(moved.guard).toMatchObject({ rosterVersion: 3, areas: { [ws]: 1 } });
        await alice.call('groupOpenArea', {
            groupId,
            workspaceId: ws,
            idSeed: area.idSeed,
            servedVersion: 2,
            grant: null,
            selfGrant: r.rotation.selfGrant,
        });
        const raised = await sync(moved.guard);
        if (raised.status !== 'accepted') throw new Error(raised.status);
        expect(raised.guard).toMatchObject({ rosterVersion: 3, areas: { [ws]: 2 } });
        // A chain short of it is refused, never a lower guard.
        const short = { ...server.served(), rosters: server.served().rosters.slice(0, 2) };
        await expect(
            alice.call('groupAccept', {
                userId: ALICE,
                groupId,
                served: short,
                record: null,
                checkedAt: CHECKED,
                guard: raised.guard,
            }),
        ).rejects.toThrow();
    });

    test('a family check that lands between the first use and its acceptance is a mark: the record then vouches for nothing', async () => {
        const { carol, groupId, server } = await withCarol();
        const shown = await firstUse(carol, groupId, server.served());
        if (shown.status !== 'first-use') throw new Error(shown.status);
        // Another of Carol's devices saved settings with a family check (the migration's record,
        // with no code) and no pin of the family: no mark fixes the first keys, but one exists.
        const settingsVersion = carol.settings.version + 1;
        const { envelope } = await carol.call('settingsSeal', {
            userId: CAROL,
            settingsVersion,
            settings: {
                version: 2,
                contacts: {},
                groups: {},
                familyChecks: { [groupId]: { how: 'before', rosterVersion: 3 } as never },
            },
        });
        Object.assign(carol.settings, { version: settingsVersion, envelope });
        await loadSettings(carol);
        await expect(joinWith(carol, groupId, server.served(), shown.joinsRecord)).rejects.toThrow(
            /compare the join code first/,
        );
    });

    test('first use needs settings that opened, the join path, and the head to let this account in', async () => {
        const { carol, groupId, server } = await withCarol();
        // Never on a sync: with no mark, only a join's record vouches for anything.
        await expect(
            carol.call('groupAccept', {
                userId: CAROL,
                groupId,
                served: server.served(),
                record: null,
                checkedAt: CHECKED,
            }),
        ).rejects.toThrow(/compare the join code first/);
        // Not before settings open on this device.
        const bare = await bareDevice(carol);
        await expect(firstUse(bare, groupId, server.served())).rejects.toThrow(
            /Open your settings first/,
        );
        // Before the roster that lets her in, nothing to join.
        const before = { ...server.served(), rosters: server.served().rosters.slice(0, 2) };
        await expect(firstUse(carol, groupId, before)).resolves.toEqual({
            status: 'not-admitted',
        });
    });

    test('an admission still takes a words check: a first-seen pin of the newcomer lets nobody in yet', async () => {
        const f = await family();
        const carol = await account(CAROL);
        const pin = await pinOf(carol);
        f.alice.settings.contacts = {
            ...f.alice.settings.contacts,
            [CAROL]: { ...pin, fingerprint: '' },
        };
        await saveSettings(f.alice);
        await loadSettings(f.alice);
        await expect(
            f.alice.call('groupStage', {
                groupId: f.groupId,
                expectedRevision: 2,
                op: { kind: 'admit', userId: CAROL, served: carol.served, roles: [] },
                kems: { [BOB]: f.bob.served.kemPublicKey, [CAROL]: carol.served.kemPublicKey },
            }),
        ).rejects.toThrow(/not the keys whose words were checked/);
    });

    test('a family check over the committed chain: the pair code, and what a match writes', async () => {
        const f = await family();
        const rosters = f.server.served().rosters;
        const shown = await f.alice.call('groupPairCode', {
            groupId: f.groupId,
            userId: BOB,
            rosters,
        });
        if (shown.status !== 'code') throw new Error(shown.status);
        expect(shown.rosterVersion).toBe(2);
        // Bob's device works out the same words.
        expect(
            await f.bob.call('groupPairCode', { groupId: f.groupId, userId: ALICE, rosters }),
        ).toEqual(shown);
        const match = (code: string[], guard: null | 'unreadable' = null) =>
            f.alice.call('groupPairMatch', {
                groupId: f.groupId,
                userId: BOB,
                rosters,
                rosterVersion: shown.rosterVersion,
                code,
                guard,
                now: CHECKED,
            });
        // Alice checked Bob's words: her settings pin is his keys, so the pin is written again.
        const matched = await match(shown.code);
        expect(matched.check).toMatchObject({ rosterVersion: 2, with: BOB, code: shown.code });
        expect(matched.pin).toMatchObject({
            encryptionPublicKey: f.bob.served.encryptionPublicKey,
        });
        expect((await match(shown.code, 'unreadable')).pin).toBeNull();
        const wrong = [...shown.code];
        wrong[0] = wrong[0] === 'abandon' ? 'ability' : 'abandon';
        expect(await match(wrong)).toEqual({ check: null, pin: null });
        // A family with no committed chain on this device: nothing to check over.
        const fresh = await f.alice.device();
        await expect(
            fresh.call('groupPairCode', { groupId: f.groupId, userId: BOB, rosters }),
        ).rejects.toThrow(/Check the family’s member list first/);
    });
});

import { describe, expect, test } from 'vitest';
import type { ContactPin, SettingsEnvelope, SettingsKeyEnvelope } from './contacts';
import { createDeviceKey, rememberAccountKey } from './device';
import { fingerprint, hexBytes, keyDigest } from './fingerprint';
import type { GroupChainCache } from './group-trust';
import { groupKeyPair, newGroupSeed, parseRoster, rosterDigest, type GroupRole } from './groups';
import {
    createIdentity,
    publicIdentity,
    verifySuccessionConsent,
    type IdentityEnvelope,
    type SuccessionLink,
} from './identity';
import { decode, encode } from './keys';
import type { GroupPin } from './pins';
import { createCryptoSession, type CryptoRequests, type CryptoResults } from './session';
import {
    openDeviceRecord,
    type AreaRotationInput,
    type GroupWriter,
    type RosterCallBody,
    type ServedChain,
    type SignedStatementWire,
} from './session-groups';
import {
    digest,
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
const CHECKED = '2026-10-16T00:00:00.000Z';
const TAMPERED = /could not be opened/;
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
        settings: { version: 2, contacts: {}, groups: { ...settings.groups } },
    });
    Object.assign(settings, { version: settingsVersion, envelope });
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
    return { ...(await device()), root, identity, served: publicIdentity(identity), device };
}
type Account = Awaited<ReturnType<typeof account>>;

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
        if (result.status !== 'accepted') throw new Error(`fork at ${result.fork.version}`);
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

    const admit = await alice.call('groupStage', {
        groupId,
        expectedRevision: 1,
        op: {
            kind: 'admit',
            userId: BOB,
            pin: await pinOf(bob),
            served: bob.served,
            roles: bobRoles,
        },
        kems: { [BOB]: bob.served.kemPublicKey },
    });
    if (admit.outboxId === null) throw new Error('nothing staged');
    await alice.call('groupDrop', { outboxId: admit.outboxId });
    server.store(admit.body);
    await sync(alice, marks.alice);
    await sync(bob, marks.bob, { joining: { joinMark: admit.joinCode } });
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
    return { child, document, staged, rotation, grantTo, rotatedRoot, childListing };
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
    test('joining is refused while any mark exists: the record, the settings pin, a committed chain or a fork', async () => {
        const f = await family();
        const { bob, groupId, server, admit } = f;
        const join = (who: Device, record: string | null) =>
            who.call('groupAccept', {
                userId: BOB,
                groupId,
                served: server.served(),
                record,
                checkedAt: CHECKED,
                joining: { joinMark: admit.joinCode },
            });
        await expect(join(bob, f.marks.bob.record)).rejects.toThrow(/already checked this family/);
        // A fresh device with no record still has the settings pin.
        const fresh = await bob.device();
        await expect(join(fresh, null)).rejects.toThrow(/already checked this family/);
        // Without the pin, the chain this session committed is the mark.
        const pin = bob.settings.groups[groupId]!;
        delete bob.settings.groups[groupId];
        await saveSettings(bob);
        await loadSettings(bob);
        await expect(join(bob, null)).rejects.toThrow(/already checked this family/);
        // A device whose own marks disagree (a fork) does not start over by joining.
        const forking = await bob.device();
        bob.settings.groups[groupId] = {
            ...pin,
            rosterDigest: await rosterDigest(decode(server.rosters[0]!.statement)),
        };
        await saveSettings(forking);
        const accept = (served = server.served()) =>
            forking.call('groupAccept', {
                userId: BOB,
                groupId,
                served,
                record: f.marks.bob.record,
                checkedAt: CHECKED,
            });
        // Sealed but never confirmed by the server, a pin is no mark: only settingsOpen gives marks.
        await expect(accept()).resolves.toMatchObject({ status: 'accepted' });
        await loadSettings(forking);
        expect(await accept()).toMatchObject({
            status: 'fork',
            fork: { of: 'roster', version: 2 },
        });
        delete bob.settings.groups[groupId];
        await saveSettings(forking);
        await loadSettings(forking);
        // A refused acceptance afterwards keeps the fork.
        await expect(
            accept({
                ...server.served(),
                firstKeys: (await groupKeyPair(newGroupSeed())).publicKey,
            }),
        ).rejects.toThrow(/not the group keys whose words were checked/);
        await expect(join(forking, null)).rejects.toThrow(/already checked this family/);
        // Creation's vouching is refused where marks exist too.
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

    test('with no mark and no vouching nothing is accepted, and joining before the code gives a view only', async () => {
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
        await expect(accept()).rejects.toThrow(/compare the group’s words/);
        // The worker takes settings marks only from settings it opened itself.
        const bare = await bareDevice(carol);
        await expect(
            bare.call('groupAccept', {
                userId: CAROL,
                groupId: f.groupId,
                served: f.server.served(),
                record: null,
                checkedAt: CHECKED,
                joining: { joinMark: null },
            }),
        ).rejects.toThrow(/Open your settings first/);
        const words = await accept({ joining: { joinMark: null } });
        expect(words).toMatchObject({ status: 'accepted', record: null, pin: null });
        // A view, not a chain: nothing opens, stages, trusts or shows a code through it.
        const { area, groupId } = f;
        await expect(
            carol.call('groupOpenArea', {
                groupId,
                workspaceId: f.ws,
                idSeed: area.idSeed,
                servedVersion: 1,
                grant: null,
                selfGrant: null,
            }),
        ).rejects.toThrow(/Check the family’s member list first/);
        await expect(
            carol.call('groupTrustAs', {
                groupId,
                userId: BOB,
                served: f.bob.served,
                contact: { email: 'b@example.com', name: 'Bob', pinnedAt: CHECKED },
            }),
        ).rejects.toThrow(/Check the family’s member list first/);
        await expect(carol.call('groupJoinCode', { groupId, version: 2 })).rejects.toThrow(
            /Check the family’s member list first/,
        );
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
        // On the creating device, the staged roster is not committed by passing it back as served.
        await expect(
            accept(alice, { creating: { stagedEnvelope: created.stagedEnvelope } }),
        ).rejects.toThrow(/Drop the staged change/);
        // The server stored the call; the device reloaded before writing its record and pin.
        const reloaded = await alice.device();
        await expect(accept(reloaded, {})).rejects.toThrow(/compare the group’s words/);
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
        await expect(alice.call('groupJoinCode', { groupId, version: 3 })).rejects.toThrow(
            /not on the family’s history/,
        );
        const cacheOf = async (record: string) =>
            (
                (await openDeviceRecord(alice.root, ALICE, groupId, 'chains', record)) as {
                    cache: GroupChainCache;
                }
            ).cache;
        const unchanged = await f.sync(alice, { ...marks.alice });
        expect((await cacheOf(unchanged.record!)).rosterDigests).toHaveLength(2);
        // Another device's call won (here the same worker staged it, so it is dropped first).
        server.store(winner.body);
        await expect(f.sync(alice, marks.alice)).rejects.toThrow(/Drop the staged change/);
        await alice.call('groupDrop', { outboxId: winner.outboxId });
        const synced = await f.sync(alice, marks.alice);
        expect(synced).toMatchObject({ status: 'accepted', view: { rosterVersion: 3 } });
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

describe('the write version (F9)', () => {
    test('writes and documents need the area’s write version, the top level takes no node, and older documents are refused', async () => {
        const f = await family();
        const r = await rotated(f);
        const { alice, groupId, ws, area } = f;
        // The chain lists key 2 now, and this device holds only key 1: nothing is written.
        await expect(
            alice.call('driveCreateNodes', newFolder(ws, area.root.id, 1)),
        ).rejects.toThrow(/keys changed/);
        await expect(
            alice.call('driveSealDocument', {
                workspaceId: ws,
                kind: 'tags',
                version: 2,
                document: {},
            }),
        ).rejects.toThrow(/keys changed/);
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
        // ...and writes nothing under it, at any depth, whatever groupOpenArea was told.
        await expect(bob.call('driveCreateNodes', newFolder(ws, area.root.id, 1))).rejects.toThrow(
            /keys changed/,
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
            /keys changed/,
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
        ).rejects.toThrow(/keys changed/);
        await expect(open()).resolves.toMatchObject({ writable: false, reason: 'root-unknown' });
        // The genuine rotated root opens, with the old key only as its previous one.
        await fresh.call('driveOpenNodes', { workspaceId: f.ws, nodes: [r.rotatedRoot()] });
        await expect(open()).resolves.toMatchObject({ writable: true, reason: null });
        await expect(
            fresh.call('driveCreateNodes', newFolder(f.ws, f.area.root.id, 1)),
        ).rejects.toThrow(/keys changed/);
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
        await expect(
            f.bob.call('driveCreateNodes', newFolder(f.ws, f.area.root.id, 1)),
        ).rejects.toThrow(/keys changed/);
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
        ).rejects.toThrow(/keys changed/);
        await expect(
            f.alice.call('driveCreateNodes', newFolder(ws, area.root.id, 5)),
        ).resolves.toBeTruthy();
        // The uncached variant: a device that never listed the root caches nothing from a walk.
        const fresh = await f.bob.device();
        await f.sync(fresh, f.marks.bob);
        await openArea(fresh, r.grantTo(BOB));
        // Never writable without a root it opened, it refuses the whole walk before opening anything.
        await expect(walk(fresh, 1)).rejects.toThrow(/keys changed/);
        await expect(
            fresh.call('driveCreateNodes', newFolder(ws, area.root.id, 1)),
        ).rejects.toThrow(/keys changed/);
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
        const rename = () =>
            fresh.call('driveSealMetadata', {
                workspaceId: f.ws,
                nodeId: CHILD,
                kind: 'folder',
                metadataVersion: 2,
                metadata: folder('Renamed'),
            });
        await expect(write()).resolves.toBeTruthy();
        for (const [over, reason] of [
            [{ servedVersion: 1 }, 'server-behind'],
            // A server ahead of the chain also makes the self-grant suspect: the area grant opens.
            [{ servedVersion: 3, grant: r.grantTo(ALICE) }, 'server-ahead'],
        ] as const) {
            await expect(open({ selfGrant: r.rotation.selfGrant, ...over })).resolves.toMatchObject(
                { version: 2, writable: false, reason },
            );
            // Not only at the root: nothing anywhere in the area.
            await expect(write()).rejects.toThrow(/keys changed/);
            await expect(rename()).rejects.toThrow(/keys changed/);
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
        ).rejects.toThrow(/not the group keys whose words were checked/);
        await expect(verify(writer({}, f.bob.served))).resolves.toMatchObject({
            metadata: 'unchecked',
        });
    });

    test('a removal’s rotation re-seals the removed member’s records and never re-signs them as the remover’s', async () => {
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
        // Judged as the roster marking Bob left judges him: re-sealed, not "Alice wrote this".
        const ctx = {
            workspaceId: ws,
            nodeId: area.root.id,
            kind: 'folder' as const,
            metadataVersion: 2,
        };
        const envelope = decode(rotation!.root.rotated!.metadataEnvelope);
        const signature = decode(rotation!.root.rotated!.metadataSignature);
        const aliceKey = decode(alice.served.signingPublicKey, 32);
        expect(
            await verifyStatement(
                await metadataResealedStatement(ctx, envelope),
                signature,
                aliceKey,
            ),
        ).toBe(true);
        expect(
            await verifyStatement(await metadataStatement(ctx, envelope), signature, aliceKey),
        ).toBe(false);
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
        expect(
            await verifyStatement(
                await metadataResealedStatement(childCtx, decode(node.metadataEnvelope)),
                decode(node.metadataSignature!),
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
        ).rejects.toThrow(/keys changed/);
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
        const ask = (old: IdentityEnvelope, nxt: IdentityEnvelope) =>
            alice.call('identityConsent', { userId: ALICE, old, next: nxt });
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
        await expect(ask(alice.identity, tampered)).rejects.toThrow(TAMPERED);
        // An identity at the next version that is not this account's at all.
        const stranger = await createIdentity(crypto.getRandomValues(new Uint8Array(32)), ALICE, 2);
        await expect(ask(alice.identity, stranger)).rejects.toThrow(/could not be opened/);
        await expect(ask(next, alice.identity)).rejects.toThrow(/upgraded identities/);
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
        ).rejects.toThrow(/could not be opened/);
        await expect(
            alice.call('groupStoreOpen', { userId: ALICE, groupId, store: 'joins', envelope }),
        ).rejects.toThrow(/could not be opened/);
        await expect(
            bob.call('groupStoreOpen', { userId: BOB, groupId, store: 'outbox', envelope }),
        ).rejects.toThrow(/could not be opened/);
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
        await expect(alice.call('groupJoinCode', { groupId, version: 2 })).resolves.toEqual({
            code: f.admit.joinCode!.code,
        });
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

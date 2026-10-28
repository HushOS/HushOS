import type {
    CreateGroupBody,
    GroupWriter,
    RosterCallBody,
    RotationWire,
    WorkspaceKeyEnvelope,
} from '@hushos/crypto';
import { parseRoster, rosterDigest } from '@hushos/crypto/groups';
import { digest } from '@hushos/crypto/signatures';
import type { ContactPin } from '@hushos/crypto';
import type { RekeyView } from '@hushos/drive/api';
import { GroupApiError, type GroupsApi } from './api';
import { createMemoryFamilyGuard } from '@/lib/contact-guard';
import { familyGuardOf, type GroupContext } from './context';
import { createRotationSource } from './rotations';
import { createMemoryGroupStore } from './store';
import { account, bytes, pinOf } from './worker-testkit';

/*
 * A family server for the data layer's tests that run against the crypto
 * worker itself (removal.test.ts): it keeps what the roster routes would
 * store (the signed rosters and successions, the seals and grants, each
 * folder's top folder, documents and running walk) and serves it back the
 * way routes 3, 5, 6, 8, 25 and 29 do. It checks nothing a real server
 * checks; the worker on the other side checks everything it serves. Each
 * route can be told to answer a refusal first (`answer`), and every call is
 * logged in order (`log`), so a test can say what was sent, in what order,
 * and with which bytes. Imported by tests only.
 */

type Root = {
    id: string;
    keyEpoch: number;
    parentKeyEpoch: number;
    keyEnvelope: string;
    metadataVersion: number;
    metadataEnvelope: string;
    metadataSigner: string;
    metadataSignature: string | null;
    /* What a rotation kept of the writer, as the server serves it (it copies the origin itself). */
    metadataRekey?: RekeyView | null;
    changeSeq: number;
    prevKeyEnvelope: string | null;
    prevKeyEpoch: number | null;
    prevParentKeyEpoch: number | null;
};
type Area = {
    workspaceId: string;
    idSeed: string;
    version: number;
    root: Root;
    documents: Map<string, { version: number; envelope: string }>;
    rotation: { id: string; nodeId: string; targetEpoch: number } | null;
    nextEpoch: number;
    changeSeq: number;
};
type Grant = NonNullable<RosterCallBody['grants']>[number] & { granterUserId: string };
type Seal = NonNullable<RosterCallBody['seals']>[number] & { sealerUserId: string };
type Member = { state: 'active' | 'left'; roles: string[]; name: string; email: string };

export const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001';
export const BOB = 'b2b2b2b2-0000-4000-8000-000000000002';
export const CAROL = 'c3c3c3c3-0000-4000-8000-000000000003';
export const DAVE = 'd4d4d4d4-0000-4000-8000-000000000004';

export async function familyServer() {
    const people = {
        [ALICE]: await account(ALICE),
        [BOB]: await account(BOB),
        [CAROL]: await account(CAROL),
        [DAVE]: await account(DAVE),
    };
    const alice = people[ALICE];
    const rosters: RosterCallBody['roster'][] = [];
    const successions: RosterCallBody['roster'][] = [];
    const signerKeys: Record<string, string> = {};
    for (const who of Object.values(people))
        signerKeys[await digest(bytes(who.served.mlDsaPublicKey))] = who.served.mlDsaPublicKey;
    let created: CreateGroupBody | null = null;
    const areas = new Map<string, Area>();
    const grants: Grant[] = [];
    const seals: Seal[] = [];
    const selfGrants = new Map<string, WorkspaceKeyEnvelope>();
    const members = new Map<string, Member>();
    const departures: string[] = [];
    const holds: { userId: string; heldBy: string }[] = [];
    /* The plans the removal preview names (route 19, asked first), as a test sets them. */
    const lapsedPlans: { id: string; name: string; standing: 'payment-failed' | 'paused' }[] = [];
    const scripted = new Map<string, GroupApiError[]>();
    const log: { route: string; body?: unknown }[] = [];
    /* Who is asking: the account a test drives. */
    let caller = ALICE;
    /* Identities route 6 serves in place of a person's own (an account started over). */
    const servedAs = new Map<string, (typeof people)[typeof ALICE]['served']>();
    const servedOf = (userId: string) =>
        servedAs.get(userId) ?? people[userId as keyof typeof people].served;
    /* Members route 3 says are due to be folded in (their served identity left their entry). */
    let foldInDue: string[] = [];
    /* The next roster rotation is stored with a previous envelope that opens nothing (a bad rotator). */
    let junkNextPrevious = false;

    const head = async () => ({
        version: rosters.length,
        digest: rosters.length ? await rosterDigest(bytes(rosters.at(-1)!.statement)) : '',
        revision: rosters.length + successions.length,
        groupKeyVersion: successions.length + 1,
        replayed: false,
    });
    function refuseFirst(route: string) {
        const next = scripted.get(route)?.shift();
        if (next) throw next;
    }
    function rootRow(area: Area) {
        const r = area.root;
        return {
            id: r.id,
            workspaceId: area.workspaceId,
            parentId: null,
            kind: 'folder' as const,
            parentKeyEpoch: r.parentKeyEpoch,
            keyEpoch: r.keyEpoch,
            keyEnvelope: r.keyEnvelope,
            metadataVersion: r.metadataVersion,
            metadataEnvelope: r.metadataEnvelope,
            metadataSigner: { id: r.metadataSigner },
            metadataSignature: r.metadataSignature,
            metadataRekey: r.metadataRekey ?? null,
            prevKeyEnvelope: r.prevKeyEnvelope,
            prevKeyEpoch: r.prevKeyEpoch,
            prevParentKeyEpoch: r.prevParentKeyEpoch,
            changeSeq: r.changeSeq,
        };
    }
    function rotate(rotation: RotationWire) {
        const area = areas.get(rotation.workspaceId)!;
        const before = area.root;
        area.root = {
            ...before,
            keyEpoch: rotation.targetEpoch,
            parentKeyEpoch: rotation.toVersion,
            keyEnvelope: rotation.root.keyEnvelope,
            metadataEnvelope: rotation.root.rotated!.metadataEnvelope,
            metadataSigner: caller,
            metadataSignature: rotation.root.rotated!.metadataSignature ?? null,
            // As the server copies it: the origin kept before, else the record as it stood.
            metadataRekey: rotation.root.rotated!.metadataRekey
                ? {
                      origin: {
                          ...(before.metadataRekey?.origin ?? {
                              envelope: before.metadataEnvelope,
                              signer: { id: before.metadataSigner },
                              signature: before.metadataSignature!,
                          }),
                          keyEnvelope: rotation.root.rotated!.metadataRekey.originKeyEnvelope,
                      },
                      signature: rotation.root.rotated!.metadataRekey.signature,
                  }
                : null,
            changeSeq: before.changeSeq + 1,
            prevKeyEnvelope: junkNextPrevious
                ? btoa(String.fromCharCode(...new Uint8Array(72).fill(7)))
                      .replaceAll('+', '-')
                      .replaceAll('/', '_')
                      .replaceAll('=', '')
                : rotation.previousRootKeyEnvelope,
            prevKeyEpoch: before.keyEpoch,
            prevParentKeyEpoch: rotation.toVersion,
        };
        junkNextPrevious = false;
        area.version = rotation.toVersion;
        for (const document of rotation.documents)
            area.documents.set(document.kind, {
                version: document.version + 1,
                envelope: document.envelope,
            });
        selfGrants.set(`${caller}:${area.workspaceId}`, rotation.selfGrant);
        // The rest of the folder is walked through Drive afterwards.
        area.rotation = {
            id: crypto.randomUUID(),
            nodeId: before.id,
            targetEpoch: rotation.targetEpoch,
        };
    }
    async function apply(route: string, call: RosterCallBody, target: string | null = null) {
        log.push({ route, body: structuredClone(call) });
        refuseFirst(route);
        // The server's rule (packages/db applyRoster): an entry whose roles change is the member
        // route's target, and only there, but for a Continue's: on POST rosters, an entry with new
        // keys may lose `members`, and only that.
        if (rosters.length > 0) {
            const before = parseRoster(bytes(rosters.at(-1)!.statement)).members;
            for (const entry of parseRoster(bytes(call.roster.statement)).members) {
                const was = before.find((at) => at.userId === entry.userId);
                const roles = (list: readonly string[]) => [...list].sort().join();
                const rekeyed =
                    was !== undefined &&
                    (was.keyVersion !== entry.keyVersion ||
                        was.encryptionPublicKey !== entry.encryptionPublicKey ||
                        was.signingPublicKey !== entry.signingPublicKey ||
                        was.mlDsaPublicKeyDigest !== entry.mlDsaPublicKeyDigest ||
                        was.kemPublicKeyDigest !== entry.kemPublicKeyDigest);
                const continued =
                    route === 'rosters' &&
                    rekeyed &&
                    roles(was.roles.filter((role) => role !== 'members')) === roles(entry.roles);
                if (
                    was?.status === 'active' &&
                    entry.status === 'active' &&
                    roles(was.roles) !== roles(entry.roles) &&
                    !continued &&
                    (route !== 'member' || entry.userId !== target)
                ) {
                    log.pop();
                    throw new GroupApiError('role-change', 400, 'invalid', {
                        reason: 'role-change',
                    });
                }
            }
        }
        rosters.push(call.roster);
        if (call.succession) successions.push(call.succession);
        for (const grant of call.grants ?? []) grants.push({ ...grant, granterUserId: caller });
        for (const seal of [...(call.seals ?? []), ...(call.keySeal ? [call.keySeal] : [])])
            seals.push({ ...seal, sealerUserId: caller });
        for (const rotation of [
            ...(call.rotations ?? []),
            ...(call.rotation ? [call.rotation] : []),
        ])
            rotate(rotation);
        const roster = parseRoster(bytes(call.roster.statement));
        for (const entry of roster.members) {
            const member = members.get(entry.userId);
            if (member) {
                member.state = entry.status === 'active' ? 'active' : 'left';
                member.roles = [...entry.roles];
            }
            if (entry.status !== 'active') {
                const at = departures.indexOf(entry.userId);
                if (at >= 0) departures.splice(at, 1);
                for (const hold of holds.slice())
                    if (hold.userId === entry.userId) holds.splice(holds.indexOf(hold), 1);
            }
        }
        return head();
    }
    const named = (userId: string) => ({
        name: {
            [ALICE]: 'Alice Lindqvist',
            [BOB]: 'Bob Lindqvist',
            [CAROL]: 'Carol Lindqvist',
            [DAVE]: 'Dave Lindqvist',
        }[userId]!,
        email: `${userId}@example.com`,
    });

    const api = {
        createGroup: async (body: CreateGroupBody) => {
            log.push({ route: 'create', body });
            if (!created) {
                created = body;
                rosters.push(body.roster);
                const root = body.area.root;
                areas.set(body.area.workspaceId, {
                    workspaceId: body.area.workspaceId,
                    idSeed: body.area.idSeed,
                    version: 1,
                    root: {
                        id: root.id,
                        keyEpoch: root.keyEpoch,
                        parentKeyEpoch: root.parentKeyEpoch,
                        keyEnvelope: root.keyEnvelope,
                        metadataVersion: 1,
                        metadataEnvelope: root.metadataEnvelope,
                        metadataSigner: ALICE,
                        metadataSignature: root.metadataSignature,
                        changeSeq: 1,
                        prevKeyEnvelope: null,
                        prevKeyEpoch: null,
                        prevParentKeyEpoch: null,
                    },
                    documents: new Map(),
                    rotation: null,
                    nextEpoch: 2,
                    changeSeq: 1,
                });
                selfGrants.set(`${ALICE}:${body.area.workspaceId}`, body.area.selfGrant);
                members.set(ALICE, {
                    state: 'active',
                    roles: ['billing', 'members'],
                    ...named(ALICE),
                });
                seals.push({
                    groupKeyVersion: 1,
                    holderUserId: ALICE,
                    holderKeyVersion: 1,
                    rosterVersion: 1,
                    rosterDigest: await rosterDigest(bytes(body.roster.statement)),
                    envelope: body.keySeal.envelope,
                    sealerUserId: ALICE,
                });
            }
            return { group: {} };
        },
        /* Route 2: the caller's family, as route 2 lists it for them. */
        listGroups: async () => ({
            groups:
                created && members.get(caller)
                    ? [
                          {
                              id: created.id,
                              kind: 'family',
                              name: 'Lindqvist',
                              state: members.get(caller)!.state,
                              roles: members.get(caller)!.roles,
                              rosterVersion: rosters.length,
                          },
                      ]
                    : [],
        }),
        group: async () => ({
            head: await head(),
            members: [...members].map(([userId, member]) => ({ userId, ...member })),
            due:
                members.get(caller)?.state === 'active'
                    ? {
                          grants: [],
                          ...(members.get(caller)?.roles.includes('members')
                              ? {
                                    markLeft: [...departures],
                                    foldIn: [...foldInDue],
                                    succession: false,
                                    rotations: [],
                                    holds: holds.map((hold) => ({
                                        ...hold,
                                        expiresAt: '2026-10-17T12:15:00.000Z',
                                    })),
                                }
                              : {}),
                      }
                    : undefined,
        }),
        rosters: async (_groupId: string, after: number) => ({
            rosters: rosters
                .slice(after)
                .map((roster, at) => ({ version: after + at + 1, ...roster })),
            successions: [...successions],
            firstKeys: created!.groupKey,
            signerKeys: { ...signerKeys },
            head: await head(),
            next: null,
        }),
        identities: async () => ({
            identities: [...members.keys()].map((userId) => ({
                userId,
                identity: servedOf(userId),
                links: [],
            })),
            next: null,
        }),
        keySeal: async () => {
            const mine = seals
                .filter((seal) => seal.holderUserId === caller)
                .sort((a, b) => b.groupKeyVersion - a.groupKeyVersion)[0]!;
            return { ...mine };
        },
        putKeySeals: async (_groupId: string, put: Seal[]) => {
            log.push({ route: 'key-seals', body: put });
            return { stored: put.length };
        },
        admit: (_groupId: string, userId: string, call: RosterCallBody) => {
            members.set(userId, { state: 'active', roles: [], ...named(userId) });
            return apply('admit', call);
        },
        patchMember: (_groupId: string, userId: string, call: RosterCallBody) =>
            apply('member', call, userId),
        removeMember: (_groupId: string, _userId: string, call: RosterCallBody) =>
            apply('remove', call),
        removalPreview: async (_groupId: string, userId: string) => {
            log.push({ route: 'remove-preview', body: { userId } });
            refuseFirst('remove-preview');
            return { plans: lapsedPlans.slice() };
        },
        postRoster: (_groupId: string, call: RosterCallBody) => apply('rosters', call),
        rotateArea: (_groupId: string, _workspaceId: string, call: RosterCallBody) =>
            apply('rotation', call),
        deleteArea: async (_groupId: string, workspaceId: string, call: RosterCallBody) => {
            const head = await apply('delete', call);
            areas.delete(workspaceId);
            return head;
        },
        createArea: async (_groupId: string, call: RosterCallBody) => {
            const head = await apply('areas', call);
            const made = call.area!;
            areas.set(made.workspaceId, {
                workspaceId: made.workspaceId,
                idSeed: made.idSeed,
                version: 1,
                root: {
                    id: made.root.id,
                    keyEpoch: made.root.keyEpoch,
                    parentKeyEpoch: made.root.parentKeyEpoch,
                    keyEnvelope: made.root.keyEnvelope,
                    metadataVersion: 1,
                    metadataEnvelope: made.root.metadataEnvelope,
                    metadataSigner: caller,
                    metadataSignature: made.root.metadataSignature,
                    changeSeq: 1,
                    prevKeyEnvelope: null,
                    prevKeyEpoch: null,
                    prevParentKeyEpoch: null,
                },
                documents: new Map(),
                rotation: null,
                nextEpoch: 2,
                changeSeq: 1,
            });
            selfGrants.set(`${caller}:${made.workspaceId}`, made.selfGrant);
            return head;
        },
        postGrants: async (_groupId: string, workspaceId: string, posted: Grant[]) => {
            log.push({ route: 'grants', body: { workspaceId, grants: posted } });
            for (const grant of posted) grants.push({ ...grant, granterUserId: caller });
            return { stored: posted.length };
        },
        putSelfGrant: async (
            _groupId: string,
            workspaceId: string,
            grant: WorkspaceKeyEnvelope,
        ) => {
            selfGrants.set(`${caller}:${workspaceId}`, grant);
            return { ok: true };
        },
        hold: async (_groupId: string, userId: string) => {
            log.push({ route: 'hold', body: { userId } });
            refuseFirst('hold');
            holds.push({ userId, heldBy: caller });
            return { heldUntil: '2026-10-17T12:15:00.000Z' };
        },
        putPreviousRoot: async (
            _groupId: string,
            workspaceId: string,
            input: { rotationId: string; previousRootKeyEnvelope: string },
        ) => {
            log.push({ route: 'previous-root', body: { workspaceId, ...input } });
            const area = areas.get(workspaceId)!;
            area.root = {
                ...area.root,
                prevKeyEnvelope: input.previousRootKeyEnvelope,
                changeSeq: area.root.changeSeq + 1,
            };
            return { changeSeq: area.root.changeSeq };
        },
        areaRoot: async (_groupId: string, workspaceId: string) => {
            log.push({ route: 'area-root', body: { workspaceId } });
            const area = areas.get(workspaceId)!;
            return { ...rootRow(area), depth: 0, versions: [], shares: [], links: [] };
        },
        spaces: async () => ({
            spaces: [
                {
                    space: { kind: 'group', groupId: created!.id, name: 'Lindqvist' },
                    areas: [...areas.values()].map((area) => {
                        const grant = grants
                            .filter(
                                (at) =>
                                    at.workspaceId === area.workspaceId &&
                                    at.granteeUserId === caller,
                            )
                            .sort((a, b) => b.workspaceKeyVersion - a.workspaceKeyVersion)[0];
                        const {
                            workspaceId: _ws,
                            kind: _kind,
                            metadataSigner: _s,
                            ...root
                        } = rootRow(area);
                        return {
                            workspaceId: area.workspaceId,
                            idSeed: area.idSeed,
                            workspaceKeyVersion: area.version,
                            changeSeq: area.changeSeq,
                            root,
                            rotation: area.rotation,
                            grant: grant ?? null,
                            selfGrant: selfGrants.get(`${caller}:${area.workspaceId}`) ?? null,
                        };
                    }),
                },
            ],
        }),
    } as unknown as GroupsApi;

    /* Drive's side of what a rotation reads: the folder's epochs and documents. */
    const drive = {
        allocateEpochs: async (workspaceId: string) => {
            log.push({ route: 'epochs', body: { workspaceId } });
            const area = areas.get(workspaceId)!;
            const from = Math.max(area.nextEpoch, area.root.keyEpoch + 1);
            area.nextEpoch = from + 1;
            return { from, to: from };
        },
        document: async (workspaceId: string, kind: string) => {
            const held = areas.get(workspaceId)!.documents.get(kind);
            return {
                document: held
                    ? { kind, ...held, updatedAt: '2026-10-17T00:00:00.000Z', envelopeSuite: 1 }
                    : null,
            };
        },
    };

    const walked: { workspaceId: string; rotationId: string }[] = [];
    const rotations = createRotationSource({
        areaRoot: (groupId, workspaceId) => api.areaRoot(groupId, workspaceId),
        allocateEpochs: drive.allocateEpochs,
        document: drive.document as never,
        writers: async (): Promise<GroupWriter[]> =>
            [...members.keys()].map((userId) => ({
                userId,
                pinned: null,
                served: servedOf(userId),
                links: [],
                personal: null,
            })),
        // The Drive walk itself is lib/spaces.ts's (and Drive's tests'): here it is logged, and done.
        walk: async (_groupId, rotation) => {
            log.push({ route: 'walk', body: { ...rotation } });
            walked.push({ workspaceId: rotation.workspaceId, rotationId: rotation.rotationId });
            areas.get(rotation.workspaceId)!.rotation = null;
        },
    });

    /* Alice's family guard: one per browser, kept across her devices' worker sessions here. */
    const guard = createMemoryFamilyGuard();
    /* Alice's device: one worker session, this server, the memory store, her settings. */
    async function device(): Promise<GroupContext> {
        const opened = await alice.device();
        const pins: Record<string, ContactPin> = {
            [BOB]: { ...(await pinOf(people[BOB])), userId: BOB },
            [CAROL]: { ...(await pinOf(people[CAROL])), userId: CAROL },
            [DAVE]: { ...(await pinOf(people[DAVE])), userId: DAVE },
        };
        const { settings, version } = await opened.settings.read();
        await opened.settings.write(version, { ...settings, contacts: pins });
        return {
            userId: ALICE,
            api,
            rpc: opened.call as GroupContext['rpc'],
            store: createMemoryGroupStore(),
            settings: opened.settings,
            guard: familyGuardOf(() => guard, ALICE),
            lock: (_groupId, work) => work(),
            sleep: async () => {},
            now: () => new Date('2026-10-17T12:00:00.000Z'),
            identities: async () => ({ identity: alice.identity, history: [] }),
            deleteMirrors: async () => {},
            rotations,
        };
    }

    /*
     * Another member's device (Bob's, Carol's): one worker session, this server, a store and a
     * family guard of its own, their settings with no pins. Drive it after `as(userId)`.
     */
    async function deviceOf(userId: typeof BOB | typeof CAROL): Promise<GroupContext> {
        const who = people[userId];
        const opened = await who.device();
        const own = createMemoryFamilyGuard();
        return {
            userId,
            api,
            rpc: opened.call as GroupContext['rpc'],
            store: createMemoryGroupStore(),
            settings: opened.settings,
            guard: familyGuardOf(() => own, userId),
            lock: (_groupId, work) => work(),
            sleep: async () => {},
            now: () => new Date('2026-10-17T12:00:00.000Z'),
            identities: async () => ({ identity: who.identity, history: [] }),
            deleteMirrors: async () => {},
            rotations: null,
        };
    }

    return {
        people,
        api,
        deviceOf,
        drive,
        areas,
        grants,
        members,
        departures,
        holds,
        lapsedPlans,
        log,
        walked,
        rotations,
        device,
        /* Alice's family guard (2.8), as her browser keeps it. */
        familyGuard: guard,
        groupId: () => created!.id,
        workspaceId: () => created!.area.workspaceId,
        /* The next answer of `route` (create, admit, member, remove, rosters, rotation, hold) is this refusal. */
        answer(route: string, error: GroupApiError) {
            scripted.set(route, [...(scripted.get(route) ?? []), error]);
        },
        as(userId: string) {
            caller = userId;
        },
        /* From now on route 6 serves `served` as this person's identity (they started over). */
        serveAs(userId: string, served: (typeof people)[typeof ALICE]['served']) {
            servedAs.set(userId, served);
        },
        /* Route 3's `due.foldIn` from now on. */
        dueFoldIn(userIds: string[]) {
            foldInDue = [...userIds];
        },
        junkNextPrevious() {
            junkNextPrevious = true;
        },
        sent: (route: string) =>
            log
                .filter((entry) => entry.route === route)
                .map((entry) => entry.body as RosterCallBody),
    };
}

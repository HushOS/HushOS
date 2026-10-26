import type { CryptoResults, GroupView, RosterFork, ServedChain } from '@hushos/crypto';
import { SPLIT_CHAIN } from '@hushos/crypto/protocol';
import {
    acceptFromRecord,
    accountError,
    lostRace,
    servedRaceMessage,
} from '@hushos/crypto/record-acceptance';
import {
    GroupApiError,
    isNotMember,
    type MemberIdentity,
    type ServedRosterPage,
    type SpaceList,
} from './api';
import type { GroupContext, GroupNotice } from './context';
import { flushOutbox } from './outbox';
import { settlePin, type OpenedArea } from './pins';

/*
 * Syncing one family (the 1c plan, section 2 "Sync", and 1.4): the member
 * list from route 5, accepted in the worker against this person's marks; the
 * device record and the settings pin written from that committed acceptance
 * only; then every family folder from route 25 opened, a self-grant stored
 * where the worker made one, and each folder's root listed, since the worker
 * counts an area writable only once it has opened a root under the area's
 * write version itself.
 *
 * This module never vouches for first keys on its own: it passes `creating`
 * only for the creator's own outbox entry (outbox.ts), and never `joining`
 * (join.ts alone does, join-only.test.ts).
 */

export type AreaState = {
    workspaceId: string;
    opened: CryptoResults['groupOpenArea'] | null;
    /* Why it is not open, when it is not: shown as "Couldn't check this folder's keys". */
    error: string | null;
    /* Whether the root opened here under the area's write version (what the worker counts). */
    rootListed: boolean;
    /* The folder's name, from its root's sealed metadata; null when the root did not open. */
    name: string | null;
    /* Route 25's view of the area: what its Drive client opens (lib/spaces.ts). */
    view: {
        workspaceKeyVersion: number;
        changeSeq: number;
        root: AreaRoot | null;
        rotation: { id: string; nodeId: string; targetEpoch: number } | null;
    };
    /* What this device may do in it, as the worker will allow it (areaWrite). */
    write: AreaWrite;
};
type AreaRoot = NonNullable<
    Extract<SpaceList[number]['areas'][number], { idSeed: string }>['root']
>;

/*
 * Whether a family folder may be written on this device, as the worker decides
 * it (plan section 5, F9): it opened at the member list's latest key version,
 * the server serves that version, and its root opened here under it. Else
 * `read-only` (no grant at the latest version, or no root, so its keys could
 * not be checked) or `keys-changed` (the server is behind or ahead of the
 * member list, or the root is not under the latest key: a key change the
 * server withheld, or one it ran ahead of). The worker refuses every write
 * that is not `writable` whatever this says; this only lets the page say so.
 */
export type AreaWrite = 'writable' | 'read-only' | 'keys-changed';

/*
 * Why nothing may be added to `folder` in a family folder now, or null: the
 * worker refuses a write the member list does not allow whatever this says
 * (F9), and a folder a running key change has not reached yet (its key epoch
 * below the walk's target) takes nothing until it has (docs/groups-server.md
 * 8, decision D9). Uploads wait for that one (`waitsForKeyChange`) and go on
 * their own once the walk has re-keyed the folder or ended.
 */
export function writeRefusal(
    state: Pick<AreaState, 'write' | 'view'> | undefined,
    folder: KeyedNode,
) {
    if (!state) return 'Open the family again, then try again.';
    if (state.write === 'read-only')
        return 'HushOS couldn’t check this folder’s keys on this device, so nothing can be added to it.';
    if (state.write === 'keys-changed')
        return 'This folder’s keys changed. Use Check again on the folder, then try again.';
    if (waitsForKeyChange(state, folder))
        return 'Finishing a key change. Uploads to this folder wait for it; anything else can be added once it’s done.';
    return null;
}
/* A node as the walk's rule reads it: its key epoch and the parent epoch its envelope is under. */
export type KeyedNode = { keyEpoch: number; parentKeyEpoch?: number; parentId?: string | null };
/*
 * Whether a running key change has yet to reach `folder`, by the walk's own
 * rule (listRotationWork): its key epoch below the target, or its envelope
 * still under a parent epoch below it. A top folder's envelope is under its
 * area's key version, which is no node epoch, so only its key epoch counts.
 */
export function keyChangeAhead(rotation: { targetEpoch: number } | null, folder: KeyedNode) {
    if (!rotation) return false;
    if (folder.keyEpoch < rotation.targetEpoch) return true;
    return (
        folder.parentId !== null &&
        folder.parentId !== undefined &&
        folder.parentKeyEpoch !== undefined &&
        folder.parentKeyEpoch < rotation.targetEpoch
    );
}
export function waitsForKeyChange(
    state: Pick<AreaState, 'write' | 'view'> | undefined,
    folder: KeyedNode,
) {
    return Boolean(state?.write === 'writable' && keyChangeAhead(state.view.rotation, folder));
}
export function areaWrite(state: Pick<AreaState, 'opened' | 'rootListed' | 'view'>): AreaWrite {
    const reason = state.opened?.reason;
    if (!state.opened || reason === 'no-grant-at-latest') return 'read-only';
    if (reason === 'server-behind' || reason === 'server-ahead') return 'keys-changed';
    if (state.rootListed) return 'writable';
    return state.view.root ? 'keys-changed' : 'read-only';
}

export type SyncResult =
    | {
          status: 'accepted';
          view: GroupView;
          areas: AreaState[];
          pinSaved: boolean;
          notices: GroupNotice[];
      }
    | { status: 'fork'; fork: RosterFork }
    /* No mark on this device or in settings: only the join flow can start this family here. */
    | { status: 'unchecked'; notices: GroupNotice[] }
    /* Accepted but not admitted yet: the join flow's waiting step. */
    | { status: 'waiting' }
    /* `not-member`: the family is gone from this device. */
    | { status: 'wiped' };

const MAX_PAGES = 64;

/*
 * Route 5 from `after` to the head, a page at a time: rosters in order, every
 * signer key any page named, and the successions and first keys of the last
 * page (each page serves them all). Pages that disagree on the first keys
 * are refused: one served chain has one version 1.
 */
export async function fetchServed(
    ctx: GroupContext,
    groupId: string,
    after: number,
): Promise<{ served: ServedChain; head: ServedRosterPage['head'] }> {
    const rosters: ServedChain['rosters'] = [];
    const signerKeys: Record<string, string> = {};
    let last: ServedRosterPage | null = null;
    let cursor = after;
    for (let page = 0; page < MAX_PAGES; page++) {
        const served: ServedRosterPage = await ctx.api.rosters(groupId, cursor);
        if (
            last &&
            (last.firstKeys.ed25519PublicKey !== served.firstKeys.ed25519PublicKey ||
                last.firstKeys.mlDsaPublicKey !== served.firstKeys.mlDsaPublicKey)
        )
            throw new Error('The server sent this family’s member list inconsistently.');
        for (const roster of served.rosters)
            rosters.push({
                statement: roster.statement,
                signature: roster.signature,
                signerSignature: roster.signerSignature,
            });
        Object.assign(signerKeys, served.signerKeys);
        last = served;
        if (served.next === null || served.next === undefined) break;
        if (served.next <= cursor) throw new Error('The server sent a member list page twice.');
        cursor = served.next;
    }
    if (!last || (last.next !== null && last.next !== undefined))
        throw new Error('This family’s member list is too long to load.');
    return {
        served: {
            rosters,
            successions: last.successions.map((succession) => ({
                statement: succession.statement,
                signature: succession.signature,
                signerSignature: succession.signerSignature,
            })),
            firstKeys: last.firstKeys,
            signerKeys,
        },
        head: last.head,
    };
}

/* Route 6, every page: each member's served identity and succession links, by user id. */
export async function fetchIdentities(ctx: GroupContext, groupId: string) {
    const out = new Map<string, MemberIdentity>();
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
        const { identities, next } = await ctx.api.identities(groupId, after);
        for (const member of identities) out.set(member.userId, member);
        if (!next) return out;
        after = next;
    }
    throw new Error('This family has too many members to load.');
}

type Accepted = Extract<CryptoResults['groupAccept'], { status: 'accepted' }>;
type Fork = Extract<CryptoResults['groupAccept'], { status: 'fork' }>;

/*
 * One acceptance of what route 5 serves after this device's record (from
 * version 1 without one), with the settings read first so the worker holds
 * their pin as a mark. A chain that does not continue the record is fetched
 * again from version 1, where the record is one more mark (design 2.4, step
 * 3). The record is written only from a committed acceptance.
 *
 * Three recoveries, all on the worker's own word:
 * - staged calls whose roster the accepted chain holds (another tab landed
 *   them, or a resend this tab never heard back from) come back as `dropped`;
 *   their outbox rows go only once the record is written, and never the row
 *   of `owner` (a creation, whose seed stays until the settings pin is);
 * - a record that does not open (`record-unreadable`, after a master-key
 *   rotation) is deleted, and the caller starts over without it;
 * - a record the worker refuses even from version 1 has its cache left out
 *   (`withoutCache`): the chain is accepted from version 1 against the
 *   settings pin and the record's own pin, so nothing below the record's
 *   version and digest is ever taken, whatever settings the server serves;
 *   the record is overwritten only by that acceptance.
 */
export async function acceptServed(
    ctx: GroupContext,
    groupId: string,
    options: { creating?: string | null; owner?: string | null } = {},
): Promise<Accepted | Fork | { status: 'record-unreadable' }> {
    for (let attempt = 0; ; attempt++)
        try {
            return await acceptOnce(ctx, groupId, options);
        } catch (error) {
            // A run that lost a race with a later acceptance in this worker (a background sync
            // finishing after the foreground's), or met a roster committed meanwhile at its own
            // version: nothing of it was kept. Read the record and settings again and accept once
            // more, quietly; the next run either lands or, for a split view, answers the fork.
            if (!lostRace(error)) throw error;
            if (attempt >= 2)
                throw new Error(servedRaceMessage((error as Error).message === SPLIT_CHAIN));
        }
}

async function acceptOnce(
    ctx: GroupContext,
    groupId: string,
    options: { creating?: string | null; owner?: string | null },
): Promise<Accepted | Fork | { status: 'record-unreadable' }> {
    await ctx.settings.read();
    const row = await ctx.store.chain(ctx.userId, groupId);
    const accept = async (after: number, withoutCache: boolean, retried: boolean) => {
        const { served } = await fetchServed(ctx, groupId, after);
        const result = await ctx.rpc('groupAccept', {
            userId: ctx.userId,
            groupId,
            served,
            record: row?.envelope ?? null,
            checkedAt: ctx.now().toISOString(),
            creating: options.creating ? { stagedEnvelope: options.creating } : null,
            ...(withoutCache ? { withoutCache } : {}),
            // A refusal the ladder retries keeps the family committed (and its folders readable).
            ...(retried ? { retried } : {}),
        });
        // Only a join answers these, and a sync never joins.
        if (
            result.status === 'changed' ||
            result.status === 'not-admitted' ||
            result.status === 'join-unreadable'
        )
            throw new Error('The family could not be checked. Try again.');
        return result;
    };
    // The order is the shared one (@hushos/crypto/record-acceptance, the core's accept_served):
    // continuing the record's cache, then from version 1 with it, then from version 1 without the
    // cache but with the record's pin as a mark, never below the record's version and digest, so
    // a server that gets the cache refused and serves older settings rolls nothing back. The
    // route's answer is the route's, and a lost race is the caller's to read again.
    const result = await acceptFromRecord(
        row ? (row.rosterVersion ?? 0) : null,
        accept,
        // The route's own answers, and a session or account that changed meanwhile.
        (error) => error instanceof GroupApiError || accountError(error),
    );
    if (result.status === 'record-unreadable') {
        await ctx.store.deleteChain(ctx.userId, groupId);
        return result;
    }
    if (result.status === 'accepted' && result.record) {
        // Records reach disk in commit order: putChain never writes over a record at a later
        // roster version (a background acceptance finishing after the foreground's), and the
        // record is written before the settings pin is (afterAccept).
        await ctx.store.putChain({
            userId: ctx.userId,
            groupId,
            envelope: result.record,
            rosterVersion: result.view.rosterVersion,
            areas: Object.keys(result.view.areas),
        });
        // Served and accepted, so stored: those calls landed, and nothing is left to send.
        for (const id of result.dropped) if (id !== options.owner) await ctx.store.deleteOutbox(id);
    }
    return result;
}

/*
 * Every family folder route 25 lists for the group, opened in the worker:
 * the self-grant where the worker found it current, else the area grant with
 * its granter's keys from route 6. A self-grant the worker made is stored
 * (route 23). Then each root is listed, which is what lets the worker count
 * the area writable (a null root never is).
 */
export async function openAreas(
    ctx: GroupContext,
    groupId: string,
    view: GroupView,
): Promise<AreaState[]> {
    const { spaces } = await ctx.api.spaces();
    const space = spaces.find(
        (entry) => entry.space.kind === 'group' && entry.space.groupId === groupId,
    );
    if (!space) return [];
    const identities = await fetchIdentities(ctx, groupId);
    const out: AreaState[] = [];
    for (const area of space.areas) {
        if (!('idSeed' in area)) continue;
        const state: AreaState = {
            workspaceId: area.workspaceId,
            opened: null,
            error: null,
            rootListed: false,
            name: null,
            view: {
                workspaceKeyVersion: area.workspaceKeyVersion,
                changeSeq: area.changeSeq,
                root: area.root,
                rotation: area.rotation,
            },
            write: 'read-only',
        };
        out.push(state);
        try {
            const granter = area.grant ? identities.get(area.grant.granterUserId) : undefined;
            state.opened = await ctx.rpc('groupOpenArea', {
                groupId,
                workspaceId: area.workspaceId,
                idSeed: area.idSeed,
                servedVersion: area.workspaceKeyVersion,
                grant: area.grant,
                granterMlDsaPublicKey: granter?.identity?.mlDsaPublicKey ?? null,
                granterHistory: granter?.identity
                    ? { served: granter.identity, links: granter.links }
                    : null,
                selfGrant: area.selfGrant,
            });
            if (state.opened.selfGrantToStore)
                await ctx.api
                    .putSelfGrant(groupId, area.workspaceId, state.opened.selfGrantToStore)
                    // area-moved: the area rotated meanwhile; the next sync wraps the new key.
                    .catch((error: unknown) => {
                        if (isNotMember(error)) throw error;
                    });
            const root = area.root;
            if (root) {
                const listed = await ctx.rpc('driveOpenNodes', {
                    workspaceId: area.workspaceId,
                    nodes: [
                        {
                            id: root.id,
                            // A root is served without a parent: its parent is the area's key.
                            parentId: root.parentId ?? area.workspaceId,
                            parentKeyEpoch: root.parentKeyEpoch,
                            keyEpoch: root.keyEpoch,
                            keyEnvelope: root.keyEnvelope,
                            metadataVersion: root.metadataVersion,
                            metadataEnvelope: root.metadataEnvelope,
                            prevKeyEnvelope: root.prevKeyEnvelope,
                            prevKeyEpoch: root.prevKeyEpoch,
                            prevParentKeyEpoch: root.prevParentKeyEpoch,
                        },
                    ],
                });
                // Only a root that opened (its envelope under the area key at that version) counts.
                const opened = listed.nodes[0];
                state.name = opened && !opened.error ? (opened.metadata?.name ?? null) : null;
                state.rootListed =
                    opened !== undefined &&
                    !opened.error &&
                    root.parentKeyEpoch === view.areas[area.workspaceId];
            }
        } catch (error) {
            if (isNotMember(error)) throw error;
            state.error = error instanceof Error ? error.message : 'Please try again.';
        }
        state.write = areaWrite(state);
    }
    return out;
}

/*
 * What follows a committed acceptance: open the areas, then bring the
 * settings pin up to it with the areas just opened. Shared by sync and the
 * join flow's last step. A fork a re-acceptance meets (the settings carried
 * another device's conflicting pin) is the answer, and nothing is saved.
 */
export async function afterAccept(
    ctx: GroupContext,
    groupId: string,
    accepted: Accepted,
    notices: GroupNotice[] = [],
): Promise<Extract<SyncResult, { status: 'accepted' }> | Fork> {
    const areas = accepted.record ? await openAreas(ctx, groupId, accepted.view) : [];
    if (accepted.record) ctx.rotations?.opened?.(groupId, areas);
    const opened = areas.flatMap((area) => (area.opened ? [area.opened.pinArea] : []));
    let view = accepted.view;
    const settled = await settlePin(ctx, groupId, accepted, {
        opened,
        reaccept: async () => {
            const again = await acceptServed(ctx, groupId);
            if (again.status === 'record-unreadable')
                throw new Error('This device’s saved check of the family could not be opened.');
            if (again.status === 'accepted') view = again.view;
            return again;
        },
    });
    if (settled.status === 'fork') return settled;
    return { status: 'accepted', view, areas, pinSaved: true, notices };
}

/*
 * Only after a 404 `not-member` (groups-server 0.9): never on a bare 404, a
 * 501, or anything a Drive route answers. What this device kept of the family
 * goes: the worker's chain, seeds and keys, the record, outbox and pending
 * join, and the family folders' mirrors. **The settings pin stays**: it is
 * sealed, only this person reads it, and if the family comes back (a server
 * that said not-member to erase a fork warning, then lists them again) it is
 * still a mark, so the history it fixes is checked and joining stays refused.
 */
export async function wipeGroup(ctx: GroupContext, groupId: string, areas: readonly string[] = []) {
    const row = await ctx.store.chain(ctx.userId, groupId);
    // No family guard is kept on the web yet: PR 4 (docs/optional-verification.md 8) passes the
    // held one and stores the guard this returns before anything below is deleted.
    await ctx.rpc('groupForget', { groupId, checkedAt: new Date().toISOString() });
    await ctx.store.forgetGroup(ctx.userId, groupId);
    await ctx.deleteMirrors([...new Set([...(row?.areas ?? []), ...areas])]);
}

/*
 * One sync, for a caller that already holds the group's write lock. Before
 * anything is accepted, this group's outbox calls go once more as they were
 * signed (`flush`), so a call that landed is known to have before its staged
 * roster turns up among the served ones; the outbox itself passes `flush:
 * false`. `creating` is the creator's staged envelope, passed by the outbox
 * only while nothing marks the family on this device.
 */
export async function syncLocked(
    ctx: GroupContext,
    groupId: string,
    options: {
        creating?: string | null;
        owner?: string | null;
        state?: string;
        flush?: boolean;
    } = {},
): Promise<SyncResult> {
    const notices: GroupNotice[] = [];
    try {
        // Accepted but not admitted: the join flow's (join.ts), never a sync's.
        if (options.state === 'accepted') return { status: 'waiting' };
        if (options.flush !== false) {
            const flushed = await flushOutbox(ctx, groupId);
            if (flushed.wiped) return { status: 'wiped' };
            notices.push(...flushed.notices);
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const row = await ctx.store.chain(ctx.userId, groupId);
            const { settings } = await ctx.settings.read();
            const pinned = settings.groups?.[groupId] ?? null;
            const creating = row || pinned ? null : (options.creating ?? null);
            if (!row && !pinned && !creating) return { status: 'unchecked', notices };
            const accepted = await acceptServed(ctx, groupId, { creating, owner: options.owner });
            if (accepted.status === 'record-unreadable') {
                // Deleted: once more without it, against the settings pin (or unchecked).
                notices.push({ kind: 'record-reset', groupId });
                continue;
            }
            if (accepted.status === 'fork') return accepted;
            return await afterAccept(ctx, groupId, accepted, notices);
        }
        throw new Error('This device’s saved check of the family could not be opened.');
    } catch (error) {
        if (!isNotMember(error)) throw error;
        await wipeGroup(ctx, groupId);
        return { status: 'wiped' };
    }
}

/* Syncs one family, holding its write lock so no tab's roster call runs meanwhile. */
export function syncGroup(ctx: GroupContext, groupId: string, options: { state?: string } = {}) {
    return ctx.lock(groupId, () => syncLocked(ctx, groupId, options));
}

/* Route 2, then every family synced; one family's failure is its own. */
export async function syncAll(
    ctx: GroupContext,
    listed?: Awaited<ReturnType<GroupContext['api']['listGroups']>>['groups'],
) {
    const groups = listed ?? (await ctx.api.listGroups()).groups;
    const out = new Map<string, SyncResult | { status: 'failed'; error: string }>();
    for (const group of groups)
        out.set(
            group.id,
            await syncGroup(ctx, group.id, { state: group.state }).catch((error: unknown) => ({
                status: 'failed' as const,
                error: error instanceof Error ? error.message : 'Please try again.',
            })),
        );
    return out;
}

/* The group key's seal to this holder (route 8), opened so the worker can sign the next roster. */
export async function openGroupKey(ctx: GroupContext, groupId: string) {
    const seal = await ctx.api.keySeal(groupId);
    const sealer = (await fetchIdentities(ctx, groupId)).get(seal.sealerUserId);
    if (!sealer?.identity) throw new Error('HushOS couldn’t load everyone’s keys. Try again.');
    return ctx.rpc('groupOpenSeal', {
        groupId,
        seal,
        sealerMlDsaPublicKey: sealer.identity.mlDsaPublicKey,
        sealerHistory: { served: sealer.identity, links: sealer.links },
    });
}

export type { OpenedArea };

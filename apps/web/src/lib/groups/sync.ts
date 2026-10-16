import type { CryptoResults, GroupView, RosterFork, ServedChain } from '@hushos/crypto';
import { GroupApiError, isNotMember, type MemberIdentity, type ServedRosterPage } from './api';
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
    /* Whether the root was listed under the area's write version (the worker's own check). */
    rootListed: boolean;
};

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
 * Two recoveries, both on the worker's own word:
 * - staged calls whose roster the accepted chain holds (another tab landed
 *   them, or a resend this tab never heard back from) come back as `dropped`;
 *   their outbox rows go only once the record is written, and never the row
 *   of `owner` (a creation, whose seed stays until the settings pin is);
 * - a record that does not open (`record-unreadable`, after a master-key
 *   rotation) is deleted, and the caller starts over without it.
 */
export async function acceptServed(
    ctx: GroupContext,
    groupId: string,
    options: { creating?: string | null; owner?: string | null } = {},
): Promise<Accepted | Fork | { status: 'record-unreadable' }> {
    await ctx.settings.read();
    const row = await ctx.store.chain(ctx.userId, groupId);
    const accept = async (after: number) => {
        const { served } = await fetchServed(ctx, groupId, after);
        return ctx.rpc('groupAccept', {
            userId: ctx.userId,
            groupId,
            served,
            record: row?.envelope ?? null,
            checkedAt: ctx.now().toISOString(),
            creating: options.creating ? { stagedEnvelope: options.creating } : null,
        });
    };
    let result: CryptoResults['groupAccept'];
    try {
        result = await accept(row?.rosterVersion ?? 0);
    } catch (error) {
        // The route's answer is the route's: only the worker's refusal is retried from version 1.
        if (error instanceof GroupApiError || !row || row.rosterVersion === 0) throw error;
        result = await accept(0);
    }
    if (result.status === 'record-unreadable') {
        await ctx.store.deleteChain(ctx.userId, groupId);
        return result;
    }
    if (result.status === 'accepted' && result.record) {
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
                await ctx.rpc('driveOpenNodes', {
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
                state.rootListed = root.parentKeyEpoch === view.areas[area.workspaceId];
            }
        } catch (error) {
            if (isNotMember(error)) throw error;
            state.error = error instanceof Error ? error.message : 'Please try again.';
        }
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
    await ctx.rpc('groupForget', { groupId });
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
export async function syncAll(ctx: GroupContext) {
    const { groups } = await ctx.api.listGroups();
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

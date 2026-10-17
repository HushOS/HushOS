import type {
    CreateGroupBody,
    CryptoResults,
    GroupStageOp,
    GroupWriter,
    RosterCallBody,
} from '@hushos/crypto';
import { MAX_GRANTS_PER_CALL } from '@hushos/groups/protocol';
import { GroupApiError, isNotMember, isRefusal, type ChainHead } from './api';
import type { GroupContext, GroupNotice } from './context';
import {
    fetchIdentities,
    openGroupKey,
    syncGroup,
    syncLocked,
    wipeGroup,
    type SyncResult,
} from './sync';

/*
 * The outbox (F7; docs/groups-design.md 2.4 "Staged chains", the 1c plan
 * section 4, docs/groups-server.md 6). A roster call is signed once, in the
 * worker, on top of a staged chain; its exact body and the staged secrets are
 * sealed into the outbox **before** the first send, and every retry sends
 * those same bytes. Only a definite answer moves the entry on:
 *
 * - landed (201/200, or a resend answered as a replay): the staged chain is
 *   dropped and the family re-synced, so the cache and pins come only from
 *   what the server serves;
 * - a refusal (a 4xx with a code) drops the entry and its staged chain,
 *   except where the table says to fix something and resend the same roster
 *   bytes (`grants-due`, `rotating`, `epoch-stale`, `root-moved`,
 *   `document-stale`);
 * - anything else (no answer, a 5xx, a 4xx without a code, a 401) leaves the
 *   outcome unknown: the entry stays and the same bytes go again, later if
 *   need be; the server answers a resend of what it stored as a replay.
 *
 * `members-changed` and `left-due` are never resent: the membership moved,
 * and the change is rebuilt on top of the new one or not at all. `not-member`
 * is the only answer that wipes the family from this device.
 *
 * An admission is signed and sent when the admin presses "Let them in"
 * (letIn), after checking the newcomer's twelve words; the join code is
 * compared once it has landed, over the stored roster. An entry `awaiting-check`
 * is an earlier version's admission held back until its join code was typed:
 * nothing sends one, ever; the family page drops it (nothing of it reached the
 * server) and says so, and the admin lets the person in again. One tab at a time writes a
 * family's member list (the Web Lock in context.ts).
 */

export type ChainRoute =
    | { kind: 'create' }
    | { kind: 'rosters' }
    | { kind: 'admit'; userId: string }
    | { kind: 'member'; userId: string }
    | { kind: 'remove'; userId: string }
    | { kind: 'areas' }
    | { kind: 'rotation'; workspaceId: string };

export type OutboxEntry = {
    v: 1;
    /* The worker's outbox id: the staged secrets are bound to it. */
    id: string;
    groupId: string;
    route: ChainRoute;
    body: CreateGroupBody | RosterCallBody;
    stagedEnvelope: string;
    /*
     * `committed`: a creation the server stored whose first acceptance has
     * not yet written this device's record and the settings pin. The seed in
     * `stagedEnvelope` is what lets that acceptance vouch for the first keys,
     * so the entry stays until both are written (design 2.4, "Creation").
     * `awaiting-check`: an earlier version's unsent admission, never sent and
     * dropped by the family page (dropHeldBack).
     */
    state: 'awaiting-check' | 'ready' | 'committed';
    attempts: number;
    /*
     * An admission's join code over the staged roster. Never shown: the admin's
     * screen works the code out from the committed chain once the call landed.
     */
    joinCode: { rosterVersion: number; code: string[] } | null;
    /* What the person should hear once the call lands (documents that went on empty). */
    notices?: GroupNotice[];
    /*
     * An admission's newcomer keys as the admin checked them: the fingerprint
     * (over all four keys) of the contact pin the entry was built from. A kept
     * admission is resent by "Let them in" only while the admin's pin still
     * has this fingerprint. Absent on entries from before it was kept.
     */
    admits?: { userId: string; fingerprint: string };
    /*
     * Who the call marks left (a removal's target, the departed it marks):
     * a walk it has to finish first (409 rotating) re-seals their records.
     */
    departing?: string[];
};

export type SendOutcome =
    /* Stored (or a replay of what was): the family was re-synced from what the server serves. */
    | {
          status: 'landed';
          head: ChainHead | null;
          sync: SyncResult | null;
          notices: GroupNotice[];
      }
    /* Another roster won at that version: dropped and re-synced; rebuild only if the intent still holds. */
    | { status: 'stale'; data: unknown }
    /* `members-changed` or `left-due`: dropped, never resent; re-read and rebuild. */
    | { status: 'membership-moved'; code: 'members-changed' | 'left-due'; data: unknown }
    /* Final for these bytes: dropped. `message` is the server's sentence for the person. */
    | { status: 'refused'; code: string; message: string; data: unknown }
    /* Unknown outcome, or a fix this device cannot make now: kept, the same bytes go again later. */
    | { status: 'pending'; reason: string }
    /* An earlier version's held-back admission: never sent. */
    | { status: 'awaiting-check' }
    /*
     * An admission sealed to other keys than the admin's contact pin of the
     * person names now (or kept before its keys were recorded): held, never
     * sent from any path; "Let them in" offers to drop it.
     */
    | { status: 'other-keys' }
    /* `not-member`: the family is gone from this device. */
    | { status: 'wiped' };

/* Resends of an unknown outcome within one send, before the entry waits for the next open. */
export const RESEND_DELAYS_MS = [1_000, 4_000, 15_000];
/* Fixes (grants, rebuilt rotations) within one send before it waits: a target rewriting tags can loop it. */
const MAX_FIXES = 4;

/* ------------------------------------------------------------------------ */
/* The sealed entry                                                          */
/* ------------------------------------------------------------------------ */

async function persist(ctx: GroupContext, entry: OutboxEntry) {
    const { envelope } = await ctx.rpc('groupStoreSeal', {
        userId: ctx.userId,
        groupId: entry.groupId,
        store: 'outbox',
        value: entry,
    });
    await ctx.store.putOutbox({
        id: entry.id,
        userId: ctx.userId,
        groupId: entry.groupId,
        envelope,
    });
}

function isEntry(value: unknown, id: string, groupId: string): value is OutboxEntry {
    const entry = value as OutboxEntry | null;
    return (
        typeof entry === 'object' &&
        entry !== null &&
        entry.v === 1 &&
        entry.id === id &&
        entry.groupId === groupId &&
        typeof entry.stagedEnvelope === 'string' &&
        ['awaiting-check', 'ready', 'committed'].includes(entry.state) &&
        typeof entry.body === 'object' &&
        entry.body !== null
    );
}

/*
 * Every entry of this account (of one group), opened. One the worker cannot
 * open (sealed under an earlier account root, after a master-key rotation)
 * can never be resent: it is deleted, and counted in `lost` so the person is
 * told. A worker that fails for another reason (locked) leaves the rows.
 */
export async function loadOutbox(ctx: GroupContext, groupId?: string) {
    const entries: OutboxEntry[] = [];
    const lost = new Map<string, number>();
    for (const row of await ctx.store.outbox(ctx.userId, groupId)) {
        const opened = await ctx.rpc('groupStoreOpen', {
            userId: ctx.userId,
            groupId: row.groupId,
            store: 'outbox',
            envelope: row.envelope,
        });
        if ('value' in opened && isEntry(opened.value, row.id, row.groupId)) {
            entries.push(opened.value);
            continue;
        }
        await ctx.store.deleteOutbox(row.id);
        lost.set(row.groupId, (lost.get(row.groupId) ?? 0) + 1);
    }
    const notices: GroupNotice[] = [...lost].map(([lostGroup, count]) => ({
        kind: 'changes-lost',
        groupId: lostGroup,
        count,
    }));
    return { entries, notices };
}

/* Canonical JSON (keys sorted at every level), so two bodies compare by content, not key order. */
function canonical(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object')
        return `{${Object.keys(value)
            .sort()
            .map(
                (key) =>
                    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
            )
            .join(',')}}`;
    return JSON.stringify(value) ?? 'undefined';
}

/* Drops an entry for good: its staged chain and secrets in the worker, then the record. */
async function discard(ctx: GroupContext, entry: OutboxEntry) {
    await ctx.rpc('groupDrop', { outboxId: entry.id });
    await ctx.store.deleteOutbox(entry.id);
}

/* ------------------------------------------------------------------------ */
/* Sending                                                                   */
/* ------------------------------------------------------------------------ */

function send(ctx: GroupContext, entry: OutboxEntry): Promise<ChainHead | null> {
    const { groupId, route } = entry;
    const call = entry.body as RosterCallBody;
    switch (route.kind) {
        case 'create':
            return ctx.api.createGroup(entry.body as CreateGroupBody).then(() => null);
        case 'rosters':
            return ctx.api.postRoster(groupId, call);
        case 'admit':
            return ctx.api.admit(groupId, route.userId, call);
        case 'member':
            return ctx.api.patchMember(groupId, route.userId, call);
        case 'remove':
            return ctx.api.removeMember(groupId, route.userId, call);
        case 'areas':
            return ctx.api.createArea(groupId, call);
        case 'rotation':
            return ctx.api.rotateArea(groupId, route.workspaceId, call);
    }
}

/*
 * Grants owed on route 22, from the committed chain: a 409 grants-due's
 * `missing` (then the same bytes go again), or route 3's `due.grants`.
 */
export async function fillGrants(ctx: GroupContext, groupId: string, data: unknown) {
    const missing = (data as { missing?: { workspaceId: string; userId: string }[] } | null)
        ?.missing;
    if (!Array.isArray(missing) || missing.length === 0)
        throw new Error('The server asked for grants without naming them.');
    const identities = await fetchIdentities(ctx, groupId);
    const owed = missing.map((at) => {
        const kemPublicKey = identities.get(at.userId)?.identity?.kemPublicKey;
        if (!kemPublicKey) throw new Error('HushOS couldn’t load everyone’s keys. Try again.');
        return { ...at, kemPublicKey };
    });
    const { grants } = await withCommitted(ctx, groupId, () =>
        ctx.rpc('groupGrants', { groupId, missing: owed }),
    );
    const byArea = new Map<string, typeof grants>();
    for (const grant of grants)
        byArea.set(grant.workspaceId, [...(byArea.get(grant.workspaceId) ?? []), grant]);
    for (const [workspaceId, list] of byArea)
        for (let at = 0; at < list.length; at += MAX_GRANTS_PER_CALL)
            await ctx.api.postGrants(
                groupId,
                workspaceId,
                list.slice(at, at + MAX_GRANTS_PER_CALL),
            );
}

/*
 * Runs a worker step that needs the committed chain (and opened areas); after
 * a reload the worker has none until a sync, so it syncs once and tries again.
 */
async function withCommitted<T>(ctx: GroupContext, groupId: string, work: () => Promise<T>) {
    try {
        return await work();
    } catch (error) {
        if (error instanceof GroupApiError) throw error;
        const synced = await syncLocked(ctx, groupId, { flush: false });
        if (synced.status !== 'accepted') throw error;
        return work();
    }
}

/* The areas a call rotates, from its body. */
function rotatedAreas(body: RosterCallBody) {
    return [...(body.rotations ?? []), ...(body.rotation ? [body.rotation] : [])].map(
        (rotation) => rotation.workspaceId,
    );
}

/* Everything a rebuild may not change: the call but its rotations. */
function signedPart(call: RosterCallBody) {
    const { rotation: _rotation, rotations: _rotations, ...rest } = call;
    return canonical(rest);
}

/*
 * Documents the worker could not open went on empty. The server may have
 * served junk to this device alone, so they are read again once and the
 * rotations rebuilt; whatever still does not open goes on empty, and the
 * person is told.
 */
async function refetchReplaced(
    ctx: GroupContext,
    groupId: string,
    stagedEnvelope: string,
    restaged: { body: RosterCallBody; replaced: { workspaceId: string; kind: string }[] },
) {
    if (restaged.replaced.length === 0 || !ctx.rotations) return restaged;
    const byArea = new Map<string, Set<string>>();
    for (const { workspaceId, kind } of restaged.replaced)
        byArea.set(workspaceId, (byArea.get(workspaceId) ?? new Set()).add(kind));
    const areas = [...byArea].map(([workspaceId, kinds]) => ({ workspaceId, kinds: [...kinds] }));
    const rotations = await ctx.rotations.read(groupId, areas);
    const writers = await ctx.rotations.writers(groupId);
    return withCommitted(ctx, groupId, () =>
        ctx.rpc('groupRestage', {
            groupId,
            stagedEnvelope,
            body: restaged.body,
            rebuild: { rotations, writers },
        }),
    );
}

const cleared = (replaced: { workspaceId: string; kind: string }[]): GroupNotice[] =>
    replaced.map(({ workspaceId, kind }) => ({
        kind: 'documents-cleared',
        workspaceId,
        document: kind,
    }));

/*
 * Rebuilds the rotation parts of an entry (same roster, same area and root
 * keys, read again from Drive) and keeps the new body before it is sent.
 * Everything else in the call must come back byte for byte the same, or
 * nothing is kept and nothing sent. Returns false when this device cannot
 * (no rotation source yet).
 */
async function rebuild(
    ctx: GroupContext,
    entry: OutboxEntry,
    areas: { workspaceId: string; kinds: string[] }[],
): Promise<boolean> {
    if (!ctx.rotations || entry.route.kind === 'create') return false;
    // A removal's hold lasts 15 minutes and a walk can outlast it: placed again (which extends it)
    // before the folders are read again, so the person can't draw an epoch above the new target.
    await renewOrStop(ctx, entry);
    const body = entry.body as RosterCallBody;
    const rotations = await ctx.rotations.read(entry.groupId, areas);
    const writers: GroupWriter[] = await ctx.rotations.writers(entry.groupId);
    const first = await withCommitted(ctx, entry.groupId, () =>
        ctx.rpc('groupRestage', {
            groupId: entry.groupId,
            stagedEnvelope: entry.stagedEnvelope,
            body,
            rebuild: { rotations, writers },
        }),
    );
    const restaged = await refetchReplaced(ctx, entry.groupId, entry.stagedEnvelope, first);
    // The roster, the succession, the seals, the grants and the rest are the signed call.
    if (signedPart(restaged.body) !== signedPart(body))
        throw new Error('A rebuilt change must keep its member list.');
    entry.body = restaged.body;
    entry.notices = [...(entry.notices ?? []), ...cleared(restaged.replaced)];
    await persist(ctx, entry);
    return true;
}

/*
 * Places a removal's hold again (route 27 extends a live one), before the
 * folders are read for the call. A refusal is returned for the caller to say
 * (a removal stops on it: this manager was paused, or the person is gone);
 * not-member throws, as everywhere.
 */
export async function renewHold(
    ctx: GroupContext,
    groupId: string,
    userId: string,
): Promise<GroupApiError | null> {
    try {
        await ctx.api.hold(groupId, userId);
        return null;
    } catch (error) {
        if (isNotMember(error) || !(error instanceof GroupApiError)) throw error;
        return error;
    }
}

/* A removal's hold placed again, or the reason it could not be, thrown for the caller to say. */
async function renewOrStop(ctx: GroupContext, entry: OutboxEntry) {
    if (entry.route.kind !== 'remove') return;
    const refused = await renewHold(ctx, entry.groupId, entry.route.userId);
    if (refused) throw refused;
}

/* The staged-stale data of 409 document-stale, by area: every kind it named. */
function staleDocuments(data: unknown) {
    const stale = (data as { stale?: { workspaceId: string; kind: string }[] } | null)?.stale;
    const first = data as { workspaceId?: string; kind?: string } | null;
    const list =
        Array.isArray(stale) && stale.length > 0
            ? stale
            : first?.workspaceId && first.kind
              ? [{ workspaceId: first.workspaceId, kind: first.kind }]
              : [];
    const byArea = new Map<string, Set<string>>();
    for (const { workspaceId, kind } of list)
        byArea.set(workspaceId, (byArea.get(workspaceId) ?? new Set()).add(kind));
    return [...byArea].map(([workspaceId, kinds]) => ({ workspaceId, kinds: [...kinds].sort() }));
}

/* What a landed call leaves: the staged chain dropped first, then the family synced from what is served. */
async function landed(
    ctx: GroupContext,
    entry: OutboxEntry,
    head: ChainHead | null,
    mode: SendMode,
): Promise<SendOutcome> {
    if (entry.route.kind === 'create') {
        entry.state = 'committed';
        await persist(ctx, entry);
        await ctx.rpc('groupDrop', { outboxId: entry.id });
        return finishCreation(ctx, entry);
    }
    await discard(ctx, entry);
    const sync = mode.inSync
        ? null
        : await syncLocked(ctx, entry.groupId, { flush: false }).catch(() => null);
    return { status: 'landed', head, sync, notices: entry.notices ?? [] };
}

/*
 * A creation the server stored: the first committed acceptance, vouched for
 * by this device's own seed while nothing else marks the family, writes the
 * record and the settings pin; only then does the entry, and the seed in it,
 * go. Interrupted anywhere, the entry stays `committed` and the next open
 * finishes it.
 */
async function finishCreation(ctx: GroupContext, entry: OutboxEntry): Promise<SendOutcome> {
    let sync: SyncResult;
    try {
        sync = await syncLocked(ctx, entry.groupId, {
            creating: entry.stagedEnvelope,
            owner: entry.id,
            flush: false,
        });
    } catch (error) {
        return {
            status: 'pending',
            reason: error instanceof Error ? error.message : 'Please try again.',
        };
    }
    if (sync.status === 'wiped') return { status: 'wiped' };
    if (sync.status !== 'accepted' || !sync.pinSaved)
        return { status: 'pending', reason: 'The family isn’t checked on this device yet.' };
    await ctx.store.deleteOutbox(entry.id);
    return { status: 'landed', head: null, sync, notices: entry.notices ?? [] };
}

/* `inSync`: sent once from a sync, which accepts right after: no resends, no sync of its own. */
type SendMode = { inSync?: boolean };

async function sendLocked(
    ctx: GroupContext,
    entry: OutboxEntry,
    mode: SendMode = {},
): Promise<SendOutcome> {
    if (entry.state === 'awaiting-check') return { status: 'awaiting-check' };
    // An admission goes only to the keys the admin's pin of the person holds now: resent after
    // their account changed and was checked again, it would grant the family's folders to the
    // old keys. Checked here, so a page open, a sync and "Let them in" all obey it.
    if (entry.route.kind === 'admit') {
        const { settings } = await ctx.settings.read();
        const pin = settings.contacts?.[entry.route.userId];
        if (!entry.admits || !pin || pin.fingerprint !== entry.admits.fingerprint)
            return { status: 'other-keys' };
    }
    // Kept before anything leaves this device: a send that dies midway is resent, never re-signed.
    await persist(ctx, entry);
    if (entry.state === 'committed') return finishCreation(ctx, entry);
    let resends = 0;
    let fixes = 0;
    for (;;) {
        let head: ChainHead | null;
        try {
            head = await send(ctx, entry);
        } catch (error) {
            if (!(error instanceof GroupApiError)) throw error;
            if (isNotMember(error)) {
                await wipeGroup(ctx, entry.groupId);
                return { status: 'wiped' };
            }
            if (!isRefusal(error)) {
                // Unknown: the same bytes again, a few times now, then at the next open.
                entry.attempts++;
                await persist(ctx, entry);
                const delay = mode.inSync ? undefined : RESEND_DELAYS_MS[resends++];
                if (delay === undefined) return { status: 'pending', reason: error.message };
                await ctx.sleep(delay);
                continue;
            }
            const answer = await refused(ctx, entry, error, fixes++, mode);
            if (answer) return answer;
            continue;
        }
        return landed(ctx, entry, head, mode);
    }
}

/*
 * One refusal: either a fix and another round with the same roster bytes
 * (null), or the outcome. Every outcome but `pending` has dropped the entry.
 */
async function refused(
    ctx: GroupContext,
    entry: OutboxEntry,
    error: GroupApiError & { code: string },
    fixes: number,
    mode: SendMode,
): Promise<SendOutcome | null> {
    const { groupId } = entry;
    const resync = () =>
        mode.inSync ? null : syncLocked(ctx, groupId, { flush: false }).catch(() => null);
    // A creation resent after an unknown outcome may already be stored: a server that checks the
    // resend before it sees the replay refuses it. Finish it first if it landed, before the seed goes.
    if (entry.route.kind === 'create' && entry.attempts > 0) {
        // As a landed creation: the staged chain goes first, the seed stays in the entry.
        await ctx.rpc('groupDrop', { outboxId: entry.id });
        const finished = await finishCreation(ctx, entry);
        if (finished.status === 'landed' || finished.status === 'pending') return finished;
    }
    const final = async (): Promise<SendOutcome> => {
        await discard(ctx, entry);
        return { status: 'refused', code: error.code, message: error.message, data: error.data };
    };
    const tooMany = fixes >= MAX_FIXES;
    switch (error.code) {
        case 'grants-due':
            if (tooMany) return { status: 'pending', reason: error.message };
            await fillGrants(ctx, groupId, error.data);
            return null;
        case 'rotating': {
            if (tooMany || !ctx.rotations) return { status: 'pending', reason: error.message };
            const data = error.data as {
                workspaceId: string;
                rotationId: string;
                nodeId: string;
                targetEpoch: number;
            } | null;
            // Walking re-signs records as the walker: only a rotation of a folder this call rotates.
            if (!data || !rotatedAreas(entry.body as RosterCallBody).includes(data.workspaceId))
                return {
                    status: 'pending',
                    reason: 'The server named a folder this change does not rotate.',
                };
            // Judged with everyone this call marks left as on their way out (their records are
            // re-sealed, never re-signed as this manager's own), and the hold placed again first.
            await renewOrStop(ctx, entry);
            await ctx.rotations.finish(groupId, data, entry.departing ?? []);
            return (await rebuild(ctx, entry, [{ workspaceId: data.workspaceId, kinds: [] }]))
                ? null
                : { status: 'pending', reason: error.message };
        }
        case 'epoch-stale':
        case 'root-moved': {
            if (tooMany) return { status: 'pending', reason: error.message };
            const areas = rotatedAreas(entry.body as RosterCallBody).map((workspaceId) => ({
                workspaceId,
                kinds: [],
            }));
            return (await rebuild(ctx, entry, areas))
                ? null
                : { status: 'pending', reason: error.message };
        }
        case 'document-stale': {
            if (tooMany) return { status: 'pending', reason: error.message };
            const named = staleDocuments(error.data);
            if (named.length === 0) return final();
            const rotated = rotatedAreas(entry.body as RosterCallBody);
            if (named.some((area) => !rotated.includes(area.workspaceId)))
                return {
                    status: 'pending',
                    reason: 'The server named a folder this change does not rotate.',
                };
            return (await rebuild(ctx, entry, named))
                ? null
                : { status: 'pending', reason: error.message };
        }
        case 'stale':
            await discard(ctx, entry);
            await resync();
            return { status: 'stale', data: error.data };
        case 'members-changed':
        case 'left-due':
            await discard(ctx, entry);
            await resync();
            return { status: 'membership-moved', code: error.code, data: error.data };
        case 'forbidden': {
            const outcome = await final();
            await resync();
            return outcome;
        }
        default:
            // held, seats, area-limit, group-limit, invalid, succession-due, unsupported,
            // root-mid-rotation, too-large and the rest: final for these bytes.
            return final();
    }
}

/*
 * Sends one outbox entry under the group's write lock, acting on every
 * answer as the table above says. An earlier version's admission awaiting
 * its check is never sent.
 */
export function sendChainCall(ctx: GroupContext, entry: OutboxEntry): Promise<SendOutcome> {
    return ctx.lock(entry.groupId, () => sendLocked(ctx, entry));
}

/*
 * At every open: whatever the outbox holds is sent again as it is, and a
 * creation committed but not yet pinned is finished. An earlier version's
 * admission awaiting its check is never sent; the family page drops it.
 */
export async function resumeOutbox(ctx: GroupContext) {
    const outcomes = new Map<string, SendOutcome>();
    const { entries, notices } = await loadOutbox(ctx);
    for (const entry of entries) {
        if (entry.state === 'awaiting-check') continue;
        outcomes.set(entry.id, await sendChainCall(ctx, entry));
    }
    return { outcomes, notices };
}

/*
 * The family page, at each open: an earlier version's admissions held back
 * until their join code was typed are dropped, never sent (nothing of them
 * reached the server), each with a notice naming the person, who is let in
 * again. Only here, so the page that can name them is the one that says so.
 */
export async function dropHeldBack(ctx: GroupContext, groupId: string): Promise<GroupNotice[]> {
    const notices: GroupNotice[] = [];
    for (const entry of (await loadOutbox(ctx, groupId)).entries) {
        if (entry.state !== 'awaiting-check' || entry.route.kind !== 'admit') continue;
        const { userId } = entry.route;
        await ctx.lock(groupId, () => discard(ctx, entry));
        notices.push({ kind: 'admission-dropped', groupId, userId });
    }
    return notices;
}

/*
 * From a sync, under its lock and before it accepts: this group's ready calls
 * go once more as they were signed. A call another tab or an earlier attempt
 * landed answers as a replay and is dropped here, staged chain and all, so
 * acceptance never meets this device's own staged roster among the served
 * ones it has not let go of. Creations are left to resumeOutbox, and an
 * earlier version's held-back admission is never sent.
 */
export async function flushOutbox(ctx: GroupContext, groupId: string) {
    const { entries, notices } = await loadOutbox(ctx, groupId);
    for (const entry of entries) {
        if (entry.state !== 'ready' || entry.route.kind === 'create') continue;
        const outcome = await sendLocked(ctx, entry, { inSync: true });
        if (outcome.status === 'wiped') return { wiped: true, notices };
        if (outcome.status === 'landed') notices.push(...outcome.notices);
    }
    return { wiped: false, notices };
}

/* ------------------------------------------------------------------------ */
/* Making calls                                                              */
/* ------------------------------------------------------------------------ */

const ROUTES: Record<GroupStageOp['kind'], (op: GroupStageOp) => ChainRoute> = {
    admit: (op) => ({ kind: 'admit', userId: (op as { userId: string }).userId }),
    remove: (op) => ({ kind: 'remove', userId: (op as { userId: string }).userId }),
    roles: (op) => ({ kind: 'member', userId: (op as { userId: string }).userId }),
    markLeft: () => ({ kind: 'rosters' }),
    foldIn: () => ({ kind: 'rosters' }),
    area: () => ({ kind: 'areas' }),
    rotate: (op) => ({
        kind: 'rotation',
        workspaceId: (op as Extract<GroupStageOp, { kind: 'rotate' }>).rotation.workspaceId,
    }),
};

/* A new family: staged in the worker, kept, then sent (route 1). */
export async function createFamily(ctx: GroupContext, name: string, areaName?: string) {
    // The settings first: settings that hold no family pin (none opened here) stop it before
    // anything is made, rather than leave a family on the server this device can't check.
    await ctx.settings.read();
    const identities = await ctx.identities();
    const created = await ctx.rpc('groupCreate', {
        userId: ctx.userId,
        name,
        ...(areaName ? { areaName } : {}),
        identities,
    });
    const entry: OutboxEntry = {
        v: 1,
        id: created.outboxId,
        groupId: created.groupId,
        route: { kind: 'create' },
        body: created.body,
        stagedEnvelope: created.stagedEnvelope,
        state: 'ready',
        attempts: 0,
        joinCode: null,
    };
    return { groupId: created.groupId, outcome: await sendChainCall(ctx, entry) };
}

export type StageOutcome =
    | { status: 'sent'; entry: OutboxEntry; outcome: SendOutcome; needsCheck: string[] }
    /*
     * A kept admission (sent before, no answer yet) sealed to other keys than
     * the admin's pin of the person names now (they changed, and were checked
     * again): never resent from here. dropKeptAdmission, then letIn again.
     */
    | { status: 'kept-other-keys'; entry: OutboxEntry }
    /* Nothing to sign (a fold-in where no chain reaches the served keys). */
    | { status: 'nothing'; needsCheck: string[] }
    | { status: 'not-synced'; sync: SyncResult };

/*
 * Stages one change on the committed chain, keeps it, then sends it. The
 * family is synced first under the same lock, so the call builds on the head
 * the server has.
 */
export function stageChange(
    ctx: GroupContext,
    groupId: string,
    op: GroupStageOp,
    options: { writers?: GroupWriter[] } = {},
): Promise<StageOutcome> {
    return ctx.lock(groupId, () => stageLocked(ctx, groupId, op, options));
}

async function stageLocked(
    ctx: GroupContext,
    groupId: string,
    op: GroupStageOp,
    options: { writers?: GroupWriter[] },
): Promise<StageOutcome> {
    const sync = await syncLocked(ctx, groupId);
    if (sync.status !== 'accepted') return { status: 'not-synced', sync };
    const detail = await ctx.api.group(groupId);
    if (detail.head.version !== sync.view.rosterVersion) return { status: 'not-synced', sync };
    await openGroupKey(ctx, groupId);
    const identities = await fetchIdentities(ctx, groupId);
    const kems: Record<string, string> = {};
    for (const [userId, member] of identities)
        if (member.identity) kems[userId] = member.identity.kemPublicKey;
    const staged: CryptoResults['groupStage'] = await ctx.rpc('groupStage', {
        groupId,
        expectedRevision: detail.head.revision,
        op,
        kems,
        ...(options.writers ? { writers: options.writers } : {}),
    });
    if (staged.outboxId === null) return { status: 'nothing', needsCheck: staged.needsCheck };
    const checked = await refetchReplaced(ctx, groupId, staged.stagedEnvelope, staged);
    if (signedPart(checked.body) !== signedPart(staged.body))
        throw new Error('A rebuilt change must keep its member list.');
    const entry: OutboxEntry = {
        v: 1,
        id: staged.outboxId,
        groupId,
        route: ROUTES[op.kind](op),
        body: checked.body,
        stagedEnvelope: staged.stagedEnvelope,
        state: 'ready',
        attempts: 0,
        joinCode: staged.joinCode,
        notices: cleared(checked.replaced),
        ...(op.kind === 'admit'
            ? { admits: { userId: op.userId, fingerprint: op.pin.fingerprint } }
            : {}),
        ...(op.kind === 'remove'
            ? { departing: [op.userId] }
            : op.kind === 'markLeft'
              ? { departing: [...op.userIds] }
              : {}),
    };
    return {
        status: 'sent',
        entry,
        outcome: await sendLocked(ctx, entry),
        needsCheck: staged.needsCheck,
    };
}

/*
 * "Let them in", once the admin checked the newcomer's twelve words: an
 * admission this device already keeps for them (sent before, with no answer
 * yet) goes again as it was signed, as every kept call does; otherwise one is
 * staged on the committed chain and sent, unless it was sealed to other keys
 * than the admin's pin of them names now (`kept-other-keys`). An earlier
 * version's held-back admission for them is dropped first, never sent. A `stale` answer has
 * dropped the call and synced: the caller lets them in again, over the new
 * head.
 */
export function letIn(
    ctx: GroupContext,
    groupId: string,
    op: Extract<GroupStageOp, { kind: 'admit' }>,
): Promise<StageOutcome> {
    return ctx.lock(groupId, async () => {
        const kept = (await loadOutbox(ctx, groupId)).entries.filter(
            (entry) => entry.route.kind === 'admit' && entry.route.userId === op.userId,
        );
        for (const entry of kept) {
            if (entry.state === 'awaiting-check') {
                await discard(ctx, entry);
                continue;
            }
            // Sealed to keys the admin no longer holds as checked: resending would grant the
            // family's folders to them. The admin drops it first, knowingly.
            if (entry.admits?.fingerprint !== op.pin.fingerprint)
                return { status: 'kept-other-keys' as const, entry };
            return {
                status: 'sent' as const,
                entry,
                outcome: await sendLocked(ctx, entry),
                needsCheck: [],
            };
        }
        return stageLocked(ctx, groupId, op, {});
    });
}

/*
 * A kept admission the admin chose to drop (`kept-other-keys`), read again
 * under the lock so only that very entry goes. The caller makes sure the
 * person is still waiting to join (route 4 lists them), so it never landed:
 * a call the server stored would have let them in.
 */
export function dropKeptAdmission(ctx: GroupContext, entry: OutboxEntry) {
    return ctx.lock(entry.groupId, async () => {
        const current = (await loadOutbox(ctx, entry.groupId)).entries.find(
            (at) => at.id === entry.id,
        );
        if (current?.route.kind === 'admit') await discard(ctx, current);
    });
}

/*
 * 409 left-due, or route 3's `due.markLeft`: the departed are marked left on
 * route 7 first, rotating every family folder (a family roster that marks
 * anyone left must), and with the succession when one held `members`. The
 * change that met left-due is then rebuilt by its own flow, never resent.
 */
export async function markDepartedLeft(ctx: GroupContext, groupId: string, userIds: string[]) {
    if (!ctx.rotations) throw new Error('Open the family’s folders first, then try again.');
    const sync = await syncGroup(ctx, groupId);
    if (sync.status !== 'accepted') return { status: 'not-synced' as const, sync };
    const areas = Object.keys(sync.view.areas).map((workspaceId) => ({ workspaceId, kinds: [] }));
    const rotations = await ctx.rotations.read(groupId, areas);
    const writers = await ctx.rotations.writers(groupId);
    return stageChange(ctx, groupId, { kind: 'markLeft', userIds, rotations }, { writers });
}

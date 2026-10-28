import type { RosterFork, ServedChain } from '@hushos/crypto';
import type { GroupContext } from './context';
import {
    afterAccept,
    fetchServed,
    forgetInWorker,
    heldGuard,
    keepGuard,
    syncGroup,
    syncLocked,
    type SyncResult,
} from './sync';

/*
 * Joining a family (docs/optional-verification.md 3.2 and 3.3): the
 * newcomer's side. **The only module that may pass `joining` to groupAccept**
 * (F1; join-only.test.ts fails on any other). The rules are the crypto
 * worker's (session-groups.ts, the twin of the Rust core's join.rs, which the
 * phones run): this module only fetches, stores and says what happened.
 *
 * 1. Invite, accept: the newcomer waits. Nothing happens on this device until
 *    route 2 says they were let in.
 * 2. On the next look, the newcomer's device joins on first use: the worker
 *    verifies what route 5 serves from version 1, against every mark this
 *    device and account hold (a rejoin's settings pin, the family guard that
 *    a `not-member` answer never clears); with none at all, over the served
 *    version 1 keys, only while this account's entry is active at the head
 *    and only with settings that opened here. Nothing is committed: the
 *    worker seals a version 4 joins record of the head's pin, kept here
 *    before anything else.
 * 3. groupAccept with that record (`joining`) commits, holding its pin as one
 *    more mark, so a reload in between finishes against the same history
 *    rather than taking first use again over whatever is served then. Then
 *    the family guard, the device record, the folders and the settings pin
 *    are written, in that order, and the joins record goes.
 *
 * From then on the pin, the cache and the guard are marks: a fork, a
 * rollback, another family key at a pinned version or a removal withheld past
 * them are caught as for any member. Checking each other later (3.4) is the
 * family check, from the members list. A version 3 joins record (a join code
 * compared on the release before this one, mid-join) still finishes as it
 * would have; one that no longer holds goes, and the join is a first use.
 */

/* Acceptance with the joins record the worker sealed, beside every mark this device and account hold. */
async function acceptJoining(
    ctx: GroupContext,
    groupId: string,
    served: ServedChain,
    joinsRecord: string,
) {
    await ctx.settings.read();
    const began = ctx.session?.();
    for (;;) {
        const record = (await ctx.store.chain(ctx.userId, groupId))?.envelope ?? null;
        const result = await ctx.rpc('groupAccept', {
            userId: ctx.userId,
            groupId,
            served,
            record,
            // The joins record's own check time is the pin's (the worker takes it from there).
            checkedAt: ctx.now().toISOString(),
            joining: { joinsRecord },
            guard: await heldGuard(ctx, groupId),
        });
        if (result.status !== 'record-unreadable') return { result, began };
        await ctx.store.deleteChain(ctx.userId, groupId);
    }
}

async function admitted(ctx: GroupContext, groupId: string) {
    const { groups } = await ctx.api.listGroups();
    return groups.find((group) => group.id === groupId)?.state === 'active';
}

export type JoinOutcome =
    | { status: 'joined'; sync: Extract<SyncResult, { status: 'accepted' }> }
    /* Not let in yet: route 2 is polled until the state is active. */
    | { status: 'waiting' }
    /* This person's own marks disagree with what is served: the hard warning. */
    | { status: 'fork'; fork: RosterFork };

/*
 * Where this device's join stands, for the page to resume at: waiting to be
 * let in, joined now (on first use, or a join a reload cut short, finished
 * here), or `member` when this device already holds the family.
 */
export async function joinStatus(
    ctx: GroupContext,
    groupId: string,
): Promise<JoinOutcome | { status: 'member' }> {
    if (!(await admitted(ctx, groupId))) return { status: 'waiting' };
    const joinsRecord = (await ctx.store.join(ctx.userId, groupId))?.envelope ?? null;
    // Kept before acceptance: a reload finishes from it.
    if (joinsRecord) return completeJoin(ctx, groupId, joinsRecord);
    if (await ctx.store.chain(ctx.userId, groupId)) return { status: 'member' };
    return joinOnFirstUse(ctx, groupId);
}

/*
 * An earlier finish wrote the device record and then failed to save the pin:
 * that record is a mark now, so this is a sync (which saves the pin), and the
 * joins record goes. Null when there is no record, or it did not open.
 */
async function finishedBefore(ctx: GroupContext, groupId: string): Promise<JoinOutcome | null> {
    if (!(await ctx.store.chain(ctx.userId, groupId))) {
        await letGoOfUnkept(ctx, groupId);
        return null;
    }
    const synced = await syncLocked(ctx, groupId, { flush: false });
    if (synced.status === 'accepted') {
        await ctx.store.deleteJoin(ctx.userId, groupId);
        return { status: 'joined', sync: synced };
    }
    if (synced.status === 'fork') return synced;
    if (synced.status !== 'unchecked') return { status: 'waiting' };
    // A record that did not open and no pin: the join goes on.
    return null;
}

/*
 * A join this session committed but couldn't keep on the device: its guard
 * wasn't stored, and nor was the one letting go of it handed back (acceptJoin),
 * so the worker still holds the chain as a floor, and the joins record as
 * used. With no device record, nothing else of the family is the worker's to
 * hold, so it lets go now, storing the guard it hands back first (2.8). Then
 * the join runs again from a clean session. While the guard still can't be
 * stored, that error is the answer and nothing is retried.
 */
async function letGoOfUnkept(ctx: GroupContext, groupId: string) {
    if (!(await forgetInWorker(ctx, groupId)))
        throw new Error('The family could not be checked. Try again.');
}

/* The first-use join (groupJoinFirstUse), then its commit. */
async function joinOnFirstUse(ctx: GroupContext, groupId: string): Promise<JoinOutcome> {
    await ctx.settings.read();
    return ctx.lock(groupId, async (): Promise<JoinOutcome> => {
        const before = await finishedBefore(ctx, groupId);
        if (before) return before;
        const { served } = await fetchServed(ctx, groupId, 0);
        for (;;) {
            const record = (await ctx.store.chain(ctx.userId, groupId))?.envelope ?? null;
            const joined = await ctx.rpc('groupJoinFirstUse', {
                userId: ctx.userId,
                groupId,
                served,
                record,
                guard: await heldGuard(ctx, groupId),
                now: ctx.now().toISOString(),
            });
            switch (joined.status) {
                case 'record-unreadable':
                    await ctx.store.deleteChain(ctx.userId, groupId);
                    continue;
                case 'not-admitted':
                    // Active on route 2 but not on the member list it serves yet: still waiting.
                    return { status: 'waiting' };
                case 'fork':
                    return { status: 'fork', fork: joined.fork };
                case 'first-use':
                    // Kept before acceptance: a reload between the two finishes from here.
                    await ctx.store.putJoin({
                        userId: ctx.userId,
                        groupId,
                        envelope: joined.joinsRecord,
                    });
                    // The same served chain the record was just sealed over.
                    return acceptJoin(ctx, groupId, served, joined.joinsRecord);
            }
        }
    });
}

/* A reload finishing a join: from the joins record, against what route 5 serves now. */
async function completeJoin(
    ctx: GroupContext,
    groupId: string,
    joinsRecord: string,
): Promise<JoinOutcome> {
    await ctx.settings.read();
    return ctx.lock(groupId, async (): Promise<JoinOutcome> => {
        const before = await finishedBefore(ctx, groupId);
        if (before) return before;
        const { served } = await fetchServed(ctx, groupId, 0);
        return acceptJoin(ctx, groupId, served, joinsRecord, { orFirstUse: true });
    });
}

async function acceptJoin(
    ctx: GroupContext,
    groupId: string,
    served: ServedChain,
    joinsRecord: string,
    options: { orFirstUse?: boolean } = {},
): Promise<JoinOutcome> {
    const { result, began } = await acceptJoining(ctx, groupId, served, joinsRecord);
    switch (result.status) {
        case 'join-unreadable':
        case 'changed':
            // Sealed under an earlier account root, or an earlier release's join code that no longer
            // holds: it vouches for nothing here, and goes. A join from a kept record starts over
            // on first use; one sealed just now is the worker's to explain.
            await ctx.store.deleteJoin(ctx.userId, groupId);
            if (options.orFirstUse) return joinOnFirstUseLocked(ctx, groupId, served);
            throw new Error('The family could not be checked. Try again.');
        case 'not-admitted':
            return { status: 'waiting' };
        case 'fork':
            return { status: 'fork', fork: result.fork };
        case 'accepted':
            break;
    }
    try {
        if (!result.record) throw new Error('The family could not be checked. Try again.');
        // The guard before the record (docs/optional-verification.md 2.8): a crash between the
        // two leaves the guard above the record, never below it.
        await keepGuard(ctx, groupId, result.guard, began);
        await ctx.store.putChain({
            userId: ctx.userId,
            groupId,
            envelope: result.record,
            rosterVersion: result.view.rosterVersion,
            areas: Object.keys(result.view.areas),
        });
    } catch (error) {
        // Committed in the worker but not kept on the device: the worker lets go of it too,
        // or its chain would count as a mark this device cannot show, and a retry be refused.
        // A wipe the worker refuses (GUARD_CONFLICT) keeps its floor; the store's error is the answer.
        await forgetInWorker(ctx, groupId).catch(() => false);
        throw error;
    }
    const sync = await afterAccept(ctx, groupId, result);
    if (sync.status === 'fork') return sync;
    await ctx.store.deleteJoin(ctx.userId, groupId);
    return { status: 'joined', sync };
}

/* The first-use join over `served`, for a caller already holding the family's lock. */
async function joinOnFirstUseLocked(
    ctx: GroupContext,
    groupId: string,
    served: ServedChain,
): Promise<JoinOutcome> {
    const joined = await ctx.rpc('groupJoinFirstUse', {
        userId: ctx.userId,
        groupId,
        served,
        record: (await ctx.store.chain(ctx.userId, groupId))?.envelope ?? null,
        guard: await heldGuard(ctx, groupId),
        now: ctx.now().toISOString(),
    });
    if (joined.status === 'not-admitted') return { status: 'waiting' };
    if (joined.status === 'fork') return { status: 'fork', fork: joined.fork };
    if (joined.status === 'record-unreadable') {
        await ctx.store.deleteChain(ctx.userId, groupId);
        throw new Error('This device’s saved check of the family could not be opened. Try again.');
    }
    await ctx.store.putJoin({ userId: ctx.userId, groupId, envelope: joined.joinsRecord });
    return acceptJoin(ctx, groupId, served, joined.joinsRecord);
}

/* The worker's sentences for a committed chain that is missing, or does not have them yet. */
const NOT_SYNCED = /Check the family’s member list first|not in the family’s member list yet/;

/*
 * The older-app path (docs/optional-verification.md 3.4 "Older apps", 6.10):
 * the join code an iOS 0.10.0 phone compares, worked out over this device's
 * committed chain for the roster that let `userId` in. Strictly one way:
 * nothing is saved on this device from it (no pin, no check record, no
 * Verified label), since 0.10.0 matches that code before checking its own
 * entry, so its match proves nothing about the keys there. A committed chain
 * that does not have them yet (the sync after "Let them in" did not finish)
 * is synced once first.
 */
export async function memberJoinCode(ctx: GroupContext, groupId: string, userId: string) {
    const code = async () => {
        const { served } = await fetchServed(ctx, groupId, 0);
        return ctx.rpc('groupJoinCode', { groupId, userId, rosters: served.rosters });
    };
    try {
        return await code();
    } catch (error) {
        // Only the worker saying its committed chain doesn't have them (or none is open) is
        // put right by a sync; anything else is the answer.
        if (!(error instanceof Error) || !NOT_SYNCED.test(error.message)) throw error;
        const synced = await syncGroup(ctx, groupId);
        if (synced.status === 'fork')
            throw new Error('This family looks different on this device. Try again later.');
        return code();
    }
}

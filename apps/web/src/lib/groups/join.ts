import type { CryptoResults, JoinMark, RosterFork, ServedChain } from '@hushos/crypto';
import { HOLDS_UNREADABLE, NOT_SHOWN } from '@hushos/crypto/join-session';
import type { GroupContext } from './context';
import {
    afterAccept,
    fetchServed,
    forgetInWorker,
    syncGroup,
    syncLocked,
    type SyncResult,
} from './sync';

/*
 * Joining a family (docs/groups-design.md 2.4 and 3.2): the newcomer's side,
 * and the join code both screens show. **The only module that may pass
 * `joining` to groupAccept** (F1; join-only.test.ts fails on any other). The
 * rules are the crypto worker's (session-groups.ts and join-session.ts, the
 * twins of the Rust core's join.rs, which the phones run): this module only
 * fetches, stores and says what happened.
 *
 * 1. The newcomer reads their twelve words to the admin, who checks them and
 *    lets them in (the admin's dialog). Nothing happens on this device.
 * 2. joinStatus, once route 2 says active: the code of the roster that let
 *    this account in, worked out over what route 5 serves (groupJoinPreview),
 *    with two positions the worker drew for this showing, anew each time
 *    unless a wrong pair holds them. The page hides those two words. Nothing
 *    is kept, marked or committed, and the positions never leave this device.
 * 3. confirmJoin, "They match": the person typed the two hidden words as the
 *    admin read them. The worker (groupJoinCheck) works the code out again
 *    over what route 5 serves now: another code keeps nothing and is the new
 *    one to compare. Then the typed words against the code at the positions
 *    it issued. The family's first wrong pair is said calmly ('wrong-words')
 *    and holds that code's positions; any later wrong pair for the family is
 *    the alarm ('mismatch'), whatever code is showing. A code's positions are
 *    drawn when it is first shown and stay until a match. What a wrong pair
 *    leaves comes back from the worker sealed (`holds`) and is kept in
 *    IndexedDB beside the joins record, and handed back on every showing, so
 *    a reload or a lock asks the same two words and keeps the alarm.
 *    On a match the worker seals the joins record (only it writes the joins
 *    store), which is kept before acceptance; groupAccept takes the family
 *    with it, once, and only while the served chain still gives the code.
 *    Then the device record, the folders and the settings pin are written;
 *    the joins record goes.
 *
 * The two typed words are what makes the admin's screen necessary: the
 * server decides when route 2 says active, and could show a code over a
 * family it made up the moment it does; comparing alone could then be done
 * by a person who never waited for the admin. Typing two words only the
 * admin's screen shows cannot: guessing them is 22 bits, at positions the
 * server does not know. A wrong pair is said as one of the two being wrong,
 * never which, so the words never fall one at a time. That holds against
 * finishing alone; against a server grinding a made-up family whose code
 * matches the admin's in the words a person who compares nothing would skip,
 * the ten compared words are the defence, only as good as the comparing.
 *
 * "They don't match" keeps nothing either; the page says what to do. The
 * joins record exists only between "They match" and the end of the join, so
 * a reload in between finishes it without asking again, and only while the
 * served chain still gives the code that was compared.
 */

/* The two hidden words as the person typed them, in the order of the issued positions. */
export type HiddenWords = readonly string[];

/*
 * The worker's sealed escalation for a family, kept in IndexedDB beside the
 * joins record (store.ts, `holds`). Saving it can fail (storage refused): the
 * worker still holds it for the page. It is deleted only when a check hands
 * back none, or when the worker says it does not open here.
 */
async function keptHolds(ctx: GroupContext, groupId: string) {
    return (await ctx.store.holds(ctx.userId, groupId))?.envelope ?? null;
}
async function keepHolds(ctx: GroupContext, groupId: string, holds: string | null) {
    try {
        if (holds) await ctx.store.putHolds({ userId: ctx.userId, groupId, envelope: holds });
        else await ctx.store.deleteHolds(ctx.userId, groupId);
    } catch (error) {
        // Storage refused: held for as long as the worker. A delete that failed leaves an older
        // escalation behind, which only ever holds more when restored: said, not thrown.
        console.error(
            holds
                ? 'The join check could not be saved on this device.'
                : 'An old join check could not be cleared from this device.',
            error,
        );
    }
}

/*
 * The worker session each family's escalation was restored into, by account
 * and family: the kept escalation goes in once per unlock (and per page load),
 * on the first preview, before anything is shown; never after a showing
 * exists, which a restore could replace.
 */
const restoredIn = new Map<string, number>();
const unreadableHolds = (error: unknown) =>
    error instanceof Error && error.message === HOLDS_UNREADABLE;

/*
 * The code this device shows, over `served`, against every mark it and the
 * account hold (a rejoin's settings pin decides the history; the code adds
 * to it). A record from before a master-key rotation is no mark any more: it
 * goes, and the code is worked out without it.
 */
async function preview(
    ctx: GroupContext,
    groupId: string,
    served: ServedChain,
): Promise<Exclude<CryptoResults['groupJoinPreview'], { status: 'record-unreadable' }>> {
    await ctx.settings.read();
    const at = `${ctx.userId}/${groupId}`;
    // Restored already in this page's worker session (unless a lock started another): none.
    let restore = !restoredIn.has(at);
    for (;;) {
        const record = (await ctx.store.chain(ctx.userId, groupId))?.envelope ?? null;
        let result;
        try {
            result = await ctx.rpc('groupJoinPreview', {
                userId: ctx.userId,
                groupId,
                served,
                record,
                holds: restore ? await keptHolds(ctx, groupId) : null,
            });
        } catch (error) {
            // Sealed under an earlier account root, or not this account's: it holds nothing here.
            if (!unreadableHolds(error)) throw error;
            await ctx.store.deleteHolds(ctx.userId, groupId);
            continue;
        }
        if (result.status === 'record-unreadable') {
            await ctx.store.deleteChain(ctx.userId, groupId);
            continue;
        }
        if (result.status !== 'code') return result;
        // A showing from another worker session than the one restored into: a lock and an unlock
        // happened, so the kept escalation goes in now, and this showing (never displayed) is
        // replaced by the one after the restore.
        if (!restore && restoredIn.get(at) !== result.session) {
            restore = true;
            continue;
        }
        restoredIn.set(at, result.session);
        return result;
    }
}

/* Acceptance with the joins record a match sealed, beside every mark this device and account hold. */
async function acceptJoining(
    ctx: GroupContext,
    groupId: string,
    served: ServedChain,
    joinsRecord: string,
) {
    await ctx.settings.read();
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
        });
        if (result.status !== 'record-unreadable') return result;
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
    /*
     * The code to compare with the admin's screen, with the two positions
     * (0 to 11) the page hides for this showing. `changed`: a code compared
     * earlier is not the one the served chain gives now (the member list
     * changed, or the server is showing something else), and nothing was kept.
     */
    | {
          status: 'compare';
          mark: JoinMark;
          hidden: [number, number];
          /* The worker session the code was shown in: confirmJoin passes it back. */
          session: number;
          changed?: boolean;
      }
    /*
     * The typed words are not the code's, the first time for this family:
     * most likely one misheard or mistyped, said calmly and never which.
     * Nothing was kept, and the positions are held for this code.
     */
    | { status: 'wrong-words' }
    /*
     * A wrong pair again for this family, for this code or any other: no
     * longer said as a typo. HushOS may be showing a different member list;
     * nothing was kept.
     */
    | { status: 'mismatch' }
    /* This person's own marks disagree with what is served (a rejoin onto another history): the hard warning. */
    | { status: 'fork'; fork: RosterFork };

const comparing = (
    shown: { rosterVersion: number; code: string[]; hidden: [number, number]; session: number },
    changed = false,
): JoinOutcome => ({
    status: 'compare',
    mark: { rosterVersion: shown.rosterVersion, code: shown.code },
    hidden: [shown.hidden[0], shown.hidden[1]],
    session: shown.session,
    ...(changed ? { changed: true } : {}),
});

/* One showing of the code over what route 5 serves now. */
async function show(ctx: GroupContext, groupId: string, served: ServedChain): Promise<JoinOutcome> {
    const shown = await preview(ctx, groupId, served);
    if (shown.status === 'fork') return shown;
    // Active on route 2 but not on the member list it serves yet: still waiting.
    if (shown.status === 'not-admitted') return { status: 'waiting' };
    return comparing(shown);
}

/*
 * Where this device's join stands, for the page to resume at: waiting to be
 * let in, the code to compare, a join "They match" began and a reload cut
 * short (finished here), or `member` when this device already holds the
 * family. Nothing is kept unless a joins record says the code was compared.
 */
export async function joinStatus(
    ctx: GroupContext,
    groupId: string,
): Promise<JoinOutcome | { status: 'member' }> {
    if (!(await admitted(ctx, groupId))) return { status: 'waiting' };
    const joinsRecord = (await ctx.store.join(ctx.userId, groupId))?.envelope ?? null;
    // Kept only after the typed words matched: a reload finishes from it.
    if (joinsRecord) return completeJoin(ctx, groupId, joinsRecord);
    if (await ctx.store.chain(ctx.userId, groupId)) return { status: 'member' };
    const { served } = await fetchServed(ctx, groupId, 0);
    return show(ctx, groupId, served);
}

/*
 * An earlier finish wrote the device record and then failed to save the pin:
 * that record is a mark now, so this is a sync (which saves the pin), and the
 * joins record goes. Null when there is no record, or it did not open.
 */
async function finishedBefore(ctx: GroupContext, groupId: string): Promise<JoinOutcome | null> {
    if (!(await ctx.store.chain(ctx.userId, groupId))) return null;
    const synced = await syncLocked(ctx, groupId, { flush: false });
    if (synced.status === 'accepted') {
        await ctx.store.deleteJoin(ctx.userId, groupId);
        return { status: 'joined', sync: synced };
    }
    if (synced.status === 'fork') return synced;
    if (synced.status !== 'unchecked') return { status: 'waiting' };
    // A record that did not open and no pin: the join goes on from the code.
    return null;
}

/*
 * "They match": `shown` is the showing the page displayed (the code and the
 * two positions it hid) and the person compared, `typed` the two hidden words
 * they typed as the admin read them. A showing the worker does not hold (never
 * shown, from before a lock, or replaced) is refused before anything is
 * verified: the code is shown again, to compare again.
 */
export async function confirmJoin(
    ctx: GroupContext,
    groupId: string,
    shown: { mark: JoinMark; hidden: readonly number[]; session: number },
    typed: HiddenWords,
): Promise<JoinOutcome> {
    if (!(await admitted(ctx, groupId))) return { status: 'waiting' };
    await ctx.settings.read();
    return ctx.lock(groupId, async (): Promise<JoinOutcome> => {
        const before = await finishedBefore(ctx, groupId);
        if (before) return before;
        const { served } = await fetchServed(ctx, groupId, 0);
        for (;;) {
            const record = (await ctx.store.chain(ctx.userId, groupId))?.envelope ?? null;
            let checked;
            try {
                checked = await ctx.rpc('groupJoinCheck', {
                    userId: ctx.userId,
                    groupId,
                    served,
                    record,
                    mark: { rosterVersion: shown.mark.rosterVersion, code: [...shown.mark.code] },
                    hidden: [shown.hidden[0]!, shown.hidden[1]!],
                    session: shown.session,
                    typed: [...typed],
                    now: ctx.now().toISOString(),
                });
            } catch (error) {
                // Shown before a lock, or replaced: nothing was checked, so the code again.
                if (!(error instanceof Error) || error.message !== NOT_SHOWN) throw error;
                return show(ctx, groupId, served);
            }
            switch (checked.status) {
                case 'record-unreadable':
                    await ctx.store.deleteChain(ctx.userId, groupId);
                    continue;
                case 'incomplete':
                    throw new Error('Type the two hidden words of the join code.');
                case 'wrong-words':
                case 'mismatch':
                    await keepHolds(ctx, groupId, checked.holds);
                    return { status: checked.status };
                case 'changed':
                    // Not the code that was compared: it vouches for nothing here, and never waits on.
                    await ctx.store.deleteJoin(ctx.userId, groupId);
                    return comparing(checked, true);
                case 'not-admitted':
                    return { status: 'waiting' };
                case 'fork':
                    return checked;
                case 'matched':
                    await keepHolds(ctx, groupId, checked.holds);
                    // Kept before acceptance: a reload between the two finishes from here.
                    await ctx.store.putJoin({
                        userId: ctx.userId,
                        groupId,
                        envelope: checked.joinsRecord,
                    });
                    // The same served chain the code was just worked out over.
                    return acceptJoin(ctx, groupId, served, checked.joinsRecord);
            }
        }
    });
}

/* A reload finishing a join "They match" began: from the joins record, while the served chain gives its code. */
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
        return acceptJoin(ctx, groupId, served, joinsRecord);
    });
}

async function acceptJoin(
    ctx: GroupContext,
    groupId: string,
    served: ServedChain,
    joinsRecord: string,
): Promise<JoinOutcome> {
    const result = await acceptJoining(ctx, groupId, served, joinsRecord);
    switch (result.status) {
        case 'join-unreadable':
            // Sealed under an earlier account root, or an earlier version's (the family's words
            // compared, no comparison of the code): it goes, and the code is compared.
            await ctx.store.deleteJoin(ctx.userId, groupId);
            return show(ctx, groupId, served);
        case 'changed':
            await ctx.store.deleteJoin(ctx.userId, groupId);
            return comparing(result, true);
        case 'not-admitted':
            return { status: 'waiting' };
        case 'fork':
            return { status: 'fork', fork: result.fork };
        case 'accepted':
            break;
    }
    try {
        if (!result.record) throw new Error('The family could not be checked. Try again.');
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
        await forgetInWorker(ctx, groupId);
        throw error;
    }
    const sync = await afterAccept(ctx, groupId, result);
    if (sync.status === 'fork') return sync;
    await ctx.store.deleteJoin(ctx.userId, groupId);
    return { status: 'joined', sync };
}

/* The worker's sentences for a committed chain that is missing, or does not have them yet. */
const NOT_SYNCED = /Check the family’s member list first|not in the family’s member list yet/;

/*
 * The admin's side: the join code to read to `userId`, over this device's
 * committed chain, for the roster that let them in (the one the newcomer's
 * screen works out too). A committed chain that does not have them yet (the
 * sync after "Let them in" did not finish) is synced once first. `pinMatches`
 * says whether their entry on that roster is the keys of this account's
 * contact pin of them, from the settings the worker opened (null: none).
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
            throw new Error('This family’s member list was shown differently to you.');
        return code();
    }
}

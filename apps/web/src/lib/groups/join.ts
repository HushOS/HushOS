import type { CryptoResults, JoinMark, RosterFork, ServedChain } from '@hushos/crypto';
import type { ContactPin } from '@hushos/crypto/contacts';
import type { GroupContext } from './context';
import { afterAccept, fetchServed, syncGroup, syncLocked, type SyncResult } from './sync';

/*
 * Joining a family (docs/groups-design.md 2.4 and 3.2): the newcomer's side,
 * and the join code both screens show. **The only module that may pass
 * `joining` to groupAccept** (F1; join-only.test.ts fails on any other): a
 * device with no mark accepts a member list only with the join code the
 * person compared with the admin's screen as its mark. That code pins the
 * family's first keys and the history up to the roster that admitted them:
 * acceptance works it out again from the verified chain, and made-up first
 * keys give another code or a refusal.
 *
 * 1. The newcomer reads their twelve words to the admin, who checks them and
 *    lets them in (the admin's dialog). Nothing happens on this device.
 * 2. joinStatus, once route 2 says active: the code of the roster that let
 *    this account in, worked out over what route 5 serves (groupJoinPreview),
 *    with two positions this device picks at random for this showing. The
 *    page hides those two words. Nothing is kept, marked or committed, and
 *    the positions never leave this device.
 * 3. confirmJoin, "They match": the person typed the two hidden words as the
 *    admin read them. The code is worked out again over what route 5 serves
 *    now; another code (the member list changed meanwhile) keeps nothing and
 *    is the new one to compare. Then the typed words must be the code's at
 *    the positions this module issued for it (never ones the caller names),
 *    or nothing is kept ('wrong-words'), and the same positions stay for that
 *    code for the rest of the session, so a retry cannot fish for easier
 *    ones. Only then is the code
 *    recorded in the sealed joins record, the chain accepted with it as the
 *    mark, and the device record, the folders and the settings pin written;
 *    the joins record goes.
 *
 * The two typed words are what makes the admin's screen necessary: the
 * server decides when route 2 says active, and could show a code over a
 * family it made up the moment it does; comparing alone could then be done
 * by a person who never waited for the admin. Typing two words only the
 * admin's screen shows cannot: guessing them is 22 bits, at positions the
 * server does not know. A wrong pair is said as one of the two being wrong,
 * never which, so the words never fall one at a time (2 x 2048 tries in
 * place of 4 million). That holds against finishing alone. It is no bound
 * on a server grinding a made-up family whose code matches the admin's in
 * the words a person who compares nothing would skip: the ten compared words
 * are the defence there, and only as good as the comparing.
 *
 * "They don't match" keeps nothing either; the page says what to do. The
 * joins record exists only between "They match" and the end of the join, so
 * a reload in between finishes it without asking again, and only while the
 * served chain still gives the code that was compared.
 */

type JoinRecord = {
    v: 2;
    groupId: string;
    /* The code the person said matches the admin's screen. */
    joinMark: JoinMark;
    checkedAt: string;
};

async function readJoin(ctx: GroupContext, groupId: string): Promise<JoinRecord | null> {
    const row = await ctx.store.join(ctx.userId, groupId);
    if (!row) return null;
    const opened = await ctx.rpc('groupStoreOpen', {
        userId: ctx.userId,
        groupId,
        store: 'joins',
        envelope: row.envelope,
    });
    const record = 'value' in opened ? (opened.value as JoinRecord | null) : null;
    if (record?.v !== 2 || record.groupId !== groupId || !record.joinMark) {
        // Sealed under an earlier account root, not this group's, or an earlier version's words
        // check (v1), which is no comparison of the code: the code is compared again.
        await ctx.store.deleteJoin(ctx.userId, groupId);
        return null;
    }
    return record;
}

async function writeJoin(ctx: GroupContext, record: JoinRecord) {
    const { envelope } = await ctx.rpc('groupStoreSeal', {
        userId: ctx.userId,
        groupId: record.groupId,
        store: 'joins',
        value: record,
    });
    await ctx.store.putJoin({ userId: ctx.userId, groupId: record.groupId, envelope });
}

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
    for (;;) {
        const record = (await ctx.store.chain(ctx.userId, groupId))?.envelope ?? null;
        const result = await ctx.rpc('groupJoinPreview', {
            userId: ctx.userId,
            groupId,
            served,
            record,
        });
        if (result.status !== 'record-unreadable') return result;
        await ctx.store.deleteChain(ctx.userId, groupId);
    }
}

/* Acceptance with the compared code as the mark, beside every mark this device and account hold. */
async function acceptJoining(
    ctx: GroupContext,
    groupId: string,
    served: ServedChain,
    checkedAt: string,
    joinMark: JoinMark,
) {
    await ctx.settings.read();
    for (;;) {
        const record = (await ctx.store.chain(ctx.userId, groupId))?.envelope ?? null;
        const result = await ctx.rpc('groupAccept', {
            userId: ctx.userId,
            groupId,
            served,
            record,
            checkedAt,
            joining: { joinMark },
        });
        if (result.status !== 'record-unreadable') return result;
        await ctx.store.deleteChain(ctx.userId, groupId);
    }
}

const sameMark = (a: JoinMark, b: JoinMark) =>
    a.rosterVersion === b.rosterVersion && a.code.join(' ') === b.code.join(' ');

/* The two hidden words as the person typed them, in the order of the issued positions. */
export type HiddenWords = readonly string[];

/*
 * The positions issued for each code shown in this session, by account,
 * family and code: confirmJoin checks the typed words against these, never
 * against positions a caller names. `held`: a wrong word was typed for that
 * code, so its positions stay until the page is left.
 */
const issued = new Map<string, { positions: [number, number]; held: boolean }>();
const issuedKey = (ctx: GroupContext, groupId: string, mark: JoinMark) =>
    `${ctx.userId}:${groupId}:${mark.rosterVersion}:${mark.code.join(' ')}`;

/* One of 0 to 11 from the crypto RNG, without modulo bias. */
function position() {
    const limit = 2 ** 32 - (2 ** 32 % 12);
    const out = new Uint32Array(1);
    do crypto.getRandomValues(out);
    while (out[0]! >= limit);
    return out[0]! % 12;
}

/* Two distinct positions, for one showing of a code. */
function hiddenPositions(): [number, number] {
    const first = position();
    let second = position();
    while (second === first) second = position();
    return first < second ? [first, second] : [second, first];
}

/* One showing of a code: new positions, unless a wrong word held the last ones. */
function compare(ctx: GroupContext, groupId: string, mark: JoinMark, changed = false): JoinOutcome {
    const key = issuedKey(ctx, groupId, mark);
    const before = issued.get(key);
    const positions = before?.held ? before.positions : hiddenPositions();
    issued.set(key, { positions, held: before?.held ?? false });
    return {
        status: 'compare',
        mark,
        hidden: [positions[0], positions[1]],
        ...(changed ? { changed: true } : {}),
    };
}

/* The positions issued for this code; none means it was never shown, and nothing is confirmed. */
function issuedFor(ctx: GroupContext, groupId: string, mark: JoinMark) {
    const at = issued.get(issuedKey(ctx, groupId, mark));
    if (!at) throw new Error('Compare the join code again.');
    return at;
}

/*
 * Whether the typed words are the code's at the positions issued for it. One
 * answer for the pair: which word is wrong is never said, or a guesser could
 * find the two one at a time.
 */
function typedMatch(positions: readonly number[], mark: JoinMark, typed: HiddenWords) {
    if (typed.length !== 2 || typed.some((word) => typeof word !== 'string' || !word.trim()))
        throw new Error('Type the two hidden words of the join code.');
    return positions.every((at, index) => typed[index]!.trim().toLowerCase() === mark.code[at]);
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
    | { status: 'compare'; mark: JoinMark; hidden: [number, number]; changed?: boolean }
    /*
     * The typed words are not the code's: most likely one misheard or
     * mistyped, said calmly and never which. Nothing was kept, and the
     * positions stay.
     */
    | { status: 'wrong-words' }
    /* This person's own marks disagree with what is served (a rejoin onto another history): the hard warning. */
    | { status: 'fork'; fork: RosterFork };

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
    const record = await readJoin(ctx, groupId);
    // Recorded only after the typed words matched: a reload finishes from it.
    if (record) return completeJoin(ctx, groupId, record.joinMark, record.checkedAt, null);
    if (await ctx.store.chain(ctx.userId, groupId)) return { status: 'member' };
    const { served } = await fetchServed(ctx, groupId, 0);
    const shown = await preview(ctx, groupId, served);
    if (shown.status === 'fork') return shown;
    // Active on route 2 but not on the member list it serves yet: still waiting.
    if (shown.status === 'not-admitted') return { status: 'waiting' };
    return compare(ctx, groupId, { rosterVersion: shown.rosterVersion, code: shown.code });
}

/*
 * "They match": `shown` is the code this device showed and the person
 * compared, `typed` the two hidden words they typed as the admin read them.
 */
export async function confirmJoin(
    ctx: GroupContext,
    groupId: string,
    shown: JoinMark,
    typed: HiddenWords,
): Promise<JoinOutcome> {
    // Checked before anything else: there is no "They match" without the two words, for a code
    // this session showed.
    typedMatch(issuedFor(ctx, groupId, shown).positions, shown, typed);
    if (!(await admitted(ctx, groupId))) return { status: 'waiting' };
    const { settings } = await ctx.settings.read();
    // A rejoin keeps the date the family was first checked on this account.
    const checkedAt = settings.groups?.[groupId]?.checkedAt ?? ctx.now().toISOString();
    return completeJoin(ctx, groupId, shown, checkedAt, typed);
}

async function completeJoin(
    ctx: GroupContext,
    groupId: string,
    mark: JoinMark,
    checkedAt: string,
    typed: HiddenWords | null,
): Promise<JoinOutcome> {
    return ctx.lock(groupId, async (): Promise<JoinOutcome> => {
        // An earlier finish wrote the record and then failed to save the pin: that record is a
        // mark now, so this is a sync (which saves the pin), and the joins record goes.
        if (await ctx.store.chain(ctx.userId, groupId)) {
            const synced = await syncLocked(ctx, groupId, { flush: false });
            if (synced.status === 'accepted') {
                await ctx.store.deleteJoin(ctx.userId, groupId);
                return { status: 'joined', sync: synced };
            }
            if (synced.status === 'fork') return synced;
            if (synced.status !== 'unchecked') return { status: 'waiting' };
            // A record that did not open and no pin: the join goes on from the code.
        }
        const { served } = await fetchServed(ctx, groupId, 0);
        const now = await preview(ctx, groupId, served);
        if (now.status === 'fork') return now;
        if (now.status === 'not-admitted') return { status: 'waiting' };
        const current = { rosterVersion: now.rosterVersion, code: now.code };
        if (!sameMark(current, mark)) {
            // Not the code that was compared: it vouches for nothing here, and never waits on.
            await ctx.store.deleteJoin(ctx.userId, groupId);
            return compare(ctx, groupId, current, true);
        }
        // The two words only the admin's screen shows: without them, nothing is kept, and the
        // positions stay as they were for this code.
        if (typed) {
            const at = issuedFor(ctx, groupId, current);
            if (!typedMatch(at.positions, current, typed)) {
                at.held = true;
                return { status: 'wrong-words' };
            }
        }
        // Kept before acceptance: a reload between the two finishes from here.
        await writeJoin(ctx, { v: 2, groupId, joinMark: mark, checkedAt });
        // The same served chain the code was just worked out over.
        const result = await acceptJoining(ctx, groupId, served, checkedAt, mark);
        if (result.status === 'fork') return { status: 'fork', fork: result.fork };
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
            await ctx.rpc('groupForget', { groupId });
            throw error;
        }
        const sync = await afterAccept(ctx, groupId, result);
        if (sync.status === 'fork') return sync;
        await ctx.store.deleteJoin(ctx.userId, groupId);
        return { status: 'joined', sync };
    });
}

/* The worker's sentences for a committed chain that is missing, or does not have them yet. */
const NOT_SYNCED = /Check the family’s member list first|not in the family’s member list yet/;

/*
 * The admin's side: the join code to read to `userId`, over this device's
 * committed chain, for the roster that let them in (the one the newcomer's
 * screen works out too). A committed chain that does not have them yet (the
 * sync after "Let them in" did not finish) is synced once first. With `pin`,
 * `pinMatches` says whether their entry on that roster is the pinned keys.
 */
export async function memberJoinCode(
    ctx: GroupContext,
    groupId: string,
    userId: string,
    pin: ContactPin | null = null,
) {
    const code = async () => {
        const { served } = await fetchServed(ctx, groupId, 0);
        return ctx.rpc('groupJoinCode', { groupId, userId, rosters: served.rosters, pin });
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

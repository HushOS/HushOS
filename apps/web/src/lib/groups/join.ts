import type { GroupPublicKey, JoinMark, RosterFork, ServedChain } from '@hushos/crypto';
import type { GroupContext } from './context';
import { afterAccept, fetchServed, syncLocked, type SyncResult } from './sync';

/*
 * The newcomer's side of joining a family (docs/groups-design.md 3.2, the 1c
 * plan's "Words check and join code"). **The only module that may pass
 * `joining` to groupAccept** (F1; join-only.test.ts fails on any other): a
 * device with no mark accepts a member list only after the person compared
 * the family's twelve words over the served first keys, and keeps a mark only
 * once they typed the join code of the roster that admitted them.
 *
 * Steps, each surviving a reload through the sealed `joins` record:
 * 1. familyWords: the words over the first keys route 5 serves.
 * 2. wordsMatch: "They match" records which first keys were checked, and the
 *    chain is verified from version 1 (a view, no mark, nothing kept).
 * 3. enterJoinCode: the code the admin reads out, for the next roster.
 * 4. finishJoin, once admitted: accepted with the join code as a mark; the
 *    record and the settings pin are written and the joins record goes.
 *
 * The first keys are passed as checked only while route 5 still serves the
 * ones whose words were compared (their digest is in the record).
 */

type JoinRecord = {
    v: 1;
    groupId: string;
    firstKeysDigest: string;
    checkedAt: string;
    joinMark: JoinMark | null;
};

async function keysDigest(keys: GroupPublicKey) {
    const bytes = new TextEncoder().encode(`${keys.ed25519PublicKey}.${keys.mlDsaPublicKey}`);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return btoa(String.fromCharCode(...hash))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
}

/*
 * Every mark this device and account hold, handed to acceptance so the worker
 * refuses `joining` when any exists (F1): the settings opened (the settings pin)
 * and this device's record. A family already checked here is never joined again.
 */
async function acceptJoining(
    ctx: GroupContext,
    groupId: string,
    served: ServedChain,
    checkedAt: string,
    joinMark: JoinMark | null,
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
        // A record from before a master-key rotation is no mark any more: gone, and asked again.
        if (result.status !== 'record-unreadable') return result;
        await ctx.store.deleteChain(ctx.userId, groupId);
    }
}

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
    if (record?.v !== 1 || record.groupId !== groupId) {
        // Sealed under an earlier account root, or not this group's: the words are compared again.
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
 * Whether this account or device already checked the family: a settings pin
 * (kept through a not-member wipe) or this device's record. Then there are no
 * words to compare (the worker takes the first keys from the marks, never from
 * this flow), and a rejoin goes straight to the join code.
 */
async function checkedBefore(ctx: GroupContext, groupId: string) {
    const { settings } = await ctx.settings.read();
    const pin = settings.groups?.[groupId] ?? null;
    const row = await ctx.store.chain(ctx.userId, groupId);
    return pin || row ? { checkedAt: pin?.checkedAt ?? null } : null;
}

/* Step 1: the family's twelve words, over the first keys the server serves now. */
export async function familyWords(ctx: GroupContext, groupId: string) {
    const { served, head } = await fetchServed(ctx, groupId, 0);
    if (await checkedBefore(ctx, groupId))
        return {
            status: 'already-checked' as const,
            firstKeys: served.firstKeys,
            nextRosterVersion: head.version + 1,
        };
    const { words } = await ctx.rpc('groupWords', { groupId, firstKeys: served.firstKeys });
    return {
        status: 'compare' as const,
        words,
        firstKeys: served.firstKeys,
        nextRosterVersion: head.version + 1,
    };
}

/*
 * Step 2, "They match": the checked keys are recorded, then the served chain
 * verified from version 1 over them. Nothing is kept by the worker and no mark
 * is written; a chain that does not verify is "Couldn't check the family".
 */
export async function wordsMatch(ctx: GroupContext, groupId: string, firstKeys: GroupPublicKey) {
    const before = await readJoin(ctx, groupId);
    const digest = await keysDigest(firstKeys);
    const checked = await checkedBefore(ctx, groupId);
    await writeJoin(ctx, {
        v: 1,
        groupId,
        firstKeysDigest: digest,
        checkedAt:
            checked?.checkedAt ??
            (before?.firstKeysDigest === digest ? before.checkedAt : ctx.now().toISOString()),
        // A code typed against other keys says nothing about these.
        joinMark: before?.firstKeysDigest === digest ? before.joinMark : null,
    });
    const { served, head } = await fetchServed(ctx, groupId, 0);
    if ((await keysDigest(served.firstKeys)) !== digest)
        throw new Error('The family’s keys changed since you compared the words. Compare again.');
    // Checked before: "You've checked this family before. Enter the join code." Nothing to verify
    // here: the marks decide, when the code is in (finishJoin).
    if (checked) return { status: 'already-checked' as const, nextRosterVersion: head.version + 1 };
    const result = await acceptJoining(ctx, groupId, served, ctx.now().toISOString(), null);
    if (result.status === 'fork') return { status: 'fork' as const, fork: result.fork };
    return {
        status: 'checked' as const,
        view: result.view,
        nextRosterVersion: head.version + 1,
    };
}

/* Step 3: the join code the admin reads out, for the roster that admits this person. */
export async function enterJoinCode(
    ctx: GroupContext,
    groupId: string,
    mark: { rosterVersion: number; code: string[] },
) {
    const record = await readJoin(ctx, groupId);
    if (!record) throw new Error('Compare the family’s words first.');
    const code = mark.code.map((word) => word.trim().toLowerCase());
    if (code.length !== 12 || code.some((word) => !/^[a-z]{3,8}$/.test(word)))
        throw new Error('Enter all twelve words of the join code.');
    // Typing it again replaces the mark: a typo is put right here, not kept.
    await writeJoin(ctx, { ...record, joinMark: { rosterVersion: mark.rosterVersion, code } });
}

export type JoinOutcome =
    | { status: 'joined'; sync: Extract<SyncResult, { status: 'accepted' }> }
    /* Not admitted yet: poll route 2 until the state is active. */
    | { status: 'waiting' }
    /*
     * The typed code is not the served roster's, and every other mark agrees with
     * what is served. This is either a typo or the server showing a different
     * history than the one the admin admitted on, and this device cannot tell
     * which. The copy asks to check the code with the admin
     * again, and says that if it still does not match after careful reading,
     * HushOS may be showing a different member list than the admin sees.
     */
    | { status: 'code-mismatch'; fork: RosterFork }
    /* This person's own marks disagree with what is served (a rejoin onto another history): the hard warning. */
    | { status: 'fork'; fork: RosterFork }
    /* No words check or no join code on record yet. */
    | { status: 'needs-check' };

/*
 * Step 4, once route 2 says active: the chain accepted from version 1 with
 * the join code as a mark; then, from that committed acceptance only, the
 * record, the folders and the settings pin, and the joins record goes.
 */
export async function finishJoin(ctx: GroupContext, groupId: string): Promise<JoinOutcome> {
    const { groups } = await ctx.api.listGroups();
    const state = groups.find((group) => group.id === groupId)?.state;
    if (state !== 'active') return { status: 'waiting' };
    const record = await readJoin(ctx, groupId);
    if (!record?.joinMark) return { status: 'needs-check' };
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
        if ((await keysDigest(served.firstKeys)) !== record.firstKeysDigest)
            return { status: 'needs-check' };
        const result = await acceptJoining(ctx, groupId, served, record.checkedAt, record.joinMark);
        if (result.status === 'fork') {
            // Only the typed code disagrees when every other side is what the server serves: the
            // code was never kept as a mark, so the worker forgets the fork it just set and the
            // code can be typed again. A pin or record that disagrees with what is served (a
            // rejoin onto another history) is the hard warning, and the fork stays.
            const fromJoin = (side: { from: string[] }) =>
                side.from.length === 1 && side.from[0] === 'join';
            const onlyCode =
                result.fork.sides.some(fromJoin) &&
                result.fork.sides
                    .filter((side) => !fromJoin(side))
                    .every((side) => side.from.includes('served'));
            if (!onlyCode) return { status: 'fork', fork: result.fork };
            await ctx.rpc('groupForget', { groupId });
            return { status: 'code-mismatch', fork: result.fork };
        }
        if (!result.record) throw new Error('The family could not be checked. Try again.');
        await ctx.store.putChain({
            userId: ctx.userId,
            groupId,
            envelope: result.record,
            rosterVersion: result.view.rosterVersion,
            areas: Object.keys(result.view.areas),
        });
        const sync = await afterAccept(ctx, groupId, result);
        if (sync.status === 'fork') return sync;
        await ctx.store.deleteJoin(ctx.userId, groupId);
        return { status: 'joined', sync };
    });
}

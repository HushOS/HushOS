import { beforeAll, describe, expect, test } from 'vitest';
import { keyCommitment, pinKeysOfServed } from '@hushos/crypto/pins';
import {
    createFamily,
    dropHeldBack,
    dropKeptAdmission,
    letIn,
    loadOutbox,
    RESEND_DELAYS_MS,
    resumeOutbox,
    sendChainCall,
    stageChange,
    type OutboxEntry,
} from './outbox';
import { createMemoryGroupStore, createUnavailableGroupStore } from './store';
import { syncGroup } from './sync';
import {
    AREA,
    AREA_2,
    GROUP,
    USER,
    harness,
    noAnswer,
    pinAt,
    refusal,
    rosterBody,
} from './test-harness';

/*
 * The outbox's rules (F7; docs/groups-design.md 2.4 "Staged chains", the 1c
 * plan section 4): what it sends, keeps, drops and wipes on every answer a
 * roster route gives. A resend must be the very bytes signed once (a re-signed
 * statement is a second history the server can play back), a change that met
 * a moved membership must never be resent, and only a 404 carrying
 * `not-member` may wipe a family from the device.
 */

function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
    return {
        v: 1,
        id: 'call-1',
        groupId: GROUP,
        route: { kind: 'remove', userId: 'b0b0b0b0-0000-4000-8000-000000000003' },
        body: rosterBody(),
        stagedEnvelope: 'staged-secrets',
        state: 'ready',
        attempts: 0,
        joinCode: null,
        ...overrides,
    };
}

/* A device that has synced this family before: a record and a settings pin at the head. */
function synced(h: ReturnType<typeof harness>) {
    h.settings.doc = { version: 2, contacts: {}, groups: { [GROUP]: pinAt(h.server.head) } };
    return h.store.putChain({
        userId: USER,
        groupId: GROUP,
        envelope: 'record-5',
        rosterVersion: h.server.head,
        areas: [AREA, AREA_2],
    });
}

describe('sending', () => {
    test('keeps the sealed call before the first send, and sends it holding the family’s write lock', async () => {
        const h = harness();
        await synced(h);
        const outcome = await sendChainCall(h.ctx, entry());
        expect(outcome.status).toBe('landed');
        expect(h.server.storedAtSend).toEqual([1]);
        expect(h.server.lockHeldAtSend).toEqual([true]);
        // Landed: the staged chain is dropped before the family is synced from what is served.
        const order = h.worker.map((call) => call.operation);
        expect(order.indexOf('groupDrop')).toBeLessThan(order.lastIndexOf('groupAccept'));
        expect(await h.store.outbox(USER, GROUP)).toEqual([]);
    });

    test('an entry the shared reader does not take is never sent: dropped, and said lost (fail closed)', async () => {
        const h = harness();
        await synced(h);
        const broken = { ...entry(), route: { kind: 'join' } } as unknown as OutboxEntry;
        expect(await sendChainCall(h.ctx, broken)).toMatchObject({
            status: 'refused',
            code: 'lost',
        });
        expect(h.server.sent).toEqual([]);
        expect(await h.store.outbox(USER, GROUP)).toEqual([]);
    });

    test.each([
        ['no answer at all', noAnswer()],
        ['503 unavailable', refusal(503, 'unavailable')],
        ['429 rate-limited', refusal(429, 'rate-limited')],
        ['401 signed out', refusal(401, 'signed-out')],
        ['a 404 without a code', refusal(404, null)],
        ['a 501 without a code', refusal(501, null)],
        ['501 unsupported', refusal(501, 'unsupported')],
        ['a 500', refusal(500, null)],
    ])('after %s, resends the very same bytes and keeps the family', async (_label, answer) => {
        const h = harness();
        await synced(h);
        h.server.script.push(answer);
        const outcome = await sendChainCall(h.ctx, entry());
        expect(outcome.status).toBe('landed');
        expect(h.server.sent).toHaveLength(2);
        expect(h.server.sent[1]!.body).toBe(h.server.sent[0]!.body);
        expect(h.calls('groupForget')).toEqual([]);
        expect(await h.store.chain(USER, GROUP)).not.toBeNull();
    });

    test('an outcome still unknown after the resends waits for the next open, which sends the same bytes', async () => {
        const store = createMemoryGroupStore();
        const first = harness({ store });
        await synced(first);
        first.server.script.push(...RESEND_DELAYS_MS.map(() => noAnswer()), noAnswer());
        const outcome = await sendChainCall(first.ctx, entry());
        expect(outcome.status).toBe('pending');
        expect(first.sleeps).toEqual(RESEND_DELAYS_MS);
        expect(first.calls('groupDrop')).toEqual([]);
        // The tab closes. The next open finds the call and sends it as it was.
        const reopened = harness({ store });
        const resumed = await resumeOutbox(reopened.ctx);
        expect([...resumed.outcomes.values()].map((at) => at.status)).toEqual(['landed']);
        const bodies = [...first.server.sent, ...reopened.server.sent].map((at) => at.body);
        expect(new Set(bodies).size).toBe(1);
        expect(bodies).toHaveLength(RESEND_DELAYS_MS.length + 2);
        expect(await store.outbox(USER)).toEqual([]);
    });
});

describe('refusals', () => {
    test.each([
        [400, 'invalid'],
        [402, 'seats'],
        [409, 'area-limit'],
        [409, 'group-limit'],
        [409, 'held'],
        [409, 'succession-due'],
        [409, 'root-mid-rotation'],
        [409, 'not-pending'],
        [409, 'unsupported'],
        [413, 'too-large'],
        [426, 'unsupported'],
    ])('%i %s is final: dropped with its staged chain, never resent', async (status, code) => {
        const h = harness();
        await synced(h);
        h.server.script.push(refusal(status, code));
        const outcome = await sendChainCall(h.ctx, entry());
        expect(outcome).toMatchObject({ status: 'refused', code });
        expect(h.server.sent).toHaveLength(1);
        expect(h.calls('groupDrop')).toEqual([{ outboxId: 'call-1' }]);
        expect(await h.store.outbox(USER, GROUP)).toEqual([]);
        expect(h.calls('groupForget')).toEqual([]);
    });

    test('stale: dropped and re-synced onto the winner, never resent', async () => {
        const h = harness();
        await synced(h);
        h.server.script.push(refusal(409, 'stale', { head: { version: 6 } }));
        const outcome = await sendChainCall(h.ctx, entry());
        expect(outcome).toMatchObject({ status: 'stale', data: { head: { version: 6 } } });
        expect(h.server.sent).toHaveLength(1);
        const order = h.worker.map((call) => call.operation);
        expect(order).toContain('groupDrop');
        expect(order.indexOf('groupDrop')).toBeLessThan(order.lastIndexOf('groupAccept'));
        expect(await h.store.outbox(USER, GROUP)).toEqual([]);
    });

    test.each(['members-changed', 'left-due'] as const)(
        '%s is never resent: dropped, re-synced, handed back to rebuild',
        async (code) => {
            const h = harness();
            await synced(h);
            h.server.script.push(refusal(409, code, { userIds: ['someone'] }));
            const outcome = await sendChainCall(h.ctx, entry());
            expect(outcome).toEqual({
                status: 'membership-moved',
                code,
                data: { userIds: ['someone'] },
            });
            expect(h.server.sent).toHaveLength(1);
            expect(h.calls('groupDrop')).toEqual([{ outboxId: 'call-1' }]);
            expect(h.calls('groupAccept')).toHaveLength(1);
            expect(await h.store.outbox(USER, GROUP)).toEqual([]);
            // Nothing the next open could send again either.
            expect((await resumeOutbox(h.ctx)).outcomes).toEqual(new Map());
            expect(h.server.sent).toHaveLength(1);
        },
    );

    test('forbidden: the role went mid-change; dropped and re-synced', async () => {
        const h = harness();
        await synced(h);
        h.server.script.push(refusal(403, 'forbidden'));
        expect(await sendChainCall(h.ctx, entry())).toMatchObject({
            status: 'refused',
            code: 'forbidden',
        });
        expect(h.server.sent).toHaveLength(1);
        expect(h.calls('groupAccept')).toHaveLength(1);
    });
});

describe('fixes that resend the same roster', () => {
    test('grants-due: the named grants go on route 22, then the same bytes', async () => {
        const h = harness();
        await synced(h);
        const someone = 'b0b0b0b0-0000-4000-8000-000000000003';
        h.server.script.push(
            refusal(409, 'grants-due', { missing: [{ workspaceId: AREA_2, userId: someone }] }),
        );
        expect((await sendChainCall(h.ctx, entry())).status).toBe('landed');
        expect(h.calls('groupGrants')).toEqual([
            {
                groupId: GROUP,
                missing: [{ workspaceId: AREA_2, userId: someone, kemPublicKey: `kem-${someone}` }],
            },
        ]);
        expect(h.server.grants).toEqual([
            {
                workspaceId: AREA_2,
                grants: [
                    {
                        workspaceId: AREA_2,
                        granteeUserId: someone,
                        envelope: `grant-to-kem-${someone}`,
                    },
                ],
            },
        ]);
        expect(h.server.sent[1]!.body).toBe(h.server.sent[0]!.body);
    });

    test('rotating: the named Drive rotation is walked first, then that area rebuilt under the same roster', async () => {
        const h = harness();
        await synced(h);
        const running = { workspaceId: AREA, rotationId: 'run', nodeId: 'root', targetEpoch: 7 };
        h.server.script.push(refusal(409, 'rotating', running));
        expect((await sendChainCall(h.ctx, entry())).status).toBe('landed');
        expect(h.rotationLog.finished).toEqual([running]);
        expect(h.rotationLog.read).toEqual([[{ workspaceId: AREA, kinds: [] }]]);
        const [before, after] = h.server.sent.map((at) => JSON.parse(at.body));
        expect(after.roster).toEqual(before.roster);
        expect(after.grants).toEqual(before.grants);
        expect(after.expectedRevision).toBe(before.expectedRevision);
        // What goes is what the worker rebuilt, the rest of the call as it was signed.
        const [restaged] = h.outputs('groupRestage') as { body: { rotations: unknown } }[];
        expect(after.rotations).toEqual(restaged!.body.rotations);
    });

    test.each(['epoch-stale', 'root-moved'] as const)(
        '%s: every rotated area rebuilt, the roster bytes unchanged',
        async (code) => {
            const h = harness();
            await synced(h);
            h.server.script.push(refusal(409, code));
            expect((await sendChainCall(h.ctx, entry())).status).toBe('landed');
            expect(h.rotationLog.read).toEqual([
                [
                    { workspaceId: AREA, kinds: [] },
                    { workspaceId: AREA_2, kinds: [] },
                ],
            ]);
            const [before, after] = h.server.sent.map((at) => JSON.parse(at.body));
            expect(after.roster).toEqual(before.roster);
        },
    );

    test('document-stale: every document it names is read again, each area with all its named kinds', async () => {
        const h = harness();
        await synced(h);
        h.server.script.push(
            refusal(409, 'document-stale', {
                stale: [
                    { workspaceId: AREA, kind: 'tags' },
                    { workspaceId: AREA_2, kind: 'tags' },
                    { workspaceId: AREA_2, kind: 'notes' },
                ],
                workspaceId: AREA,
                kind: 'tags',
            }),
        );
        expect((await sendChainCall(h.ctx, entry())).status).toBe('landed');
        expect(h.rotationLog.read).toEqual([
            [
                { workspaceId: AREA, kinds: ['tags'] },
                { workspaceId: AREA_2, kinds: ['notes', 'tags'] },
            ],
        ]);
        // What Drive read again is what the worker rebuilds from, untouched.
        const rebuild = h.calls('groupRestage')[0] as { rebuild: { rotations: unknown } };
        expect(rebuild.rebuild.rotations).toBe(h.rotationLog.returned[0]);
        const [before, after] = h.server.sent.map((at) => JSON.parse(at.body));
        expect(after.roster).toEqual(before.roster);
    });

    test('a rebuilt call is what the outbox keeps, so a reload sends the rebuilt bytes', async () => {
        const store = createMemoryGroupStore();
        const h = harness({ store });
        await synced(h);
        h.server.script.push(refusal(409, 'epoch-stale'), ...Array(4).fill(noAnswer()));
        expect((await sendChainCall(h.ctx, entry())).status).toBe('pending');
        const [kept] = (await loadOutbox(h.ctx, GROUP)).entries;
        expect(JSON.stringify(kept!.body)).toBe(h.server.sent.at(-1)!.body);
        expect(h.server.sent.at(-1)!.body).not.toBe(h.server.sent[0]!.body);
    });

    test('without the family folders open the rotation cannot be rebuilt: the call waits, unsent and kept', async () => {
        const h = harness({ rotations: false });
        await synced(h);
        h.server.script.push(refusal(409, 'rotating', { workspaceId: AREA }));
        expect((await sendChainCall(h.ctx, entry())).status).toBe('pending');
        expect(h.server.sent).toHaveLength(1);
        expect(h.calls('groupDrop')).toEqual([]);
        expect(await h.store.outbox(USER, GROUP)).toHaveLength(1);
    });
});

describe('wiping', () => {
    test('404 not-member wipes the family: worker state, record, outbox, mirrors and settings pin', async () => {
        const h = harness();
        await synced(h);
        h.server.script.push(refusal(404, 'not-member'));
        expect((await sendChainCall(h.ctx, entry())).status).toBe('wiped');
        expect(h.calls('groupForget')).toEqual([{ groupId: GROUP, checkedAt: expect.any(String) }]);
        expect(await h.store.chain(USER, GROUP)).toBeNull();
        expect(await h.store.outbox(USER, GROUP)).toEqual([]);
        expect(h.mirrorsDeleted).toEqual([[AREA, AREA_2]]);
        // The settings pin stays: if the family comes back, it is still a mark.
        expect(h.settings.doc.groups?.[GROUP]).toEqual(pinAt(5));
    });

    test.each([
        ['a bare 404', refusal(404, null)],
        ['a 501', refusal(501, null)],
        ['501 unsupported', refusal(501, 'unsupported')],
        ['403 forbidden', refusal(403, 'forbidden')],
        ['410 gone', refusal(410, 'gone')],
    ])('%s never wipes', async (_label, answer) => {
        const h = harness();
        await synced(h);
        h.server.script.push(answer);
        await sendChainCall(h.ctx, entry());
        expect(h.calls('groupForget')).toEqual([]);
        expect(h.mirrorsDeleted).toEqual([]);
        expect(await h.store.chain(USER, GROUP)).not.toBeNull();
        expect(h.settings.doc.groups?.[GROUP]).toBeDefined();
    });
});

describe('admissions', () => {
    const NEWCOMER = 'c0c0c0c0-0000-4000-8000-000000000004';
    const admit = {
        kind: 'admit' as const,
        userId: NEWCOMER,
        served: {} as never,
        roles: [],
    };
    const b64 = (length: number, fill: number) =>
        Buffer.from(new Uint8Array(length).fill(fill)).toString('base64url');
    /*
     * The admin's contact pin of the newcomer over keys made of the four fill
     * bytes (X25519, Ed25519, ML-DSA, ML-KEM): verified, as a words check
     * writes it, or first-seen, `fingerprint` "".
     */
    async function pinOf(form: 'verified' | 'seen', [x, ed, mlDsa, kem]: number[]) {
        return {
            userId: NEWCOMER,
            email: 'sam@example.com',
            name: 'Sam',
            pinnedAt: '2026-10-26T10:00:00.000Z',
            ...(await pinKeysOfServed(
                {
                    keyVersion: 1,
                    encryptionPublicKey: b64(32, x!),
                    signingPublicKey: b64(32, ed!),
                    mlDsaPublicKey: b64(1952, mlDsa!),
                    kemPublicKey: b64(1184, kem!),
                },
                form,
            )),
        };
    }
    type NewcomerPin = Awaited<ReturnType<typeof pinOf>>;
    let CHECKED: NewcomerPin;
    let RECHECKED: NewcomerPin;
    beforeAll(async () => {
        CHECKED = await pinOf('verified', [1, 2, 3, 4]);
        RECHECKED = await pinOf('verified', [5, 6, 7, 8]);
    });
    /* Synced, with the admin's contact pin of the newcomer. */
    async function checked(h: ReturnType<typeof harness>, pin: NewcomerPin = CHECKED) {
        await synced(h);
        h.settings.doc.contacts = { [NEWCOMER]: pin as never };
    }
    /* An earlier version's admission, held back until its join code was typed, as it kept them. */
    async function heldBack(h: ReturnType<typeof harness>, id = 'held-1') {
        const held = entry({
            id,
            route: { kind: 'admit', userId: NEWCOMER },
            body: rosterBody('held'),
            state: 'awaiting-check',
        });
        await h.store.putOutbox({
            id,
            userId: USER,
            groupId: GROUP,
            envelope: `sealed:${JSON.stringify(held)}`,
        });
        return held;
    }

    test('“Let them in” signs the admission and sends it there and then, holding the lock', async () => {
        const h = harness();
        await checked(h);
        const outcome = await letIn(h.ctx, GROUP, admit, CHECKED);
        if (outcome.status !== 'sent') throw new Error(outcome.status);
        expect(outcome.outcome.status).toBe('landed');
        expect(h.server.sent).toEqual([
            { route: 'admit', body: JSON.stringify(outcome.entry.body) },
        ]);
        expect(h.server.lockHeldAtSend).toEqual([true]);
        expect(await h.store.outbox(USER, GROUP)).toEqual([]);
    });

    test('a send with no answer is kept, and the next “Let them in” sends those bytes again rather than signing anew', async () => {
        const store = createMemoryGroupStore();
        const first = harness({ store });
        await checked(first);
        first.server.script.push(...RESEND_DELAYS_MS.map(() => noAnswer()), noAnswer());
        const kept = await letIn(first.ctx, GROUP, admit, CHECKED);
        if (kept.status !== 'sent') throw new Error(kept.status);
        expect(kept.outcome.status).toBe('pending');
        const again = harness({ store });
        await checked(again);
        const resent = await letIn(again.ctx, GROUP, admit, CHECKED);
        expect(resent).toMatchObject({ status: 'sent', outcome: { status: 'landed' } });
        expect(again.calls('groupStage')).toEqual([]);
        expect(again.server.sent.map((at) => at.body)).toEqual([JSON.stringify(kept.entry.body)]);
    });

    test('a kept admission sealed to keys the admin no longer holds as checked is never resent; dropped knowingly, a new one is signed', async () => {
        const store = createMemoryGroupStore();
        const first = harness({ store });
        await checked(first);
        first.server.script.push(...RESEND_DELAYS_MS.map(() => noAnswer()), noAnswer());
        const kept = await letIn(first.ctx, GROUP, admit, CHECKED);
        if (kept.status !== 'sent') throw new Error(kept.status);
        expect(kept.entry.admits).toEqual({ userId: NEWCOMER, keys: await keyCommitment(CHECKED) });
        // The newcomer's account changed; the admin checked their new words.
        const again = harness({ store });
        await checked(again, RECHECKED);
        const rechecked = admit;
        const refused = await letIn(again.ctx, GROUP, rechecked, RECHECKED);
        expect(refused).toEqual({ status: 'kept-other-keys', entry: kept.entry });
        expect(again.server.sent).toEqual([]);
        expect(again.calls('groupStage')).toEqual([]);
        await dropKeptAdmission(again.ctx, kept.entry);
        expect(await store.outbox(USER, GROUP)).toEqual([]);
        const fresh = await letIn(again.ctx, GROUP, rechecked, RECHECKED);
        expect(fresh).toMatchObject({
            status: 'sent',
            entry: { admits: { keys: await keyCommitment(RECHECKED) } },
            outcome: { status: 'landed' },
        });
        expect(again.calls('groupStage')).toHaveLength(1);
    });

    test('a kept admission from before its keys were recorded is never resent by “Let them in” either', async () => {
        const h = harness();
        await checked(h);
        const old = entry({ id: 'old-admit', route: { kind: 'admit', userId: NEWCOMER } });
        await h.store.putOutbox({
            id: 'old-admit',
            userId: USER,
            groupId: GROUP,
            envelope: `sealed:${JSON.stringify(old)}`,
        });
        expect(await letIn(h.ctx, GROUP, admit, CHECKED)).toMatchObject({
            status: 'kept-other-keys',
        });
        expect(h.server.sent).toEqual([]);
    });

    test('a kept admission whose keys the admin re-checked is never sent by a page open or a sync either', async () => {
        const store = createMemoryGroupStore();
        const first = harness({ store });
        await checked(first);
        first.server.script.push(...RESEND_DELAYS_MS.map(() => noAnswer()), noAnswer());
        const kept = await letIn(first.ctx, GROUP, admit, CHECKED);
        if (kept.status !== 'sent') throw new Error(kept.status);
        expect(kept.outcome.status).toBe('pending');
        const sentBefore = first.server.sent.length;
        // The newcomer's account changed and the admin checked the new words, in another tab.
        const reopened = harness({ store });
        await checked(reopened, RECHECKED);
        expect((await resumeOutbox(reopened.ctx)).outcomes.get(kept.entry.id)).toEqual({
            status: 'other-keys',
        });
        await syncGroup(reopened.ctx, GROUP);
        expect(reopened.server.sent).toEqual([]);
        expect(first.server.sent).toHaveLength(sentBefore);
        // Held, not dropped: "Let them in" names it and offers to drop it.
        expect((await store.outbox(USER, GROUP)).map((row) => row.id)).toEqual([kept.entry.id]);
        // With the pin gone altogether, still never sent.
        reopened.settings.doc.contacts = {};
        expect(await sendChainCall(reopened.ctx, kept.entry)).toEqual({ status: 'other-keys' });
        expect(reopened.server.sent).toEqual([]);
    });

    /*
     * First-seen pins all hold "" as their fingerprint, so an admission is
     * told by the key commitment it was staged over
     * (docs/optional-verification.md 2.2): a Continue between staging and
     * sending moves the pin to other keys, and the grants sealed to the old
     * ones must never go.
     */
    test.each([
        ['their X25519 and Ed25519 keys', [9, 10, 3, 4]],
        ['only their ML-DSA and ML-KEM keys', [1, 2, 11, 12]],
        ['only their ML-KEM key', [1, 2, 3, 12]],
    ])(
        'a kept admission staged over first-seen keys is never sent once the pin moved to other first-seen keys (%s), in this tab or after a relaunch',
        async (_, moved) => {
            const store = createMemoryGroupStore();
            const first = harness({ store });
            const before = await pinOf('seen', [1, 2, 3, 4]);
            const after = await pinOf('seen', moved);
            await checked(first, before);
            first.server.script.push(...RESEND_DELAYS_MS.map(() => noAnswer()), noAnswer());
            const kept = await letIn(first.ctx, GROUP, admit, before);
            if (kept.status !== 'sent') throw new Error(kept.status);
            expect(kept.outcome.status).toBe('pending');
            expect(kept.entry.admits).toEqual({
                userId: NEWCOMER,
                keys: await keyCommitment(before),
            });
            const sentBefore = first.server.sent.length;
            // A Continue in this tab: the pin now holds other first-seen keys.
            first.settings.doc.contacts = { [NEWCOMER]: after as never };
            expect(await sendChainCall(first.ctx, kept.entry)).toEqual({ status: 'other-keys' });
            expect(first.server.sent).toHaveLength(sentBefore);
            // A relaunch with the moved pin: neither a page open, a sync nor "Let them in" sends it.
            const reopened = harness({ store });
            await checked(reopened, after);
            expect((await resumeOutbox(reopened.ctx)).outcomes.get(kept.entry.id)).toEqual({
                status: 'other-keys',
            });
            await syncGroup(reopened.ctx, GROUP);
            expect(await letIn(reopened.ctx, GROUP, admit, after)).toEqual({
                status: 'kept-other-keys',
                entry: kept.entry,
            });
            expect(reopened.server.sent).toEqual([]);
            expect(reopened.calls('groupStage')).toEqual([]);
        },
    );

    /*
     * The pin can move while one send is still retrying (a Continue in another tab during a
     * wait, or between a refusal and its fix): every attempt checks it again, never only the
     * first (Codex review of #206, P1).
     */
    test.each([
        ['only their ML-KEM key', [1, 2, 3, 12]],
        ['their X25519 and Ed25519 keys', [9, 10, 3, 4]],
    ])(
        'an admission whose pin moves (%s) while it waits to be sent again is never sent again',
        async (_, moved) => {
            const before = await pinOf('seen', [1, 2, 3, 4]);
            const after = await pinOf('seen', moved);
            // During the wait after an answer that never came.
            const waiting = harness();
            await checked(waiting, before);
            waiting.server.script.push(noAnswer());
            waiting.ctx.sleep = async () => {
                waiting.settings.doc.contacts = { [NEWCOMER]: after as never };
            };
            const waited = await letIn(waiting.ctx, GROUP, admit, before);
            expect(waited).toMatchObject({ status: 'sent', outcome: { status: 'other-keys' } });
            expect(waiting.server.sent).toHaveLength(1);
            // Kept, held: never dropped unseen.
            expect(await waiting.store.outbox(USER, GROUP)).toHaveLength(1);
            // Between a refusal and the fix that would send the same bytes again.
            const fixing = harness();
            await checked(fixing, before);
            fixing.server.script.push(
                refusal(409, 'grants-due', {
                    missing: [
                        { workspaceId: AREA_2, userId: 'b0b0b0b0-0000-4000-8000-000000000003' },
                    ],
                }),
            );
            const admitOnce = fixing.ctx.api.admit;
            fixing.ctx.api.admit = async (...args) => {
                fixing.settings.doc.contacts = { [NEWCOMER]: after as never };
                return admitOnce(...args);
            };
            const fixed = await letIn(fixing.ctx, GROUP, admit, before);
            expect(fixed).toMatchObject({ status: 'sent', outcome: { status: 'other-keys' } });
            expect(fixing.server.sent).toHaveLength(1);
            expect(fixing.server.grants).toEqual([]);
        },
    );

    test('a final refusal after the pin moved still drops the admission rather than holding it forever', async () => {
        const before = await pinOf('seen', [1, 2, 3, 4]);
        const after = await pinOf('seen', [1, 2, 3, 12]);
        const h = harness();
        await checked(h, before);
        // The person stopped waiting to join while the pin moved: nothing can ever land now.
        h.server.script.push(refusal(409, 'not-pending'));
        const admitOnce = h.ctx.api.admit;
        h.ctx.api.admit = async (...args) => {
            h.settings.doc.contacts = { [NEWCOMER]: after as never };
            return admitOnce(...args);
        };
        const outcome = await letIn(h.ctx, GROUP, admit, before);
        expect(outcome).toMatchObject({
            status: 'sent',
            outcome: { status: 'refused', code: 'not-pending' },
        });
        expect(h.server.sent).toHaveLength(1);
        expect(await h.store.outbox(USER, GROUP)).toEqual([]);
    });

    test('a kept admission from before keys were recorded, with only its fingerprint, is sent exactly when the pin holds those keys', async () => {
        const kept = (admits: unknown) =>
            entry({
                id: 'older-admit',
                route: { kind: 'admit', userId: NEWCOMER },
                body: rosterBody('older'),
                admits: admits as never,
            });
        const send = async (pin: NewcomerPin, admits: unknown) => {
            const h = harness();
            await checked(h, pin);
            return { outcome: await sendChainCall(h.ctx, kept(admits)), sent: h.server.sent };
        };
        // Written over a verified pin, whose fingerprint is its key commitment.
        const older = { userId: NEWCOMER, fingerprint: CHECKED.fingerprint };
        const same = await send(CHECKED, older);
        expect(same.outcome).toMatchObject({ status: 'landed' });
        expect(same.sent).toHaveLength(1);
        expect(await send(RECHECKED, older)).toEqual({
            outcome: { status: 'other-keys' },
            sent: [],
        });
        // The same keys, first-seen now: still those keys.
        expect((await send(await pinOf('seen', [1, 2, 3, 4]), older)).outcome).toMatchObject({
            status: 'landed',
        });
        // A first-seen pin's "" matches nothing, not even another "".
        const blank = await pinOf('seen', [9, 10, 3, 4]);
        expect(await send(blank, { userId: NEWCOMER, fingerprint: '' })).toEqual({
            outcome: { status: 'other-keys' },
            sent: [],
        });
        // Both fields: `keys` decides, `fingerprint` is ignored.
        const both = {
            userId: NEWCOMER,
            keys: await keyCommitment(RECHECKED),
            fingerprint: CHECKED.fingerprint,
        };
        expect(await send(CHECKED, both)).toEqual({ outcome: { status: 'other-keys' }, sent: [] });
        expect((await send(RECHECKED, both)).outcome).toMatchObject({ status: 'landed' });
    });

    test('a stale answer drops the admission and syncs, and the next “Let them in” signs it over the new head', async () => {
        const h = harness();
        await checked(h);
        h.server.script.push(refusal(409, 'stale'));
        const lost = await letIn(h.ctx, GROUP, admit, CHECKED);
        expect(lost).toMatchObject({ status: 'sent', outcome: { status: 'stale' } });
        expect(h.server.sent).toHaveLength(1);
        expect((await loadOutbox(h.ctx, GROUP)).entries).toEqual([]);
        h.server.head = 6;
        await checked(h);
        const resigned = await letIn(h.ctx, GROUP, admit, CHECKED);
        expect(resigned).toMatchObject({ status: 'sent', outcome: { status: 'landed' } });
        expect(h.calls('groupStage')).toHaveLength(2);
        expect(h.server.sent).toHaveLength(2);
    });

    test('an earlier version’s held-back admission is never sent; the family page drops it and names the person', async () => {
        const store = createMemoryGroupStore();
        const h = harness({ store });
        await checked(h);
        const held = await heldBack(h);
        expect(await sendChainCall(h.ctx, held)).toEqual({ status: 'awaiting-check' });
        // Neither an open nor a sync sends it, or drops it unseen.
        expect((await resumeOutbox(h.ctx)).outcomes).toEqual(new Map());
        await syncGroup(h.ctx, GROUP);
        expect(h.server.sent).toEqual([]);
        expect(await store.outbox(USER, GROUP)).toHaveLength(1);
        // The family page: dropped, with the person to let in again.
        expect(await dropHeldBack(h.ctx, GROUP)).toEqual([
            { kind: 'admission-dropped', groupId: GROUP, userId: NEWCOMER },
        ]);
        expect(h.calls('groupDrop')).toEqual([{ outboxId: 'held-1' }]);
        expect(await store.outbox(USER, GROUP)).toEqual([]);
        expect(h.server.sent).toEqual([]);
        // Said once: nothing is left to say it again.
        expect(await dropHeldBack(h.ctx, GROUP)).toEqual([]);
    });

    test('the family page drops only held-back admissions: a kept send stays to go again', async () => {
        const store = createMemoryGroupStore();
        const h = harness({ store });
        await checked(h);
        h.server.script.push(...RESEND_DELAYS_MS.map(() => noAnswer()), noAnswer());
        await sendChainCall(h.ctx, entry({ id: 'call-2' }));
        expect(await dropHeldBack(h.ctx, GROUP)).toEqual([]);
        expect((await store.outbox(USER, GROUP)).map((row) => row.id)).toEqual(['call-2']);
    });

    test('“Let them in” drops a held-back admission for the person and signs a new one, never sending the old bytes', async () => {
        const h = harness();
        await checked(h);
        const held = await heldBack(h);
        const outcome = await letIn(h.ctx, GROUP, admit, CHECKED);
        if (outcome.status !== 'sent') throw new Error(outcome.status);
        expect(outcome.outcome.status).toBe('landed');
        expect(h.server.sent.map((at) => at.body)).not.toContain(JSON.stringify(held.body));
        expect(h.calls('groupDrop')).toContainEqual({ outboxId: 'held-1' });
    });
});

describe('creating a family', () => {
    test('a creation committed but not yet pinned survives a reload and is finished, not sent again', async () => {
        const store = createMemoryGroupStore();
        const first = harness({ store });
        // The server stores the family; the settings save then fails as the tab dies.
        first.settingsLog.failWrite = new Error('offline');
        const { outcome } = await createFamily(first.ctx, 'Lindqvist family');
        expect(outcome.status).toBe('pending');
        expect(first.server.sent.map((at) => at.route)).toEqual(['create']);
        // The first acceptance vouched with this device's own seed; the record is written.
        expect(first.calls('groupAccept')).toMatchObject([
            { creating: { stagedEnvelope: 'creator-seed' } },
        ]);
        expect(await store.chain(USER, GROUP)).not.toBeNull();
        const [kept] = (await loadOutbox(first.ctx)).entries;
        expect(kept).toMatchObject({ id: 'create-1', state: 'committed' });
        // Reload. The record marks the family now, so the seed is not needed to vouch again.
        const reopened = harness({ store, head: 6 });
        const resumed = await resumeOutbox(reopened.ctx);
        expect(resumed.outcomes.get('create-1')?.status).toBe('landed');
        expect(reopened.server.sent).toEqual([]);
        expect(reopened.calls('groupAccept')).toMatchObject([{ creating: null }]);
        expect(reopened.settings.doc.groups?.[GROUP]).toMatchObject({ rosterVersion: 6 });
        // Only now, with the record and the settings pin written, does the seed go.
        expect(await store.outbox(USER)).toEqual([]);
    });

    test('a creation interrupted before its first acceptance vouches with the kept seed after a reload', async () => {
        const store = createMemoryGroupStore();
        const first = harness({ store });
        first.failNext.set('groupAccept', new Error('The tab closed.'));
        expect((await createFamily(first.ctx, 'Lindqvist family')).outcome.status).toBe('pending');
        expect(await store.chain(USER, GROUP)).toBeNull();
        const reopened = harness({ store });
        await resumeOutbox(reopened.ctx);
        expect(reopened.server.sent).toEqual([]);
        expect(reopened.calls('groupAccept')).toMatchObject([
            { creating: { stagedEnvelope: 'creator-seed' } },
        ]);
        expect(await store.outbox(USER)).toEqual([]);
    });

    test('a creation sent with no answer is resent as it was, and a replay commits it', async () => {
        const store = createMemoryGroupStore();
        const first = harness({ store });
        first.server.script.push(...Array(4).fill(noAnswer()));
        expect((await createFamily(first.ctx, 'Lindqvist family')).outcome.status).toBe('pending');
        expect(first.calls('groupAccept')).toEqual([]);
        const reopened = harness({ store });
        await resumeOutbox(reopened.ctx);
        expect(
            new Set([...first.server.sent, ...reopened.server.sent].map((at) => at.body)).size,
        ).toBe(1);
        expect(reopened.calls('groupAccept')).toMatchObject([
            { creating: { stagedEnvelope: 'creator-seed' } },
        ]);
        expect(await store.outbox(USER)).toEqual([]);
    });
});

describe('review round 1', () => {
    test('a rebuild that changes anything but the rotations is refused: nothing kept, nothing sent', async () => {
        const h = harness();
        await synced(h);
        const restage = h.results.groupRestage!;
        h.results.groupRestage = (input) => {
            const out = restage(input) as { body: object };
            return { ...out, body: { ...out.body, keySeal: { envelope: 'not-signed-for' } } };
        };
        h.server.script.push(refusal(409, 'epoch-stale'));
        await expect(sendChainCall(h.ctx, entry())).rejects.toThrow(/keep its member list/);
        expect(h.server.sent).toHaveLength(1);
        const [kept] = (await loadOutbox(h.ctx, GROUP)).entries;
        expect(kept!.body).toEqual(rosterBody());
    });

    test('a rotation or stale document the server names in a folder this call does not rotate is never walked or read', async () => {
        const stranger = 'f0f0f0f0-0000-4000-8000-000000000009';
        for (const answer of [
            refusal(409, 'rotating', {
                workspaceId: stranger,
                rotationId: 'run',
                nodeId: 'n',
                targetEpoch: 3,
            }),
            refusal(409, 'document-stale', { stale: [{ workspaceId: stranger, kind: 'tags' }] }),
        ]) {
            const h = harness();
            await synced(h);
            h.server.script.push(answer);
            expect((await sendChainCall(h.ctx, entry())).status).toBe('pending');
            expect(h.rotationLog.finished).toEqual([]);
            expect(h.rotationLog.read).toEqual([]);
            expect(await h.store.outbox(USER, GROUP)).toHaveLength(1);
        }
    });

    test('a target that keeps rewriting tags stops the rebuilds after a few rounds, the call kept', async () => {
        const h = harness();
        await synced(h);
        const stale = () =>
            refusal(409, 'document-stale', { stale: [{ workspaceId: AREA, kind: 'tags' }] });
        h.server.script.push(...Array.from({ length: 10 }, stale));
        expect((await sendChainCall(h.ctx, entry())).status).toBe('pending');
        expect(h.rotationLog.read).toHaveLength(4);
        expect(h.server.sent).toHaveLength(5);
        expect(await h.store.outbox(USER, GROUP)).toHaveLength(1);
    });

    test('a creation resent after no answer and then refused is finished if the server has it, the seed kept until then', async () => {
        const store = createMemoryGroupStore();
        const first = harness({ store });
        first.server.script.push(...Array(4).fill(noAnswer()));
        expect((await createFamily(first.ctx, 'Lindqvist family')).outcome.status).toBe('pending');
        // It landed; the resend is checked before the replay is seen, and refused.
        const reopened = harness({ store, head: 6 });
        reopened.server.script.push(refusal(400, 'invalid', { reason: 'creator-identity' }));
        const resumed = await resumeOutbox(reopened.ctx);
        expect(resumed.outcomes.get('create-1')?.status).toBe('landed');
        expect(reopened.calls('groupAccept')).toMatchObject([
            { creating: { stagedEnvelope: 'creator-seed' } },
        ]);
        expect(reopened.settings.doc.groups?.[GROUP]).toBeDefined();
        expect(await store.outbox(USER)).toEqual([]);
    });

    test('a creation refused on its first send is dropped without asking the server for the family', async () => {
        const h = harness();
        h.server.script.push(refusal(409, 'group-limit'));
        expect((await createFamily(h.ctx, 'Lindqvist family')).outcome).toMatchObject({
            status: 'refused',
            code: 'group-limit',
        });
        expect(h.calls('groupAccept')).toEqual([]);
        expect(await h.store.outbox(USER)).toEqual([]);
    });

    test('a creation resent and refused that the server never stored is dropped', async () => {
        const store = createMemoryGroupStore();
        const first = harness({ store });
        first.server.script.push(...Array(4).fill(noAnswer()));
        await createFamily(first.ctx, 'Lindqvist family');
        const reopened = harness({ store });
        reopened.server.script.push(refusal(409, 'group-limit'));
        Object.assign(reopened.ctx.api, {
            rosters: async () => {
                throw refusal(404, 'not-member');
            },
        });
        const resumed = await resumeOutbox(reopened.ctx);
        expect(resumed.outcomes.get('create-1')).toMatchObject({
            status: 'refused',
            code: 'group-limit',
        });
        expect(await store.outbox(USER)).toEqual([]);
    });

    test('a sync first resends the family’s waiting call, so one that landed elsewhere is let go of', async () => {
        const h = harness();
        await synced(h);
        h.server.script.push(...Array(4).fill(noAnswer()));
        expect((await sendChainCall(h.ctx, entry())).status).toBe('pending');
        // The window regains focus: the sync sends the same bytes once, which land (a replay).
        expect((await syncGroup(h.ctx, GROUP)).status).toBe('accepted');
        expect(new Set(h.server.sent.map((at) => at.body)).size).toBe(1);
        expect(h.server.sent).toHaveLength(5);
        const order = h.worker.map((call) => call.operation);
        expect(order.lastIndexOf('groupDrop')).toBeLessThan(order.lastIndexOf('groupAccept'));
        expect(await h.store.outbox(USER, GROUP)).toEqual([]);
    });

    test('outbox records that no longer open are deleted and reported, never resent', async () => {
        const h = harness();
        await h.store.putOutbox({
            id: 'old',
            userId: USER,
            groupId: GROUP,
            envelope: 'before-rotation',
        });
        h.results.groupStoreOpen = () => ({ unreadable: true });
        const resumed = await resumeOutbox(h.ctx);
        expect(resumed.notices).toEqual([{ kind: 'changes-lost', groupId: GROUP, count: 1 }]);
        expect(h.server.sent).toEqual([]);
        expect(await h.store.outbox(USER)).toEqual([]);
    });

    test('without IndexedDB a family change is refused before anything is sent', async () => {
        const h = harness({ store: createUnavailableGroupStore() });
        await expect(createFamily(h.ctx, 'Lindqvist family')).rejects.toThrow(/site storage/);
        expect(h.server.sent).toEqual([]);
    });

    test('a document that did not open is read once more before it goes on empty, and the person is told', async () => {
        for (const stillJunk of [true, false]) {
            const h = harness();
            await synced(h);
            h.results.groupStage = (input) => ({
                outboxId: 'staged-rotate',
                body: { ...rosterBody('rotate'), expectedRevision: input.expectedRevision },
                stagedEnvelope: 'staged-secrets',
                joinCode: null,
                needsCheck: [],
                replaced: [{ workspaceId: AREA, kind: 'tags' }],
            });
            const restage = h.results.groupRestage!;
            h.results.groupRestage = (input) => ({
                ...(restage(input) as object),
                replaced: stillJunk ? [{ workspaceId: AREA, kind: 'tags' }] : [],
            });
            const staged = await stageChange(h.ctx, GROUP, {
                kind: 'rotate',
                rotation: { workspaceId: AREA, targetEpoch: 9, root: {} as never, documents: [] },
            });
            expect(h.rotationLog.read).toEqual([[{ workspaceId: AREA, kinds: ['tags'] }]]);
            if (staged.status !== 'sent' || staged.outcome.status !== 'landed')
                throw new Error(staged.status);
            expect(staged.outcome.notices).toEqual(
                stillJunk
                    ? [{ kind: 'documents-cleared', workspaceId: AREA, document: 'tags' }]
                    : [],
            );
        }
    });
});

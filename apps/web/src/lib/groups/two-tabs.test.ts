// @vitest-environment node
import type { CreateGroupBody, RosterCallBody } from '@hushos/crypto';
import { digest } from '@hushos/crypto/signatures';
import { describe, expect, test } from 'vitest';
import { GroupApiError, type GroupsApi } from './api';
import { createMemoryFamilyGuard } from '@/lib/contact-guard';
import { familyGuardOf, type GroupContext } from './context';
import { createFamily, resumeOutbox, stageChange } from './outbox';
import { createMemoryGroupStore } from './store';
import { syncGroup } from './sync';
import { account, bytes } from './worker-testkit';

/*
 * Two tabs of one account, each with its own crypto worker, sharing the
 * device store and the settings document, against the real worker (finding 2
 * of the step 4 review). Tab A sends a roster call that never hears back, so
 * its worker keeps the staged chain; tab B's open resends the same bytes,
 * they land, and B drops its copy. Tab A's next sync then meets its own
 * staged roster among the served ones, which the worker refuses to commit
 * that way; the sync must let go of it by its served bytes and accept, not
 * stay stuck until a reload.
 */

const ALICE = 'a1a1a1a1-0000-4000-8000-000000000001';

async function family() {
    const alice = await account(ALICE);
    const store = createMemoryGroupStore();
    const rosters: RosterCallBody['roster'][] = [];
    const signerKeys = {
        [await digest(bytes(alice.served.mlDsaPublicKey))]: alice.served.mlDsaPublicKey,
    };
    let created: CreateGroupBody | null = null;
    /* Sends of route 21 that get no answer (the server stores nothing). */
    let lostSends = 0;
    /* Route 1: answers lost after storing, then a refusal of the resend (checked before the replay). */
    let createAnswers: ('lost' | 'refused')[] = [];
    const head = () => ({
        version: rosters.length,
        digest: '',
        revision: rosters.length,
        groupKeyVersion: 1,
        replayed: false,
    });
    const api = {
        createGroup: async (body: CreateGroupBody) => {
            if (!created) {
                created = body;
                rosters.push(body.roster);
            }
            const next = createAnswers.shift();
            if (next === 'lost') throw new GroupApiError('no answer', 0, null, null);
            if (next === 'refused')
                throw new GroupApiError('refused', 400, 'invalid', { reason: 'creator-identity' });
            return { group: {} };
        },
        createArea: async (_groupId: string, call: RosterCallBody) => {
            if (lostSends > 0) {
                lostSends--;
                throw new GroupApiError('no answer', 0, null, null);
            }
            rosters.push(call.roster);
            return head();
        },
        rosters: async (_groupId: string, after: number) => ({
            rosters: rosters
                .slice(after)
                .map((roster, at) => ({ version: after + at + 1, ...roster })),
            successions: [],
            firstKeys: created!.groupKey,
            signerKeys: { ...signerKeys },
            head: head(),
            next: null,
        }),
        group: async () => ({ head: head() }),
        keySeal: async () => ({
            groupKeyVersion: 1,
            holderKeyVersion: 1,
            sealerUserId: ALICE,
            rosterVersion: 1,
            rosterDigest: await digest(bytes(created!.roster.statement)),
            envelope: created!.keySeal.envelope,
        }),
        identities: async () => ({
            identities: [{ userId: ALICE, identity: alice.served, links: [] }],
            next: null,
        }),
        spaces: async () => ({
            spaces: [
                {
                    space: { kind: 'group', groupId: created!.id, name: 'Lindqvist' },
                    areas: [
                        {
                            workspaceId: created!.area.workspaceId,
                            idSeed: created!.area.idSeed,
                            workspaceKeyVersion: 1,
                            changeSeq: 1,
                            root: {
                                id: created!.area.root.id,
                                parentId: null,
                                parentKeyEpoch: 1,
                                keyEpoch: 1,
                                keyEnvelope: created!.area.root.keyEnvelope,
                                metadataVersion: 1,
                                metadataEnvelope: created!.area.root.metadataEnvelope,
                                prevKeyEnvelope: null,
                                prevKeyEpoch: null,
                                prevParentKeyEpoch: null,
                            },
                            rotation: null,
                            grant: null,
                            selfGrant: created!.area.selfGrant,
                        },
                    ],
                },
            ],
        }),
        putSelfGrant: async () => ({ ok: true }),
    } as unknown as GroupsApi;
    // One browser: the tabs share the family guard, as they share IndexedDB.
    const guard = createMemoryFamilyGuard();
    const tab = async (): Promise<GroupContext> => {
        const device = await alice.device();
        return {
            userId: ALICE,
            api,
            rpc: device.call as GroupContext['rpc'],
            store,
            settings: device.settings,
            guard: familyGuardOf(() => guard, ALICE),
            lock: (_groupId, work) => work(),
            sleep: async () => {},
            now: () => new Date('2026-10-16T12:00:00.000Z'),
            identities: async () => ({ identity: alice.identity, history: [] }),
            deleteMirrors: async () => {},
            rotations: null,
        };
    };
    return {
        store,
        rosters,
        tab,
        loseNextSends: (count: number) => {
            lostSends = count;
        },
        answerCreate: (answers: ('lost' | 'refused')[]) => {
            createAnswers = answers;
        },
        /* A roster the server adds to what it serves: bytes, or a statement under forged signatures. */
        serveAlso: (roster: RosterCallBody['roster']) => rosters.push(roster),
    };
}

describe('two tabs of one account', () => {
    test('a call one tab never heard back about and the other landed does not wedge the first tab’s sync', async () => {
        const f = await family();
        const a = await f.tab();
        const { groupId, outcome } = await createFamily(a, 'Lindqvist');
        expect(outcome.status).toBe('landed');
        const b = await f.tab();
        expect((await syncGroup(b, groupId)).status).toBe('accepted');

        // Tab A: a new folder, staged in A's worker, every send lost.
        f.loseNextSends(4);
        const staged = await stageChange(a, groupId, { kind: 'area', name: 'Photos' });
        expect(staged).toMatchObject({ status: 'sent', outcome: { status: 'pending' } });
        expect(f.rosters).toHaveLength(1);

        // Tab B opens: it resends the same bytes, they land, and B lets go of the entry.
        const resumed = await resumeOutbox(b);
        expect([...resumed.outcomes.values()].map((at) => at.status)).toEqual(['landed']);
        expect(f.rosters).toHaveLength(2);
        expect(await f.store.outbox(ALICE, groupId)).toEqual([]);

        // Tab A regains focus. Its worker still holds the staged roster the server now serves.
        const synced = await syncGroup(a, groupId);
        expect(synced).toMatchObject({ status: 'accepted', view: { rosterVersion: 2 } });
    });
});

describe('what the server serves beside a staged call', () => {
    test('a stored version 1 served with a junk later roster leaves the creator’s seed row where it is', async () => {
        const f = await family();
        const a = await f.tab();
        // Stored, but no answer to the send or its resends; then the next resend is refused.
        f.answerCreate(['lost', 'lost', 'lost', 'lost', 'refused']);
        const { groupId, outcome } = await createFamily(a, 'Lindqvist');
        expect(outcome.status).toBe('pending');
        f.serveAlso({
            statement: 'AAAA',
            signature: { ed25519: 'AAAA', mlDsa: 'AAAA' },
            signerSignature: 'AAAA',
        });
        const resumed = await resumeOutbox(a);
        expect([...resumed.outcomes.values()].map((at) => at.status)).toEqual(['pending']);
        // The acceptance the refusal led to failed on the junk: the seed is still in the outbox.
        expect(await f.store.outbox(ALICE, groupId)).toHaveLength(1);
        expect(await f.store.chain(ALICE, groupId)).toBeNull();
    });

    test('a creation resent, refused, and accepted keeps its row until the settings pin is saved', async () => {
        const f = await family();
        const a = await f.tab();
        f.answerCreate(['lost', 'lost', 'lost', 'lost', 'refused']);
        const { groupId } = await createFamily(a, 'Lindqvist');
        const settings = a.settings;
        a.settings = {
            ...settings,
            write: async () => {
                throw new Error('offline');
            },
        };
        await resumeOutbox(a);
        // The record is written; the pin is not, so the seed stays.
        expect(await f.store.chain(ALICE, groupId)).not.toBeNull();
        expect(await f.store.outbox(ALICE, groupId)).toHaveLength(1);
        a.settings = settings;
        await resumeOutbox(a);
        expect(await f.store.outbox(ALICE, groupId)).toEqual([]);
    });

    test('the staged statement served under forged signatures does not drop the call', async () => {
        const f = await family();
        const a = await f.tab();
        const { groupId } = await createFamily(a, 'Lindqvist');
        f.loseNextSends(100);
        const staged = await stageChange(a, groupId, { kind: 'area', name: 'Photos' });
        if (staged.status !== 'sent') throw new Error(staged.status);
        const roster = (staged.entry.body as RosterCallBody).roster;
        f.serveAlso({
            ...roster,
            signerSignature: roster.signerSignature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A')),
        });
        await expect(syncGroup(a, groupId)).rejects.toThrow();
        expect(await f.store.outbox(ALICE, groupId)).toHaveLength(1);
    });
});

import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';
import { committedHead, headState, parseAreaList, type CommittedHead } from './area-lists';
import {
    listCaseVerdict,
    listCases,
    type ListCase,
    type ListStepVerdict,
} from './company-lists-testkit';
import { acceptRosters } from './group-trust';
import { decode, encode } from './keys';

/*
 * A folder's list over what nobody wrote by hand: the cases of
 * company-lists-testkit.ts with what the server serves dropped, repeated,
 * reordered, borrowed from another step or with a signature byte moved.
 * Whatever a device then reads, its record keeps what
 * docs/groups-invariants.md I32 to I36 promise: it stands on the base list
 * the chain names, never narrows, holds no list whose signature was moved,
 * agrees with its own state, entitles nobody who is not active, and reads
 * the same twice.
 */

let cases: ListCase[];
beforeAll(async () => {
    cases = await listCases();
}, 600_000);

const RANK: Record<string, number> = { '': 0, viewer: 1, editor: 2, manager: 3 };

const change = fc.tuple(
    fc.constantFrom('drop', 'repeat', 'swap', 'borrow', 'tamper', 'silence'),
    fc.nat(),
    fc.nat(),
    fc.nat(),
);
const reading = fc.tuple(fc.nat(), fc.array(change, { maxLength: 4 }));

/* The case at `at`, with each change made to what one of its steps is served. */
function changed([at, changes]: [number, [string, number, number, number][]]) {
    const c = cases[at % cases.length]!;
    const steps = c.steps.map((step) => ({ ...step, served: step.served && [...step.served] }));
    const tampered = new Set<string>();
    for (const [kind, s, i, j] of changes) {
        const step = steps[s % steps.length]!;
        if (kind === 'silence') {
            step.served = null;
            continue;
        }
        const served = step.served;
        if (!served || served.length === 0) continue;
        const a = i % served.length;
        const b = j % served.length;
        if (kind === 'drop') served.splice(a, 1);
        if (kind === 'repeat') served.push(served[a]!);
        if (kind === 'swap') [served[a], served[b]] = [served[b]!, served[a]!];
        if (kind === 'borrow') {
            const from = cases[j % cases.length]!.steps.find((other) => other.served?.length);
            if (from) served.push(from.served![i % from.served!.length]!);
        }
        if (kind === 'tamper') {
            const signature = decode(served[a]!.signature);
            signature[j % signature.length]! ^= 1;
            served[a] = { statement: served[a]!.statement, signature: encode(signature) };
            tampered.add(served[a]!.signature);
        }
    }
    return { c: { ...c, steps }, tampered };
}

const listed = (v: ListStepVerdict) => ('error' in v.lists ? null : v.lists);

describe('a folder’s list under whatever the server serves', () => {
    it('keeps its invariants, and reads the same twice', async () => {
        await fc.assert(
            fc.asyncProperty(reading, async (drawn) => {
                const { c, tampered } = changed(drawn);
                const verdict = await listCaseVerdict(c);
                expect(await listCaseVerdict(c)).toEqual(verdict);
                for (const [index, step] of verdict.entries()) {
                    const lists = listed(step);
                    if (!lists) continue;
                    const chain = await acceptRosters({
                        ...c.input,
                        rosters: c.input.rosters.slice(0, c.steps[index]!.through),
                    });
                    if (chain.status !== 'accepted') throw new Error('not accepted');
                    const record = lists.record;
                    if (record) {
                        // It stands on the base list the chain names for its folder key.
                        expect(record.digests[0]).toBe(
                            chain.org!.areaLists[record.workspaceId]![
                                record.workspaceKeyVersion - 1
                            ],
                        );
                        // Each list follows the one before, and only adds or raises.
                        const held = record.lists.map((at) => parseAreaList(decode(at.statement)));
                        for (const [at, list] of held.entries()) {
                            expect(list.listVersion).toBe(record.committed.listVersion + at);
                            if (at === 0) continue;
                            const next = new Map(list.people.map((p) => [p.userId, p.role]));
                            expect(RANK[list.everyone]).toBeGreaterThanOrEqual(
                                RANK[held[at - 1]!.everyone]!,
                            );
                            for (const person of held[at - 1]!.people)
                                expect(RANK[next.get(person.userId) ?? '']).toBeGreaterThanOrEqual(
                                    RANK[person.role]!,
                                );
                        }
                        // No list whose signature was moved was newly taken.
                        const earlier = index > 0 ? listed(verdict[index - 1]!) : null;
                        const before = earlier?.record?.lists ?? [];
                        for (const at of record.lists)
                            if (tampered.has(at.signature))
                                expect(before.map((b) => b.signature)).toContain(at.signature);
                        // The record agrees with the state it was read in.
                        const end = record.committed.listVersion + record.lists.length - 1;
                        if (lists.workspaceKeyVersion === record.workspaceKeyVersion) {
                            if (lists.state === 'level')
                                expect(end).toBe(record.committed.listVersion);
                            if (lists.state === 'ahead')
                                expect(end).toBeGreaterThan(record.committed.listVersion);
                        }
                        expect(lists.repost.length).toBeLessThanOrEqual(record.lists.length - 1);
                    }
                    // A device that goes on carries no open fork: what it returns beside a level
                    // or ahead reading is the note of one it settled, or of a head it passed over.
                    if (lists.state === 'level' || lists.state === 'ahead')
                        expect(lists.fork?.settled ?? true).toBe(true);
                    if (lists.state === 'forked') expect(lists.fork?.settled ?? false).toBe(false);
                    // No note is dropped by reading: every one the device held is still held.
                    const last = index > 0 ? listed(verdict[index - 1]!)?.record : null;
                    if (
                        last &&
                        lists.record &&
                        c.steps[index]!.record === undefined &&
                        last.workspaceId === lists.record.workspaceId
                    )
                        expect(lists.record.forks.length).toBeGreaterThanOrEqual(last.forks.length);
                    // Nobody who is not an active member is entitled by a list, on any reading.
                    for (const at of step.access ?? [])
                        if (at.access?.basis === 'list') {
                            const probe =
                                c.steps[index]!.probes!.access![step.access!.indexOf(at)]!;
                            const entry = chain.roster.members.find(
                                (member) => member.userId === probe.userId,
                            );
                            expect(entry?.status).toBe('active');
                        }
                    if (step.writable === 'ok') expect(['level', 'ahead']).toContain(lists.state);
                }
            }),
            { numRuns: 40 },
        );
    }, 900_000);
});

describe('the four states and the furthest head', () => {
    const digest = fc.stringMatching(/^[a-f]{4}$/);
    it('a head on the record is level at its end and ahead before it; off it, forked; past it, behind until answered', () => {
        fc.assert(
            fc.property(
                fc.integer({ min: 1, max: 50 }),
                fc.uniqueArray(digest, { minLength: 1, maxLength: 12 }),
                fc.integer({ min: 0, max: 70 }),
                digest,
                fc.constantFrom(null, true, false),
                (first, digests, position, other, reaches) => {
                    const end = first + digests.length - 1;
                    const on = digests[position - first];
                    const state = headState(
                        { first, digests },
                        { position, digest: on ?? other },
                        reaches,
                    );
                    if (position > end) expect(state).toBe(reaches === false ? 'forked' : 'behind');
                    else if (position < first) expect(state).toBe('forked');
                    else expect(state).toBe(position === end ? 'level' : 'ahead');
                    // Another digest at a position the record holds is never level or ahead.
                    if (on !== undefined && !digests.includes(other))
                        expect(
                            headState({ first, digests }, { position, digest: other }, reaches),
                        ).toBe('forked');
                },
            ),
        );
    });

    it('the committed head never moves back, whatever order rosters lower and raise it in', () => {
        const row = fc.record({
            listVersion: fc.integer({ min: 1, max: 9 }),
            shareLogIndex: fc.integer({ min: 0, max: 9 }),
        });
        fc.assert(
            fc.property(fc.array(row, { minLength: 1, maxLength: 12 }), (rows) => {
                const area = '80558a81-8dfc-8914-8447-0417b55e2ec5';
                let furthest = { list: 0, log: -1 };
                const history: CommittedHead[] = [];
                for (const [index, at] of rows.entries()) {
                    history.push({
                        rosterVersion: index + 1,
                        workspaceKeyVersion: 1,
                        listVersion: at.listVersion,
                        listDigest: `l${at.listVersion}`,
                        shareLogIndex: at.shareLogIndex,
                        shareLogDigest: `s${at.shareLogIndex}`,
                    });
                    const head = committedHead(
                        {
                            groupId: '',
                            rosterVersion: index + 1,
                            rosterDigest: '',
                            areas: { [area]: history },
                        },
                        area,
                    )!;
                    expect(head.list.listVersion).toBeGreaterThanOrEqual(furthest.list);
                    expect(head.shareLog.shareLogIndex).toBeGreaterThanOrEqual(furthest.log);
                    expect(head.list.listVersion).toBe(
                        Math.max(...history.map((r) => r.listVersion)),
                    );
                    // The first roster that committed it, not a later one that repeats it.
                    expect(head.list.rosterVersion).toBe(
                        history.find((r) => r.listVersion === head.list.listVersion)!.rosterVersion,
                    );
                    furthest = { list: head.list.listVersion, log: head.shareLog.shareLogIndex };
                }
            }),
        );
    });
});

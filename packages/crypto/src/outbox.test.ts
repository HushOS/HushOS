import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { outboxStep, readOutboxEntry } from './outbox';

/*
 * The outbox's answer table, held to the core's outbox_step by the shared
 * hand-written cases in crates/hushos-core/fixtures/outbox-steps.json (the
 * core's tests/roster_call_fixtures.rs reads the same file).
 */

const table = JSON.parse(
    readFileSync(
        new URL('../../../crates/hushos-core/fixtures/outbox-steps.json', import.meta.url),
        'utf8',
    ),
) as { cases: { status: number; code: string | null; step: string }[] };

describe('the outbox answer table (F7)', () => {
    test.each(table.cases.map((c) => [c.status, c.code, c.step] as const))(
        '%i %s is %s',
        (status, code, step) => {
            expect(outboxStep(status, code)).toBe(step);
        },
    );
});

describe('an outbox entry as the shared reader takes it', () => {
    const GROUP = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
    const entry = (body: unknown) => ({
        v: 1,
        id: 'b7a1c1d2-0000-4000-8000-000000000001',
        groupId: GROUP,
        route: { kind: 'rosters' },
        body,
        stagedEnvelope: '',
        state: 'ready',
    });
    test('the core’s body text is given back verbatim; text that is no JSON object, or not well-formed, is no entry', () => {
        const text = '{"expectedRevision":7,"roster":{"statement":"AA"}}';
        expect(readOutboxEntry(entry(text), GROUP, null)).toMatchObject({
            status: 'send',
            body: text,
        });
        expect(readOutboxEntry(entry('[1]'), GROUP, null)).toBeNull();
        expect(readOutboxEntry(entry('{"a":"\\ud800"}'), GROUP, null)).toBeNull();
        expect(readOutboxEntry(entry('not json'), GROUP, null)).toBeNull();
        // The web's object body reads as its JSON.
        expect(readOutboxEntry(entry({ expectedRevision: 7 }), GROUP, null)).toMatchObject({
            status: 'send',
            body: '{"expectedRevision":7}',
        });
    });
});

describe('an outbox entry against the committed head', () => {
    const GROUP = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
    const entry = {
        v: 1,
        id: 'b7a1c1d2-0000-4000-8000-00000000000a',
        groupId: GROUP,
        route: { kind: 'rosters' },
        body: '{"expectedRevision":7}',
        previousRosterDigest: 'head',
        rosterDigest: 'own',
        stagedEnvelope: '',
        state: 'ready',
    };
    test('superseded only by a head that passed through its own; the kept id compares without case', () => {
        const read = (head: string[], id = entry.id) =>
            readOutboxEntry(entry, GROUP, null, { id, head });
        expect(read(['elsewhere'])).toMatchObject({ status: 'send' });
        expect(read(['head', 'later'])).toMatchObject({ status: 'superseded' });
        expect(read(['head', 'own'])).toMatchObject({ status: 'landed' });
        expect(read(['head'], entry.id.toUpperCase())).toMatchObject({ status: 'send' });
    });
});

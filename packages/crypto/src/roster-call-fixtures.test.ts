import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { check, fixture, sessionRun, sessionStep } from './roster-calls-testkit';

/*
 * Roster calls (groups 1d, Core 5a) against the Rust core: the core's bodies,
 * join codes and outbox entries (src/__fixtures__/core-roster-calls.json,
 * written by crates/hushos-core/examples/roster_call_fixtures.rs) read through
 * the worker to the same outcomes, and this twin's own document built and
 * read back as the core reads it.
 */

const core = JSON.parse(
    readFileSync(new URL('./__fixtures__/core-roster-calls.json', import.meta.url), 'utf8'),
);

describe('roster calls the core built', () => {
    test('every body lands as every member would take it, every refusal is the same sentence, and every join code and outbox entry reads alike', async () => {
        await expect(check(core)).resolves.toBeUndefined();
    }, 120_000);

    test('the web’s own calls say what they declare, and read here as the core reads them', async () => {
        await expect(check(await fixture())).resolves.toBeUndefined();
    }, 120_000);
});

const sessions = JSON.parse(
    readFileSync(
        new URL('../../../crates/hushos-core/fixtures/roster-call-sessions.json', import.meta.url),
        'utf8',
    ),
) as { scenarios: { name: string; steps: unknown[]; expected: string[] }[] };

describe('a manager’s device over time (the shared session scenarios)', () => {
    test.each(sessions.scenarios.map((s) => [s.name, s] as const))(
        '%s',
        async (_, scenario) => {
            const steps = scenario.steps.map((step) => sessionStep(step as never)!);
            expect(await sessionRun(steps)).toEqual(scenario.expected);
        },
        120_000,
    );
});

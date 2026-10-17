import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    opensAsMade,
    opensAsServed,
    readSteps,
    runSteps,
    type Made,
    type Served,
} from './area-ledger-testkit';
import core from './__fixtures__/core-area-ledger.json';

/*
 * The core's run of the shared scenarios
 * (crates/hushos-core/examples/area_ledger_fixtures.rs): every step gives
 * here what it gave in the core, and every key envelope the core's ledger made
 * opens here to the key it says. The other direction is
 * crates/hushos-core/tests/area_ledger_fixtures.rs. Regenerate both with
 * `bun run fixtures:groups` at the repository root.
 */

type Scenario = { name: string; steps: Record<string, unknown>[] };
const scenarios = (
    JSON.parse(
        readFileSync(
            new URL(
                '../../../crates/hushos-core/fixtures/area-ledger-scenarios.json',
                import.meta.url,
            ),
            'utf8',
        ),
    ) as { scenarios: Scenario[] }
).scenarios;

describe('the core’s family write rules, step for step', () => {
    it('ran every scenario, serving its ledger previous-root envelopes too', () => {
        expect(core.scenarios.map((run) => run.name)).toEqual(scenarios.map((s) => s.name));
        const labels = core.scenarios.flatMap((run) => run.served.map((s) => s.label));
        expect(labels.filter((label) => label === 'previous-root').length).toBeGreaterThanOrEqual(
            5,
        );
    });

    for (const [index, scenario] of scenarios.entries())
        it(scenario.name, async () => {
            const theirs = core.scenarios[index]!;
            const ours = await runSteps(readSteps(scenario.steps)!);
            expect(ours.outcomes).toEqual(theirs.outcomes);
            expect(theirs.made.length).toBe(ours.made.length);
            for (const made of theirs.made as Made[])
                expect(await opensAsMade(made), JSON.stringify(made)).toBe(true);
            // The envelopes the core served its ledger, option A's previous-root label included.
            for (const served of theirs.served as Served[])
                expect(await opensAsServed(served), JSON.stringify(served)).toBe(true);
        });
});

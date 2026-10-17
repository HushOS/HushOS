import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readSteps, runSteps, unmet } from './area-ledger-testkit';

/*
 * The family write rules (area-ledger.ts) on the scenarios both twins run
 * (crates/hushos-core/fixtures/area-ledger-scenarios.json): every step whose
 * outcome the scenario states must give exactly it here. The core runs the
 * same file (tests/area_ledger_fixtures.rs), and each twin's fixture holds
 * every outcome for the other to match (area-ledger-fixtures.test.ts).
 */

type Scenario = { name: string; steps: ({ expect?: unknown } & Record<string, unknown>)[] };
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

describe('the family write rules, step by step', () => {
    it('has scenarios, each of whose steps fits the shape both twins read', () => {
        expect(scenarios.length).toBeGreaterThanOrEqual(14);
        for (const scenario of scenarios)
            expect(readSteps(scenario.steps), scenario.name).toBeDefined();
    });

    for (const scenario of scenarios)
        it(scenario.name, async () => {
            const { outcomes } = await runSteps(readSteps(scenario.steps)!);
            expect(unmet(scenario, outcomes)).toEqual([]);
        });
});

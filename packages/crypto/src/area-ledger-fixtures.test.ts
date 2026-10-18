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
import {
    readBack,
    rotationCases,
    shapesOf,
    walk,
    type Rotated,
    type StaleChild,
} from './rotation-testkit';
import type { RotateNodeInput } from './rotation-records';

/*
 * The core's run of the shared scenarios
 * (crates/hushos-core/examples/area_ledger_fixtures.rs): every step gives
 * here what it gave in the core, and every key envelope the core's ledger made
 * opens here to the key it says. The other direction is
 * crates/hushos-core/tests/area_ledger_fixtures.rs. The nodes the core
 * walked (`rotations`) read here as both twins declare, and walk here to the
 * same records. Regenerate both with
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

describe('the nodes the core walked, read here', () => {
    type Walked = {
        name: string;
        target: number;
        nodes: RotateNodeInput[];
        refused: string | null;
        stale: StaleChild | null;
        writes: unknown;
        rotated: Rotated[];
        served: Record<string, unknown>[][];
        expected: unknown[][];
        rekeyedInputs: unknown[];
    };
    const walked = (core as unknown as { rotations: Walked[] }).rotations;

    it('walked every case, the shared ones refused', async () => {
        const cases = await rotationCases();
        expect(walked.map((w) => w.name)).toEqual(cases.map((c) => c.name));
        expect(walked.flatMap((w) => w.rekeyedInputs).length).toBeGreaterThanOrEqual(10);
        expect(walked.filter((w) => w.refused).length).toBe(2);
    });

    it.each(walked.map((w, index) => [w.name, index] as const))('%s', async (_, index) => {
        const c = (await rotationCases())[index]!;
        const theirs = walked[index]!;
        if (c.refused) {
            // The documented difference: the core refuses, with exactly this message; the worker
            // re-seals the node's shares or links.
            expect(theirs.refused).toBe(c.refused);
            expect(theirs.rotated).toEqual([]);
            const here = await walk({ ...c, nodes: theirs.nodes });
            expect({
                shares: here.rotated.reduce((n, r) => n + r.shares, 0),
                links: here.rotated.reduce((n, r) => n + r.links, 0),
            }).toEqual(c.webReseals);
            return;
        }
        // What the core's walk wrote: the records each case says, re-keyed, re-sealed or dropped.
        expect(shapesOf(theirs.rotated)).toEqual(c.shapes);
        expect(theirs.writes ?? undefined).toEqual(c.writes);
        // Read here, on a fresh member's ledger, with the worker's own verdicts.
        const read = await readBack({ ...c, nodes: theirs.nodes }, theirs.rotated, theirs.served);
        expect(read.verdicts).toEqual(c.expected);
        expect(read.verdicts).toEqual(theirs.expected);
        if (c.key) expect(read.key).toBe(c.key);
        // And the core's nodes, walked by the worker, come out the same, with the same writes after.
        const again = await walk({ ...c, nodes: theirs.nodes, stale: theirs.stale ?? undefined });
        expect(shapesOf(again.rotated)).toEqual(c.shapes);
        expect(again.writes).toEqual(c.writes);
    });
});

import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { readSteps, runSteps, unmet } from '../src/area-ledger-testkit';
import { rotationFixture } from '../src/rotation-testkit';
import {
    deviceCases,
    mergeResult,
    run,
    says,
    storeRows,
    type MergeCase,
} from '../src/device-record-testkit';
import { servedRaceMessage } from '../src/record-acceptance';

/*
 * The family write rules as the web's ledger (src/area-ledger.ts) runs the
 * shared scenarios (crates/hushos-core/fixtures/area-ledger-scenarios.json):
 * every step's outcome and every key envelope a step made, for the Rust core
 * to match step for step and open (crates/hushos-core/tests/area_ledger_fixtures.rs).
 * Each scenario's stated outcomes are checked here before anything is
 * written. Also the nodes the web's walk rotated (`rotations`,
 * src/rotation-testkit.ts), each read back here as its case declares, for
 * the core to read. And the chain records the worker sealed with the outcomes
 * the web's order reached on them (`deviceRecords`, src/device-record-testkit.ts),
 * the data layer's own records, and the merge cases' results
 * (crates/hushos-core/fixtures/merge-pin-cases.json), each checked against its
 * case first. Fresh keys differ on every run. Regenerate with
 * `bun run fixtures:groups` at the repository root.
 */

const fixtures = new URL('../../../crates/hushos-core/fixtures/', import.meta.url);
const { scenarios } = JSON.parse(
    await readFile(new URL('area-ledger-scenarios.json', fixtures), 'utf8'),
) as { scenarios: { name: string; steps: ({ expect?: unknown } & Record<string, unknown>)[] }[] };

const runs = [];
for (const scenario of scenarios) {
    const steps = readSteps(scenario.steps);
    if (!steps) throw new Error(`${scenario.name}: a step does not fit`);
    const { outcomes, made, served, violations } = await runSteps(steps);
    const misses = [...unmet(scenario, outcomes), ...violations];
    if (misses.length) throw new Error(`${scenario.name}:\n  ${misses.join('\n  ')}`);
    runs.push({ name: scenario.name, outcomes, made, served });
}

const deviceRecords = [];
for (const c of await deviceCases()) {
    const { outcome } = await run(c);
    if (!says(outcome, c.expected)) throw new Error(`${c.name}: ${JSON.stringify(outcome)}`);
    deviceRecords.push({ ...c, outcome });
}
const { cases: merges } = JSON.parse(
    await readFile(new URL('merge-pin-cases.json', fixtures), 'utf8'),
) as { cases: MergeCase[] };
const mergePins = merges.map((c) => {
    const result = mergeResult(c);
    if (!sameJson(result, c.expected)) throw new Error(`${c.name}: ${JSON.stringify(result)}`);
    return { name: c.name, result };
});

await writeFile(
    new URL('web-area-ledger.json', fixtures),
    JSON.stringify(
        {
            generatedBy: 'packages/crypto/scripts/area-ledger-fixtures.ts',
            scenarios: runs,
            rotations: await rotationFixture(),
            deviceRecords: {
                cases: deviceRecords,
                stores: await storeRows(),
                mergePins,
                raceMessages: [servedRaceMessage(false), servedRaceMessage(true)],
            },
        },
        null,
        2,
    ) + '\n',
);
console.log('wrote crates/hushos-core/fixtures/web-area-ledger.json');

function sameJson(a: unknown, b: unknown): boolean {
    return isDeepStrictEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
}

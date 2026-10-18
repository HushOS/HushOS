import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAreaLedger } from './area-ledger';
import { chains, readSteps, runSteps, unmet } from './area-ledger-testkit';
import { wrapNodeKey } from './drive';
import { AREA, AREA_SEED, GROUP, areaKeyAt, rootKeyAt } from './group-testkit';
import { encode } from './keys';

/* The family folder's top-level node, as the shared steps name it ROOT. */
const ROOT_ID = '0e0e0e0e-0000-4000-8000-000000000001';

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
            const { outcomes, violations } = await runSteps(readSteps(scenario.steps)!);
            expect(unmet(scenario, outcomes)).toEqual([]);
            expect(violations).toEqual([]);
        });
});

describe('a family held back while a listed key opens', () => {
    it('neither keeps nor hands out a key whose envelope finished opening after an uncommit', async () => {
        const ledger = createAreaLedger();
        ledger.commit((await chains()).get('f2-v1')!);
        await ledger.openArea(GROUP, AREA, AREA_SEED, 1, areaKeyAt(AREA, 1).slice(), 1);
        const ctx = { workspaceId: AREA, parentId: AREA, parentKeyEpoch: 1, keyEpoch: 1 };
        const root = rootKeyAt(AREA, 1);
        const listing = {
            id: ROOT_ID,
            ...ctx,
            keyEnvelope: encode(
                await wrapNodeKey(root, areaKeyAt(AREA, 1), { ...ctx, nodeId: ROOT_ID }),
            ),
        };
        // The open starts before the refusal lands and finishes after it (the worker's awaits).
        const opening = ledger.openListedNode(AREA, listing);
        ledger.uncommit(GROUP);
        await expect(opening).rejects.toThrow('Check the family’s member list first.');
        // Nothing of it was kept for the next commit to hand out unopened either.
        ledger.commit((await chains()).get('f2-v1')!);
        expect(ledger.nodeKey(AREA, ROOT_ID)).toBeUndefined();
        // Break-check: with nothing between, the same listing opens.
        expect(await ledger.openListedNode(AREA, listing)).toEqual(root);
        // Cached now: no envelope to open, but the root's own check still awaits.
        const cached = ledger.openListedNode(AREA, listing);
        ledger.uncommit(GROUP);
        await expect(cached).rejects.toThrow('Check the family’s member list first.');
    });
});

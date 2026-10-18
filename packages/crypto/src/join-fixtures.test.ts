import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import core from './__fixtures__/core-join.json';
import { decode, encode } from './keys';
import {
    consentHolds,
    openCross,
    runSession,
    stepSays,
    previewDoc,
    previewSays,
    runCheck,
    runDue,
    runPreview,
    runSign,
    signSays,
    type CheckFile,
} from './join-testkit';

/*
 * The core's run of joining and consent (groups 1d, Core 4;
 * crates/hushos-core/examples/join_fixtures.rs): every join preview the core
 * ran, over the histories it signed and the records its ledger sealed,
 * reaches here the outcome it reached there; the typed-words checks agree
 * with the shared cases; the links the core offered for consent are the ones
 * offered here, its consent signs and refuses here as there, and every
 * consent the core signed holds here. The other direction is
 * crates/hushos-core/tests/join_fixtures.rs; packages/db/src/auth.consent.test.ts
 * checks the core's consent with the server's verifier.
 */

type Json = Record<string, any>;
const doc = core as Json;

describe('join previews the core ran', () => {
    it('reach here what they reached there, as both twins declare them', async () => {
        const ours = await previewDoc();
        const theirs = doc.joinPreviews;
        expect(theirs.cases.map((c: Json) => c.name)).toEqual(ours.cases.map((c: Json) => c.name));
        let codes = 0;
        for (const [index, c] of (theirs.cases as Json[]).entries()) {
            expect(c.expected, `${c.name}: declared alike`).toEqual(ours.cases[index].expected);
            const outcome = await runPreview(theirs, c);
            expect(outcome, c.name).toEqual(c.outcome);
            expect(previewSays(outcome, c.expected), c.name).toBe(true);
            if (outcome.status === 'code') codes++;
        }
        expect(codes).toBeGreaterThanOrEqual(8);
    });
});

describe('join sessions the core ran', () => {
    const file = JSON.parse(
        readFileSync(
            new URL(
                '../../../crates/hushos-core/fixtures/join-session-scenarios.json',
                import.meta.url,
            ),
            'utf8',
        ),
    );

    // Twenty-two scenarios through the real worker: past 5 s when the package's other suites share the cores.
    it('give here, step by step, what they gave in the core, as the scenarios declare', async () => {
        const runs = doc.joinSessions.runs as Json[];
        expect(runs.map((run) => run.name)).toEqual(file.scenarios.map((s: Json) => s.name));
        let steps = 0;
        for (const [index, scenario] of (file.scenarios as Json[]).entries()) {
            const ours = await runSession(doc.joinPreviews, scenario);
            expect(ours.outcomes, scenario.name).toEqual(runs[index]!.outcomes);
            for (const [at, step] of (scenario.steps as Json[]).entries()) {
                expect(stepSays(ours.outcomes, at, step.expect), `${scenario.name} ${at}`).toBe(
                    true,
                );
                steps++;
            }
        }
        expect(steps).toBeGreaterThanOrEqual(40);
    }, 60_000);

    it('open here as the core sealed them: its joins record joins, and its kept escalation holds', async () => {
        const { joined, hidden } = await openCross(doc.joinPreviews, doc.joinSessions.cross);
        expect(joined).toMatchObject({ status: 'accepted', rosterVersion: 3 });
        expect(hidden).toEqual(doc.joinSessions.cross.heldHidden);
    });
});

describe('the typed words of a join code', () => {
    const file = JSON.parse(
        readFileSync(
            new URL('../../../crates/hushos-core/fixtures/join-check-cases.json', import.meta.url),
            'utf8',
        ),
    ) as CheckFile;

    it('are checked here as the shared cases say and as the core checked them', () => {
        expect(doc.joinChecks).toHaveLength(file.cases.length);
        for (const [index, c] of file.cases.entries()) {
            expect(runCheck(file, c), c.name).toEqual(c.expected);
            expect(doc.joinChecks[index], c.name).toEqual({ name: c.name, result: c.expected });
        }
    });
});

describe('consent for earlier links', () => {
    const theirs = doc.consents;

    it('is due for the links the core found, and for no version 1 link', () => {
        for (const c of theirs.due) {
            expect(runDue(theirs, c), c.name).toEqual(c.outcome);
            expect(c.outcome, c.name).toEqual(c.expected);
        }
    });

    it('signs and refuses here as in the core, and the core’s consent holds here', async () => {
        let held = 0;
        for (const c of theirs.signs) {
            const outcome = await runSign(theirs, c);
            expect(signSays(outcome, c.outcome), c.name).toBe(true);
            expect(signSays(outcome, c.expected), c.name).toBe(true);
            if (!c.outcome.consent) continue;
            expect(await consentHolds(theirs, c, c.outcome.consent), c.name).toBe(true);
            expect(await consentHolds(theirs, c, outcome.consent), c.name).toBe(true);
            const flipped = decode(c.outcome.consent);
            flipped[4000]! ^= 1;
            expect(await consentHolds(theirs, c, encode(flipped)), c.name).toBe(false);
            held++;
        }
        expect(held).toBeGreaterThanOrEqual(2);
    });
});

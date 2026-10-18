import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import {
    consentDoc,
    consentHolds,
    previewDoc,
    previewSays,
    runCheck,
    runDue,
    runPreview,
    runSign,
    sessionFixture,
    signSays,
    type CheckFile,
} from '../src/join-testkit';

/*
 * Joining and consent (groups 1d, Core 4) as the web decides them, for the
 * Rust core to match (crates/hushos-core/tests/join_fixtures.rs): the join
 * previews the worker ran over the histories this twin signed and the records
 * its acceptance sealed, the typed-words checks of
 * crates/hushos-core/fixtures/join-check-cases.json, the join sessions of
 * crates/hushos-core/fixtures/join-session-scenarios.json, and one account's
 * identities with the links that need consent and the consent the worker
 * signed. Every case is checked against its declaration before anything is
 * written (src/join-testkit.ts). Fresh keys differ on every run. Regenerate
 * with `bun run fixtures:groups` at the repository root.
 */

const fixtures = new URL('../../../crates/hushos-core/fixtures/', import.meta.url);

const previews = await previewDoc();
for (const c of previews.cases) {
    c.outcome = await runPreview(previews, c);
    if (!previewSays(c.outcome, c.expected))
        throw new Error(`${c.name}: ${JSON.stringify(c.outcome)}`);
}

const joinSessions = await sessionFixture(
    previews,
    JSON.parse(await readFile(new URL('join-session-scenarios.json', fixtures), 'utf8')),
);

const checks = JSON.parse(
    await readFile(new URL('join-check-cases.json', fixtures), 'utf8'),
) as CheckFile;
const joinChecks = checks.cases.map((c) => {
    const result = runCheck(checks, c);
    if (!isDeepStrictEqual(result, c.expected))
        throw new Error(`${c.name}: ${JSON.stringify(result)}`);
    return { name: c.name, result };
});

const consents = await consentDoc();
for (const c of consents.due) {
    c.outcome = runDue(consents, c);
    if (!isDeepStrictEqual(c.outcome, c.expected))
        throw new Error(`${c.name}: ${JSON.stringify(c.outcome)}`);
}
for (const c of consents.signs) {
    c.outcome = await runSign(consents, c);
    if (!signSays(c.outcome, c.expected))
        throw new Error(`${c.name}: ${JSON.stringify(c.outcome)}`);
    if (c.outcome.consent && !(await consentHolds(consents, c, c.outcome.consent)))
        throw new Error(`${c.name}: the consent does not hold`);
}

await writeFile(
    new URL('web-join.json', fixtures),
    JSON.stringify(
        {
            generatedBy: 'packages/crypto/scripts/join-fixtures.ts',
            joinPreviews: previews,
            joinSessions,
            joinChecks,
            consents,
        },
        null,
        2,
    ) + '\n',
);
console.log('wrote crates/hushos-core/fixtures/web-join.json');

import { writeFile } from 'node:fs/promises';
import { fixture } from '../src/roster-calls-testkit';

/*
 * Roster calls (groups 1d, Core 5a) as the web builds them, for the Rust core
 * to read (crates/hushos-core/tests/roster_call_fixtures.rs) and the server to
 * store (packages/groups/src/server.test.ts): the family's history, every
 * call's body or refusal from the worker's groupStage, the admin's join codes
 * and the outbox entries the web keeps. Every case is checked against its
 * declaration before anything is written (src/roster-calls-testkit.ts).
 * Regenerate with `bun run fixtures:groups` at the repository root.
 */

const document = {
    generatedBy: 'packages/crypto/scripts/roster-call-fixtures.ts',
    ...(await fixture()),
};
await writeFile(
    new URL('../../../crates/hushos-core/fixtures/web-roster-calls.json', import.meta.url),
    JSON.stringify(document, null, 2) + '\n',
);
console.log('wrote crates/hushos-core/fixtures/web-roster-calls.json');

import { dbEnv } from '@hushos/env/db';
import { Client } from 'pg';
import { runAfterMigrate } from '../src/after-migrate';

/*
 * The second half of `bun run db:migrate`: the constraint validations and
 * concurrent index builds that cannot run inside drizzle's transaction
 * (src/after-migrate.ts). It connects as the migration does. A step that fails
 * is named with its SQLSTATE and left for the next run, and the command still
 * succeeds: the migration itself has committed, and nothing here is needed for
 * the application to be correct. Only failing to reach the database at all is
 * an error.
 */
const client = new Client({ connectionString: dbEnv.MIGRATION_DATABASE_URL ?? dbEnv.DATABASE_URL });
await client.connect();
try {
    const result = await runAfterMigrate((text, params) => client.query(text, params));
    for (const name of result.done) console.log(`after-migrate: ${name} done`);
    for (const failure of result.failed)
        console.warn(
            `after-migrate: ${failure.name} (${failure.kind}) failed with SQLSTATE ${failure.code}; ` +
                'it stays pending and is tried again by the next db:migrate. See docs/self-hosting.md, "After the migration".',
        );
    if (result.busy)
        console.log(
            'after-migrate: another process is running these steps; skipped here. That run does the work.',
        );
    else if (!result.done.length && !result.failed.length)
        console.log('after-migrate: nothing to do');
} finally {
    await client.end();
}

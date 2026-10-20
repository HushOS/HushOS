import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

import type { TestProject } from 'vitest/node';

/*
 * Runs once per test run. Points tests at a throwaway database beside the
 * configured one (`<name>_test`, or TEST_DATABASE_URL), creates it if missing,
 * and applies the checked-in migrations with drizzle-kit, so tests exercise the
 * same schema as production and never touch dev data.
 */
const root = new URL('../../../', import.meta.url);

function readEnv(checkout: string, key: string) {
    try {
        const text = readFileSync(join(checkout, '.env'), 'utf8');
        const line = text.split('\n').find((entry) => entry.startsWith(`${key}=`));
        return line?.slice(key.length + 1).replace(/^["']|["']$/g, '');
    } catch {
        return undefined;
    }
}

/* The base database a checkout's tests use when nothing is set in the shell. */
function baseFor(checkout: string) {
    return readEnv(checkout, 'TEST_DATABASE_URL') ?? readEnv(checkout, 'DATABASE_URL');
}

function sameDatabase(a: string, b: string) {
    const left = new URL(a);
    const right = new URL(b);
    // Port and name only: 127.0.0.1 and localhost reach the same local server.
    return (left.port || '5432') === (right.port || '5432') && left.pathname === right.pathname;
}

/* Every other checkout of this repository, or none when this is not a linked worktree. */
function otherCheckouts(here: string) {
    const git = (...args: string[]) =>
        spawnSync('git', args, { cwd: here, encoding: 'utf8' }).stdout?.trim() ?? '';
    const [common, own] = git(
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
        '--git-dir',
    ).split('\n');
    // The main checkout's git directory is the common one; only linked worktrees are checked, so a
    // worktree with a copied .env can never stop the main checkout's own tests.
    if (!common || common === own) return [];
    return git('worktree', 'list', '--porcelain')
        .split('\n')
        .filter((line) => line.startsWith('worktree '))
        .map((line) => line.slice('worktree '.length))
        .filter((path) => resolve(path) !== resolve(here));
}

/*
 * Two checkouts on the same base share `<base>_test_<package>`: one truncates or drops (foreign
 * migrations, below) the other's tables mid-run, which shows up as random deadlocks and missing
 * rows. A worktree must name a base of its own.
 */
function refuseShared(source: string, here: string) {
    for (const checkout of otherCheckouts(here)) {
        const theirs = baseFor(checkout);
        if (theirs && sameDatabase(source, theirs))
            throw new Error(
                `This worktree's test databases (${new URL(source).pathname.slice(1)}_test_*) are also ${checkout}'s. ` +
                    "Set TEST_DATABASE_URL in this worktree's .env to a base database of its own (see CONTRIBUTING.md).",
            );
    }
}

function testDatabaseFor(url: string, suffix: string) {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}_test_${suffix}`;
    return parsed.toString();
}

/* Whether the test database's ledger names a migration that is not on disk here. */
async function foreignMigrations(url: string) {
    const onDisk = new Set(
        readdirSync(new URL('packages/db/drizzle/', root)).filter((entry) =>
            /^\d{14}_/.test(entry),
        ),
    );
    const client = new Client({ connectionString: url });
    await client.connect();
    try {
        const ledger = await client.query<{ name: string }>(
            'select name from drizzle.__drizzle_migrations',
        );
        return ledger.rows.some((row) => !onDisk.has(row.name));
    } catch {
        // No ledger yet: nothing has migrated this database.
        return false;
    } finally {
        await client.end();
    }
}

/*
 * Each package gets its own database, named after the configured one plus the
 * package, because Turbo runs package test suites in parallel and they all
 * truncate between tests. TEST_DATABASE_URL overrides the base name.
 */
export function databaseSetup(suffix: string) {
    return async function setup(project: TestProject) {
        // Vitest started directly (not through `bun run`) has no .env loaded, so read it here too;
        // TEST_DATABASE_URL from either place wins over DATABASE_URL from either.
        const here = fileURLToPath(root);
        const source =
            process.env.TEST_DATABASE_URL ??
            readEnv(here, 'TEST_DATABASE_URL') ??
            process.env.DATABASE_URL ??
            readEnv(here, 'DATABASE_URL');
        if (!source) throw new Error('Set DATABASE_URL (or put it in .env) to run database tests.');
        refuseShared(source, here);
        const testUrl = testDatabaseFor(source, suffix);

        const admin = new Client({ connectionString: source });
        await admin.connect();
        const name = new URL(testUrl).pathname.slice(1);
        if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Refusing to create database "${name}".`);
        const exists = await admin.query('select 1 from pg_database where datname = $1', [name]);
        if (exists.rowCount === 0) await admin.query(`create database "${name}"`);
        // Migrated by another branch: its ledger names migrations this checkout does not have,
        // and drizzle-kit would fail on them. The database is a throwaway, so start it again.
        else if (/_test_[a-z0-9]+$/.test(name) && (await foreignMigrations(testUrl))) {
            await admin.query(`drop database "${name}" with (force)`);
            await admin.query(`create database "${name}"`);
        }
        await admin.end();

        const migrate = spawnSync('bun', ['x', 'drizzle-kit', 'migrate'], {
            cwd: new URL('packages/db/', root).pathname,
            env: { ...process.env, DATABASE_URL: testUrl, MIGRATION_DATABASE_URL: '' },
            encoding: 'utf8',
        });
        if (migrate.status !== 0)
            throw new Error(`Test database migration failed:\n${migrate.stderr}`);

        project.provide('databaseUrl', testUrl);
    };
}

declare module 'vitest' {
    export interface ProvidedContext {
        databaseUrl: string;
    }
}

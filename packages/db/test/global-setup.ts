import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

import type { TestProject } from 'vitest/node';

/*
 * Runs once per test run. Points tests at a throwaway database beside the
 * configured one (`<name>_test`, or TEST_DATABASE_URL), creates it if missing,
 * and applies the checked-in migrations with drizzle-kit, so tests exercise the
 * same schema as production and never touch dev data.
 */
const root = new URL('../../../', import.meta.url);

function readRootEnv(key: string) {
    try {
        const text = readFileSync(new URL('.env', root), 'utf8');
        const line = text.split('\n').find((entry) => entry.startsWith(`${key}=`));
        return line?.slice(key.length + 1).replace(/^["']|["']$/g, '');
    } catch {
        return undefined;
    }
}

function testDatabaseFor(url: string, suffix: string) {
    const parsed = new URL(url);
    parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}_test_${suffix}`;
    return parsed.toString();
}

/*
 * Each package gets its own database, named after the configured one plus the
 * package, because Turbo runs package test suites in parallel and they all
 * truncate between tests. TEST_DATABASE_URL overrides the base name.
 */
export function databaseSetup(suffix: string) {
    return async function setup(project: TestProject) {
        const source =
            process.env.TEST_DATABASE_URL ??
            process.env.DATABASE_URL ??
            readRootEnv('DATABASE_URL');
        if (!source) throw new Error('Set DATABASE_URL (or put it in .env) to run database tests.');
        const testUrl = testDatabaseFor(source, suffix);

        const admin = new Client({ connectionString: source });
        await admin.connect();
        const name = new URL(testUrl).pathname.slice(1);
        if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`Refusing to create database "${name}".`);
        const exists = await admin.query('select 1 from pg_database where datname = $1', [name]);
        if (exists.rowCount === 0) await admin.query(`create database "${name}"`);
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

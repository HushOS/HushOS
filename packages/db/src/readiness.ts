import { getTableName, is, sql } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import { db } from './client';
import * as schema from './schema';

/*
 * What a process needs from the database before it takes work: the schema this
 * build was made against, and the privileges its role holds on it. The worker
 * checks both at start, since a role that lacks a grant would otherwise fail
 * every job, forever, in logs that redact the reason.
 */

/* The newest migration this build knows; `readiness.test.ts` keeps it honest. */
export const LATEST_MIGRATION = '20260915165300_hybrid_shares';

/* Every application table, in name order. */
export const APP_TABLES = Object.values(schema)
    .flatMap((value) => (is(value, PgTable) ? [getTableName(value)] : []))
    .sort();

export type SchemaState = 'current' | 'behind' | 'unreadable';

/* Whether the migrations ledger names this build's newest migration; `unreadable` when the role cannot see the ledger. */
export async function schemaState(): Promise<SchemaState> {
    try {
        const result = await db.execute<{ found: boolean }>(
            sql`select exists(select 1 from drizzle.__drizzle_migrations where name = ${LATEST_MIGRATION}) as found`,
        );
        return result.rows[0]?.found ? 'current' : 'behind';
    } catch (error) {
        const code = pgCode(error);
        // No ledger yet is a database nothing has migrated; no permission is a role to fix.
        if (code === '42P01' || code === '3F000') return 'behind';
        if (code === '42501') return 'unreadable';
        throw error;
    }
}

/*
 * The application tables `role` (the connection's own by default) cannot fully
 * use, in name order. One call per privilege: a list in `has_table_privilege`
 * means any of them, not all.
 */
export async function missingTablePrivileges(role?: string) {
    const who = role ? sql`${role}::text` : sql`current_user`;
    const result = await db.execute<{ name: string; ok: boolean }>(sql`
        select t.name,
               has_table_privilege(${who}, 'public.' || quote_ident(t.name), 'SELECT')
               and has_table_privilege(${who}, 'public.' || quote_ident(t.name), 'INSERT')
               and has_table_privilege(${who}, 'public.' || quote_ident(t.name), 'UPDATE')
               and has_table_privilege(${who}, 'public.' || quote_ident(t.name), 'DELETE') as ok
        from unnest(string_to_array(${APP_TABLES.join(',')}, ',')) as t(name)
        order by t.name
    `);
    return result.rows.filter((row) => !row.ok).map((row) => row.name);
}

/* The SQLSTATE of a Postgres error, through the query wrapper that carries it. */
function pgCode(error: unknown): string | undefined {
    for (
        let current = error, depth = 0;
        current && typeof current === 'object' && depth < 3;
        depth++
    ) {
        const { code, cause } = current as { code?: unknown; cause?: unknown };
        if (typeof code === 'string') return code;
        current = cause;
    }
    return undefined;
}

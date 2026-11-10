import { readFileSync, readdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { closeDatabase } from '../test/helpers';
import { AFTER_MIGRATE, pendingAfterMigrate } from './after-migrate';
import { db } from './client';

/*
 * Constraints added NOT VALID bind new rows and were never checked against the
 * rows already there: a table is not scanned under the migration's lock, and
 * "a later release validates it". For a long time nothing made that later
 * release happen. Now every one of them must be accounted for in one of two
 * places: the step that runs after the migration (src/after-migrate.ts), which
 * validates it in a transaction of its own, or the list below, with the reason
 * it cannot be validated. Adding one NOT VALID without either fails here.
 */
const UNVALIDATED: Record<string, { table: string; migration: string; why: string }> = {};

function migrations() {
    return readdirSync(new URL('../drizzle', import.meta.url))
        .filter((name) => /^\d{14}_/.test(name))
        .sort();
}

/*
 * Every constraint a migration adds NOT VALID that no later statement of any
 * migration validates or drops, with the table and the migration.
 */
function addedUnvalidated() {
    const added = new Map<string, { name: string; table: string; migration: string }>();
    for (const migration of migrations()) {
        const statements = readFileSync(
            new URL(`../drizzle/${migration}/migration.sql`, import.meta.url),
            'utf8',
        )
            .split('--> statement-breakpoint')
            .map((statement) => statement.replace(/^--.*$/gm, '').trim());
        for (const statement of statements) {
            for (const settled of statement.matchAll(
                /(?:VALIDATE|DROP) CONSTRAINT (?:IF EXISTS )?"([^"]+)"/gi,
            ))
                added.delete(settled[1]!);
            if (!/NOT VALID;?$/.test(statement)) continue;
            // `ALTER TABLE "t" [DROP CONSTRAINT "c",] ADD CONSTRAINT "c" … NOT VALID`.
            const table = /^ALTER TABLE "([^"]+)"/.exec(statement)?.[1];
            const name = [...statement.matchAll(/ADD CONSTRAINT "([^"]+)"/g)].at(-1)?.[1];
            if (!table || !name)
                throw new Error(`An unreadable NOT VALID statement in ${migration}.`);
            added.set(name, { table, name, migration });
        }
    }
    return [...added.values()];
}

afterAll(closeDatabase);

describe('constraints added NOT VALID', () => {
    test('are each validated by the step after the migration, or listed with the reason they are not', () => {
        const validated = new Map(
            AFTER_MIGRATE.flatMap((step) =>
                step.kind === 'validate' ? [[step.name, step] as const] : [],
            ),
        );
        const added = addedUnvalidated();
        // The sixteen that earlier releases left, and the five of the outbox release.
        expect(added.length).toBeGreaterThanOrEqual(21);
        for (const constraint of added) {
            const step = validated.get(constraint.name);
            const listed = UNVALIDATED[constraint.name];
            expect(
                Boolean(step) !== Boolean(listed),
                `${constraint.name} must be validated after the migration or listed here, not both and not neither`,
            ).toBe(true);
            // The step names the table and migration the constraint really came from.
            expect(step ?? listed).toMatchObject({
                table: constraint.table,
                migration: constraint.migration,
            });
        }
        // Nothing is validated, or excused, that no migration added.
        const names = new Set(added.map((constraint) => constraint.name));
        for (const name of [...validated.keys(), ...Object.keys(UNVALIDATED)])
            expect(names.has(name), name).toBe(true);
    });

    test('in a migrated database, only the listed ones are still unvalidated', async () => {
        const found = await db.execute<{ name: string; table: string }>(sql`
            select c.conname as name, c.conrelid::regclass::text as table
            from pg_constraint c
            join pg_namespace n on n.oid = c.connamespace
            where not c.convalidated and n.nspname = 'public'
            order by c.conname
        `);
        const listed = Object.entries(UNVALIDATED)
            .map(([name, entry]) => ({ name, table: entry.table }))
            .sort((a, b) => a.name.localeCompare(b.name));
        expect(found.rows.sort((a, b) => a.name.localeCompare(b.name))).toEqual(listed);
    });

    test('nothing the step after the migration does is still pending, and its index is usable', async () => {
        expect(await pendingAfterMigrate((text, params) => db.$client.query(text, params))).toEqual(
            [],
        );
        const index = await db.execute<{ valid: boolean; definition: string }>(sql`
            select i.indisvalid as valid, pg_get_indexdef(i.indexrelid) as definition
            from pg_index i join pg_class c on c.oid = i.indexrelid
            where c.relname = 'drive_objects_store_idx'
        `);
        expect(index.rows).toEqual([
            {
                valid: true,
                definition:
                    'CREATE INDEX drive_objects_store_idx ON public.drive_objects USING btree (store_id)',
            },
        ]);
    });
});

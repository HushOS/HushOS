import { readdirSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { closeDatabase } from '../test/helpers';
import { db } from './client';
import { APP_TABLES, LATEST_MIGRATION, missingTablePrivileges, schemaState } from './readiness';

afterAll(closeDatabase);

describe('readiness', () => {
    test('LATEST_MIGRATION names the newest migration on disk', () => {
        const folders = readdirSync(new URL('../drizzle', import.meta.url))
            .filter((name) => /^\d{14}_/.test(name))
            .sort();
        expect(LATEST_MIGRATION).toBe(folders.at(-1));
    });

    test('a migrated database reads as current through the real ledger', async () => {
        expect(await schemaState()).toBe('current');
        expect(APP_TABLES).toContain('drive_objects');
        expect(APP_TABLES).toContain('server_secrets');
    });

    test('missing privileges name exactly the tables a role cannot use', async () => {
        const role = `hushos_readiness_${Date.now()}`;
        await db.execute(sql.raw(`create role ${role}`));
        try {
            expect(await missingTablePrivileges(role)).toEqual(APP_TABLES);
            await db.execute(
                sql.raw(
                    `grant select, insert, update, delete on all tables in schema public to ${role}`,
                ),
            );
            await db.execute(sql.raw(`revoke delete on drive_objects from ${role}`));
            await db.execute(sql.raw(`revoke update on sessions from ${role}`));
            expect(await missingTablePrivileges(role)).toEqual(['drive_objects', 'sessions']);
            await db.execute(sql.raw(`grant delete on drive_objects to ${role}`));
            await db.execute(sql.raw(`grant update on sessions to ${role}`));
            expect(await missingTablePrivileges(role)).toEqual([]);
        } finally {
            await db.execute(sql.raw(`drop owned by ${role}`));
            await db.execute(sql.raw(`drop role ${role}`));
        }
    });
});

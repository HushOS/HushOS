import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { closeDatabase } from '../test/helpers';
import { db } from './client';

/*
 * Constraints added NOT VALID bind new rows and were never checked against the
 * rows already there: a table is not scanned under the migration's lock, and
 * "a later release validates it". Nothing made that later release happen, so
 * the debt is written down here. Every unvalidated constraint in a migrated
 * database must be on this list, with the migration that added it and who
 * validates it, and nothing may be on the list that the database has since
 * validated. Adding one means adding a line here and saying who pays it off.
 */
const UNVALIDATED: Record<string, { table: string; migration: string; validatedBy: string }> = {
    workspaces_owner_kind_valid: {
        table: 'workspaces',
        migration: '20261016032459_workspace_owners',
        validatedBy: 'unassigned',
    },
    workspaces_owner_valid: {
        table: 'workspaces',
        migration: '20261016032459_workspace_owners',
        validatedBy: 'unassigned',
    },
    workspaces_area_valid: {
        table: 'workspaces',
        migration: '20261016032459_workspace_owners',
        validatedBy: 'unassigned',
    },
    drive_nodes_dropped_valid: {
        table: 'drive_nodes',
        migration: '20261017062152_rekeyed_origins',
        validatedBy: 'unassigned',
    },
    drive_nodes_origin_valid: {
        table: 'drive_nodes',
        migration: '20261017062152_rekeyed_origins',
        validatedBy: 'unassigned',
    },
    drive_nodes_signature_valid: {
        table: 'drive_nodes',
        migration: '20261017062152_rekeyed_origins',
        validatedBy: 'unassigned',
    },
    file_versions_dropped_valid: {
        table: 'file_versions',
        migration: '20261017062152_rekeyed_origins',
        validatedBy: 'unassigned',
    },
    file_versions_origin_valid: {
        table: 'file_versions',
        migration: '20261017062152_rekeyed_origins',
        validatedBy: 'unassigned',
    },
    file_versions_signature_valid: {
        table: 'file_versions',
        migration: '20261017062152_rekeyed_origins',
        validatedBy: 'unassigned',
    },
    drive_origin_drops_previous_valid: {
        table: 'drive_origin_drops',
        migration: '20261017153848_origin_drop_evidence',
        validatedBy: 'unassigned',
    },
    workspaces_deleted_valid: {
        table: 'workspaces',
        migration: '20261017170455_group_area_deletion',
        validatedBy: 'unassigned',
    },
    drive_uploads_move_whole: {
        table: 'drive_uploads',
        migration: '20261019181225_drive_moves',
        validatedBy: 'unassigned',
    },
    // The four below: PR 2 of docs/company-storage-design.md (section 16), whose migration
    // rewrites the outbox's key, validates them and drops the three `store_id` defaults.
    drive_objects_store_id_object_stores_id_fkey: {
        table: 'drive_objects',
        migration: '20261110000425_storage_stores',
        validatedBy: 'company-storage PR 2',
    },
    drive_uploads_store_id_object_stores_id_fkey: {
        table: 'drive_uploads',
        migration: '20261110000425_storage_stores',
        validatedBy: 'company-storage PR 2',
    },
    drive_object_deletions_store_id_object_stores_id_fkey: {
        table: 'drive_object_deletions',
        migration: '20261110000425_storage_stores',
        validatedBy: 'company-storage PR 2',
    },
    drive_uploads_multipart_started: {
        table: 'drive_uploads',
        migration: '20261110000425_storage_stores',
        validatedBy: 'company-storage PR 2',
    },
};

afterAll(closeDatabase);

describe('constraints left NOT VALID', () => {
    test('are exactly the ones written down, each on the table named', async () => {
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
        // One the database holds and the list lacks was added silently; one the list holds
        // and the database lacks was validated or dropped, and its line is to be removed.
        expect(found.rows.sort((a, b) => a.name.localeCompare(b.name))).toEqual(listed);
    });

    test('were each added, unvalidated, by the migration named', () => {
        for (const [name, entry] of Object.entries(UNVALIDATED)) {
            const statements = readFileSync(
                new URL(`../drizzle/${entry.migration}/migration.sql`, import.meta.url),
                'utf8',
            ).split('--> statement-breakpoint');
            const adds = statements.filter(
                (statement) =>
                    statement.includes(`ADD CONSTRAINT "${name}"`) &&
                    /NOT VALID;?\s*$/.test(statement.trim()),
            );
            expect(adds, `${name} in ${entry.migration}`).toHaveLength(1);
        }
    });
});

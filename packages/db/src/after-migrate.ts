/*
 * What a release needs done to the schema that must not happen inside the
 * migration. Drizzle applies every pending migration in one transaction, so a
 * statement there runs while that transaction holds whatever locks its earlier
 * statements took, and CREATE INDEX CONCURRENTLY cannot run there at all. Two
 * kinds of work therefore live here instead, and `bun run db:migrate` runs
 * them after drizzle-kit, each as a statement of its own:
 *
 * - VALIDATE CONSTRAINT, for a constraint a migration added NOT VALID. It reads
 *   the whole table under SHARE UPDATE EXCLUSIVE, which blocks no read and no
 *   write (only other schema changes and VACUUM), and for a foreign key takes
 *   ROW SHARE on the table it points at.
 * - CREATE INDEX CONCURRENTLY, for an index on a table too large to build one
 *   on under a lock that blocks writes.
 *
 * Every step is safe to run again and does nothing once done. A step that
 * fails (rows that break the constraint, a lock it could not get, an index
 * build that was interrupted) is reported by name and left for the next run:
 * nothing here is needed for the application to be correct, so it never stops
 * a deploy. The worker names what is still pending each time it starts.
 *
 * No drizzle and no application code: the migration image carries this file,
 * `pg` and the database settings, and nothing else.
 */

export type AfterMigrateStep =
    | {
          kind: 'validate';
          table: string;
          /* The constraint, as the migration named it. */
          name: string;
          /* The migration that added it NOT VALID. */
          migration: string;
      }
    | {
          kind: 'index';
          table: string;
          name: string;
          migration: string;
          /* Everything after `ON "table"`: the columns, and a WHERE for a partial index. */
          definition: string;
      };

const validate = (migration: string, table: string, names: string[]): AfterMigrateStep[] =>
    names.map((name) => ({ kind: 'validate', table, name, migration }));

export const AFTER_MIGRATE: AfterMigrateStep[] = [
    // Left unvalidated by the releases that added them, each promising a later one would.
    ...validate('20261016032459_workspace_owners', 'workspaces', [
        'workspaces_owner_kind_valid',
        'workspaces_owner_valid',
        'workspaces_area_valid',
    ]),
    ...validate('20261017062152_rekeyed_origins', 'drive_nodes', [
        'drive_nodes_dropped_valid',
        'drive_nodes_origin_valid',
        'drive_nodes_signature_valid',
    ]),
    ...validate('20261017062152_rekeyed_origins', 'file_versions', [
        'file_versions_dropped_valid',
        'file_versions_origin_valid',
        'file_versions_signature_valid',
    ]),
    ...validate('20261017153848_origin_drop_evidence', 'drive_origin_drops', [
        'drive_origin_drops_previous_valid',
    ]),
    ...validate('20261017170455_group_area_deletion', 'workspaces', ['workspaces_deleted_valid']),
    ...validate('20261019181225_drive_moves', 'drive_uploads', ['drive_uploads_move_whole']),
    // The stores release (docs/company-storage-design.md 11.1).
    ...validate('20261110000425_storage_stores', 'drive_objects', [
        'drive_objects_store_id_object_stores_id_fkey',
    ]),
    ...validate('20261110000425_storage_stores', 'drive_uploads', [
        'drive_uploads_store_id_object_stores_id_fkey',
        'drive_uploads_multipart_started',
    ]),
    ...validate('20261110000425_storage_stores', 'drive_object_deletions', [
        'drive_object_deletions_store_id_object_stores_id_fkey',
    ]),
    // The outbox release.
    ...validate('20261110025847_storage_outbox', 'drive_objects', [
        'drive_objects_backup_store_id_object_stores_id_fkey',
    ]),
    ...validate('20261110025847_storage_outbox', 'drive_object_deletions', [
        'drive_object_deletions_backup_store_id_object_stores_id_fkey',
        'drive_object_deletions_reason_valid',
        'drive_object_deletions_hold_valid',
        'drive_object_deletions_values_valid',
    ]),
    {
        kind: 'index',
        table: 'drive_objects',
        name: 'drive_objects_store_idx',
        migration: '20261110025847_storage_outbox',
        definition: '("store_id")',
    },
    // The listings that take each store's rows in turn (docs/company-storage-design.md 2.4).
    {
        kind: 'index',
        table: 'drive_object_deletions',
        name: 'drive_object_deletions_turn_idx',
        migration: '20261110063858_storage_turn_indexes',
        definition: '("store_id", "failed_at" NULLS FIRST, "created_at") WHERE done_at is null',
    },
    {
        kind: 'index',
        table: 'drive_object_deletions',
        name: 'drive_object_deletions_backup_due_idx',
        migration: '20261110063858_storage_turn_indexes',
        definition:
            '("delete_replica_after") WHERE done_at is null and primary_deleted_at is not null',
    },
    {
        kind: 'index',
        table: 'drive_uploads',
        name: 'drive_uploads_store_expiry_idx',
        migration: '20261110063858_storage_turn_indexes',
        definition:
            "(\"store_id\", \"expires_at\") WHERE status in ('open', 'completing', 'conflicted')",
    },
];

type Rows = { rows: Record<string, unknown>[] };
/* A query on one session: `pg`'s Client, or a pool for the read-only check. */
export type Query = (text: string, params?: unknown[]) => Promise<Rows>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
function quoted(name: string) {
    if (!IDENTIFIER.test(name)) throw new Error('Unexpected identifier in an after-migrate step.');
    return `"${name}"`;
}

/* 'done', 'pending', or 'broken' for an index an interrupted build left invalid. */
async function stateOf(query: Query, step: AfterMigrateStep) {
    if (step.kind === 'validate') {
        const found = await query(
            `select c.convalidated as valid
             from pg_constraint c
             join pg_class t on t.oid = c.conrelid
             join pg_namespace n on n.oid = t.relnamespace
             where n.nspname = 'public' and t.relname = $1 and c.conname = $2`,
            [step.table, step.name],
        );
        // A constraint a later migration dropped has nothing left to validate.
        if (!found.rows.length) return 'done' as const;
        return found.rows[0]!.valid ? ('done' as const) : ('pending' as const);
    }
    const found = await query(
        `select i.indisvalid as valid
         from pg_index i
         join pg_class c on c.oid = i.indexrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = $1`,
        [step.name],
    );
    if (!found.rows.length) return 'pending' as const;
    return found.rows[0]!.valid ? ('done' as const) : ('broken' as const);
}

/* The steps not done yet in the database `query` reaches. Reads the catalog and changes nothing. */
export async function pendingAfterMigrate(query: Query) {
    const pending: AfterMigrateStep[] = [];
    for (const step of AFTER_MIGRATE)
        if ((await stateOf(query, step)) !== 'done') pending.push(step);
    return pending;
}

export type AfterMigrateResult = {
    /* Another session was running the steps: nothing was looked at or done here. */
    busy: boolean;
    done: string[];
    /* What failed, by name, with the SQLSTATE and nothing a row holds. */
    failed: { name: string; kind: AfterMigrateStep['kind']; code: string }[];
};

const LOCK_NOT_AVAILABLE = '55P03';
const sqlStateOf = (error: unknown) =>
    typeof (error as { code?: unknown })?.code === 'string'
        ? (error as { code: string }).code
        : 'unknown';

/*
 * One run at a time, by a session-level advisory lock ("hushos" and "after",
 * as two integers). Two containers that start together would otherwise both
 * find the index missing, and the second would take the first one's build,
 * still in progress and so not yet valid, for one an interrupted build left
 * behind, and drop it.
 */
const AFTER_MIGRATE_LOCK = [0x68757368, 0x61667472] as const;

/*
 * Runs every pending step on `query`'s session, which must not be inside a
 * transaction: each statement is its own. A validation waits five seconds for
 * its lock, three times; an index build waits a minute for the transactions it
 * must outlast. An index a failed build left invalid is dropped and built again.
 * When another session is already running the steps this one does nothing and
 * says so (`busy`): that run does the work.
 */
export async function runAfterMigrate(
    query: Query,
    options: { pauseMs?: number } = {},
): Promise<AfterMigrateResult> {
    const result: AfterMigrateResult = { busy: false, done: [], failed: [] };
    const taken = await query(`select pg_try_advisory_lock($1, $2) as taken`, [
        ...AFTER_MIGRATE_LOCK,
    ]);
    if (!taken.rows[0]?.taken) return { ...result, busy: true };
    try {
        await runSteps(query, result, options);
    } finally {
        await query(`select pg_advisory_unlock($1, $2)`, [...AFTER_MIGRATE_LOCK]).catch(
            () => undefined,
        );
    }
    return result;
}

async function runSteps(query: Query, result: AfterMigrateResult, options: { pauseMs?: number }) {
    const pause = () => new Promise((resolve) => setTimeout(resolve, options.pauseMs ?? 2_000));
    for (const step of AFTER_MIGRATE) {
        const table = quoted(step.table);
        const name = quoted(step.name);
        try {
            const state = await stateOf(query, step);
            if (state === 'done') continue;
            if (step.kind === 'validate') {
                await query(`set lock_timeout = '5s'`);
                for (let attempt = 1; ; attempt++) {
                    try {
                        await query(`alter table ${table} validate constraint ${name}`);
                        break;
                    } catch (error) {
                        if (sqlStateOf(error) !== LOCK_NOT_AVAILABLE || attempt === 3) throw error;
                        await pause();
                    }
                }
            } else {
                await query(`set lock_timeout = '60s'`);
                if (state === 'broken') await query(`drop index concurrently if exists ${name}`);
                await query(
                    `create index concurrently if not exists ${name} on ${table} ${step.definition}`,
                );
            }
            result.done.push(step.name);
        } catch (error) {
            result.failed.push({ name: step.name, kind: step.kind, code: sqlStateOf(error) });
        }
    }
    await query(`reset lock_timeout`).catch(() => undefined);
}

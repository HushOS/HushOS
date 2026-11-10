import { sql } from 'drizzle-orm';
import {
    boolean,
    check,
    integer,
    jsonb,
    pgTable,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import { bytea } from './auth';

/*
 * Where file contents are kept, as docs/company-storage-design.md fixes it
 * (sections 2 and 11.1). A store is one S3-compatible bucket with the means to
 * use it; a region is the label people choose, pointing at one store with an
 * optional backup store. Every object, upload and outbox row names its store,
 * never null.
 *
 * The stores a deployment's environment describes are rows too, with fixed ids
 * and nothing in them: no address, no bucket, no key. A process fills those in
 * from its own variables when it opens the row, so changing `STORAGE_*` changes
 * where the row points and no secret is ever copied into the database.
 */

/* The environment's primary store (`STORAGE_*`): the column default of every `store_id`. */
export const ENVIRONMENT_PRIMARY_STORE_ID = '00000000-0000-4000-8000-000000000001';
/* The environment's replica (`STORAGE_REPLICA_*`), which only the worker can open. */
export const ENVIRONMENT_REPLICA_STORE_ID = '00000000-0000-4000-8000-000000000002';
/* The region the migration makes: the environment's primary, with its replica as the backup. */
export const DEFAULT_REGION_CODE = 'default';

export type StoreSource = 'environment' | 'database';
export type StoreKind = 'region' | 'backup' | 'company' | 'export';
export type StoreSeal = 'symmetric' | 'worker';
export type StoreStatus = 'draft' | 'checking' | 'ready' | 'failing' | 'retired';
export type BackupEvery = '5m' | 'hour' | 'day';

export const objectStores = pgTable(
    'object_stores',
    {
        id: uuid().defaultRandom().primaryKey(),
        source: text().notNull().$type<StoreSource>(),
        kind: text().notNull().$type<StoreKind>(),
        // The company of a `company` or `export` store. No foreign key: the seal binds the
        // id, and a company's store outlives its company until its deletions have drained.
        groupId: uuid('group_id'),
        endpoint: text(),
        // Where the server itself reaches the store, for an operator's store only.
        internalEndpoint: text('internal_endpoint'),
        signingRegion: text('signing_region'),
        bucket: text(),
        pathStyle: boolean('path_style'),
        // As signed URLs address it, for the Content Security Policy.
        origin: text(),
        // The last four characters of the access key id; the only part any route shows.
        keyHint: text('key_hint'),
        seal: text().$type<StoreSeal>(),
        secretKeyId: bytea('secret_key_id'),
        secretNonce: bytea('secret_nonce'),
        secretSealed: bytea('secret_sealed'),
        status: text().notNull().$type<StoreStatus>().default('draft'),
        draftUntil: timestamp('draft_until', { withTimezone: true }),
        // An environment row only: whether the worker's environment describes this store.
        // The worker writes it at start; null on every database row.
        envPresent: boolean('env_present'),
        testedAt: timestamp('tested_at', { withTimezone: true }),
        testResult: jsonb('test_result'),
        probedAt: timestamp('probed_at', { withTimezone: true }),
        probeFailures: integer('probe_failures').notNull().default(0),
        auditPassStartedAt: timestamp('audit_pass_started_at', { withTimezone: true }),
        auditPassFinishedAt: timestamp('audit_pass_finished_at', { withTimezone: true }),
        // What its owner says about where the bucket is; nothing checks it.
        statedLocation: text('stated_location'),
        // Raised by every change to the row: an opened store is cached by id and version.
        version: integer().notNull().default(1),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        check('object_stores_source_valid', sql`${table.source} in ('environment', 'database')`),
        check(
            'object_stores_kind_valid',
            sql`${table.kind} in ('region', 'backup', 'company', 'export')`,
        ),
        check(
            'object_stores_status_valid',
            sql`${table.status} in ('draft', 'checking', 'ready', 'failing', 'retired')`,
        ),
        check(
            'object_stores_seal_valid',
            sql`${table.seal} is null or (${table.seal} in ('symmetric', 'worker') and (${table.seal} = 'symmetric') = (${table.kind} in ('region', 'company')))`,
        ),
        // A company's store and its export target belong to a company; an operator's to none.
        check(
            'object_stores_group_valid',
            sql`(${table.kind} in ('company', 'export')) = (${table.groupId} is not null)`,
        ),
        check(
            'object_stores_internal_endpoint_valid',
            sql`${table.internalEndpoint} is null or ${table.kind} in ('region', 'backup')`,
        ),
        // The environment's stores are the two fixed rows and nothing else: the primary a
        // region's store, the replica a backup.
        check(
            'object_stores_environment_fixed',
            sql`(${table.source} = 'environment') = (${table.id} in ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002')) and (${table.id} <> '00000000-0000-4000-8000-000000000001' or ${table.kind} = 'region') and (${table.id} <> '00000000-0000-4000-8000-000000000002' or ${table.kind} = 'backup')`,
        ),
        // An environment row holds no address, bucket or secret, is never a draft or retired,
        // and says whether its variables are set.
        check(
            'object_stores_environment_empty',
            sql`${table.source} <> 'environment' or (${table.endpoint} is null and ${table.internalEndpoint} is null and ${table.signingRegion} is null and ${table.bucket} is null and ${table.pathStyle} is null and ${table.origin} is null and ${table.keyHint} is null and ${table.seal} is null and ${table.secretKeyId} is null and ${table.secretNonce} is null and ${table.secretSealed} is null and ${table.draftUntil} is null and ${table.groupId} is null and ${table.status} in ('ready', 'failing') and ${table.envPresent} is not null)`,
        ),
        // A database row carries its whole address. What its sealed secret must look like is
        // for the code that seals it to say.
        check(
            'object_stores_database_address',
            sql`${table.source} <> 'database' or (${table.endpoint} is not null and ${table.signingRegion} is not null and ${table.bucket} is not null and ${table.pathStyle} is not null and ${table.envPresent} is null)`,
        ),
        check(
            'object_stores_values_valid',
            sql`${table.version} >= 1 and ${table.probeFailures} >= 0 and (${table.keyHint} is null or char_length(${table.keyHint}) <= 4) and (${table.secretKeyId} is null or octet_length(${table.secretKeyId}) = 8)`,
        ),
    ],
);

export const storageRegions = pgTable(
    'storage_regions',
    {
        id: uuid().defaultRandom().primaryKey(),
        code: text().notNull().unique(),
        label: text().notNull(),
        // Where new uploads of this region go and its objects live. Never null.
        storeId: uuid('store_id')
            .notNull()
            .references(() => objectStores.id),
        // Null means the region has no backup, and nothing else.
        backupStoreId: uuid('backup_store_id').references(() => objectStores.id),
        backupEvery: text('backup_every').notNull().$type<BackupEvery>().default('5m'),
        // Whether deleted files' backup copies are removed by HushOS, 30 days on.
        backupPrune: boolean('backup_prune').notNull().default(false),
        isDefault: boolean('is_default').notNull().default(false),
        // Whether a company may pick it.
        offered: boolean().notNull().default(false),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // One default region: where personal spaces and families upload.
        uniqueIndex('storage_regions_one_default')
            .on(table.isDefault)
            .where(sql`is_default`),
        check('storage_regions_code_valid', sql`${table.code} ~ '^[a-z][a-z0-9-]{0,31}$'`),
        check('storage_regions_label_valid', sql`char_length(${table.label}) between 1 and 80`),
        check(
            'storage_regions_backup_every_valid',
            sql`${table.backupEvery} in ('5m', 'hour', 'day')`,
        ),
        check(
            'storage_regions_backup_distinct',
            sql`${table.backupStoreId} is null or ${table.backupStoreId} <> ${table.storeId}`,
        ),
    ],
);

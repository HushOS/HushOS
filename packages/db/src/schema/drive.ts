import { sql } from 'drizzle-orm';
import {
    type AnyPgColumn,
    bigint,
    boolean,
    check,
    foreignKey,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    smallint,
    text,
    timestamp,
    unique,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import { bytea, users } from './auth';
import { workspaces } from './workspaces';

/*
 * Drive, as fixed by docs/drive-design.md. The tree is an adjacency list in
 * `drive_nodes`; a file's bytes are a `drive_objects` row in the store, pointed at
 * by a `file_versions` row that also carries the wrap of the object's content key
 * under the node's key. Byte counts are bigint; envelopes are bytea with length
 * checks. The server sees no key, no name and no plaintext byte: every envelope
 * column is opaque here and opened only in the client's crypto worker.
 */

export const driveNodes = pgTable(
    'drive_nodes',
    {
        id: uuid().primaryKey(), // client-generated
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        parentId: uuid('parent_id'), // null only for the root
        kind: text().notNull().$type<'folder' | 'file'>(),
        keyEpoch: integer('key_epoch').notNull(),
        parentKeyEpoch: integer('parent_key_epoch').notNull(),
        keyEnvelope: bytea('key_envelope'), // null once purged (tombstone)
        prevKeyEnvelope: bytea('prev_key_envelope'), // during a rotation only: the previous key ...
        prevKeyEpoch: integer('prev_key_epoch'), // ... at its epoch ...
        prevParentKeyEpoch: integer('prev_parent_key_epoch'), // ... under the previous parent key
        metadataVersion: integer('metadata_version').notNull().default(1),
        metadataEnvelope: bytea('metadata_envelope'), // null once purged
        // How the key and metadata envelopes are sealed; readers refuse a suite they do not know.
        envelopeSuite: smallint('envelope_suite').notNull().default(1),
        // Who wrote the metadata envelope, and their Ed25519 signature over it (see
        // docs/integrity-design.md). The server checked it on write; readers check again.
        // Null on nodes written before signatures; the signer goes with a deleted account.
        metadataSignerId: uuid('metadata_signer').references(() => users.id, {
            onDelete: 'set null',
        }),
        metadataSignature: bytea('metadata_signature'),
        /*
         * A re-keyed record's origin (docs/integrity-design.md, "Re-keyed records"): the
         * envelope its writer signed, under the node key before a rotation; the writer and
         * their signature, copied by the server from the row as it stood; the key that opens
         * that envelope alone, wrapped under the current node key; and the re-keyer's
         * signature over the binding. The re-keyer is `metadata_signer`, who sealed the
         * current envelope. The origin signer has no foreign key: a deleted account leaves
         * its id (never null while an origin is kept), so a gone writer reads as
         * someone unknown while the re-keyer still verifies. All null on a record no rotation re-keyed, and cleared by every write
         * that sets the envelope outside a rotation.
         */
        metadataOriginEnvelope: bytea('metadata_origin_envelope'),
        metadataOriginKeyEnvelope: bytea('metadata_origin_key_envelope'),
        metadataOriginSignerId: uuid('metadata_origin_signer'),
        metadataOriginSignature: bytea('metadata_origin_signature'),
        metadataRekeySignature: bytea('metadata_rekey_signature'),
        /*
         * Evidence that a rotation dropped a kept origin (it did not bind for the rotating
         * client, or so it said): whose signature it carried and who dropped it, the first
         * drop until the record is purged (a rename keeps it, so it cannot hide a drop). The
         * server cannot check binding, so it keeps the trace, for Info and in
         * drive_origin_drops. Readers name nobody from it that a signature does not confirm.
         */
        metadataDroppedSignerId: uuid('metadata_dropped_signer'),
        metadataOriginDroppedBy: uuid('metadata_origin_dropped_by'),
        currentVersionId: uuid('current_version_id').references(
            (): AnyPgColumn => fileVersions.id,
            { onDelete: 'set null' },
        ),
        createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
        trashedAt: timestamp('trashed_at', { withTimezone: true }),
        // Trashed by an operator acting on a report: the owner cannot restore it.
        removedAt: timestamp('removed_at', { withTimezone: true }),
        heightBound: integer('height_bound').notNull().default(0),
        changeSeq: bigint('change_seq', { mode: 'number' }), // null until visible
        purgedAt: timestamp('purged_at', { withTimezone: true }),
        // A tombstone's ancestors when it was purged, root first: a share's feed shows a
        // deletion only to grantees of a share above it. Null on tombstones older than
        // this, which no grantee is shown.
        purgedAncestorIds: uuid('purged_ancestor_ids').array(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // Exactly one root per workspace, and the parent FK carries the workspace so a
        // node can never be parented across workspaces.
        uniqueIndex('drive_nodes_one_root')
            .on(table.workspaceId)
            .where(sql`parent_id is null`),
        unique('drive_nodes_id_workspace').on(table.id, table.workspaceId),
        foreignKey({
            name: 'drive_nodes_parent_fk',
            columns: [table.parentId, table.workspaceId],
            foreignColumns: [table.id, table.workspaceId],
        }), // no cascade: tombstones are removed leaves first
        index('drive_nodes_parent_idx')
            .on(table.parentId)
            .where(sql`trashed_at is null`),
        // Unique: a change feed pages on change_seq alone, so two rows sharing one would let a
        // page end between them and the next page, asking for what follows, skip the other.
        uniqueIndex('drive_nodes_change_idx')
            .on(table.workspaceId, table.changeSeq)
            .where(sql`change_seq is not null`),
        index('drive_nodes_trash_idx')
            .on(table.workspaceId, table.trashedAt)
            .where(sql`trashed_at is not null`),
        index('drive_nodes_purged_idx')
            .on(table.workspaceId, table.purgedAt)
            .where(sql`purged_at is not null`),
        // Deleting an account clears its name from what it signed without a full scan.
        index('drive_nodes_signer_idx')
            .on(table.metadataSignerId)
            .where(sql`metadata_signer is not null`),
        check('drive_nodes_kind_valid', sql`${table.kind} in ('folder', 'file')`),
        check(
            'drive_nodes_root_is_folder',
            sql`${table.parentId} is not null or ${table.kind} = 'folder'`,
        ),
        check(
            'drive_nodes_versions_valid',
            sql`${table.keyEpoch} >= 1 and ${table.parentKeyEpoch} >= 1 and ${table.metadataVersion} >= 1 and ${table.heightBound} >= 0 and (${table.prevParentKeyEpoch} is null or ${table.prevParentKeyEpoch} >= 1)`,
        ),
        check(
            'drive_nodes_envelopes_valid',
            sql`(${table.purgedAt} is not null and ${table.keyEnvelope} is null and ${table.metadataEnvelope} is null and ${table.prevKeyEnvelope} is null) or (${table.purgedAt} is null and octet_length(${table.keyEnvelope}) = 72 and octet_length(${table.metadataEnvelope}) between 42 and 4136)`,
        ),
        check(
            'drive_nodes_prev_envelope_valid',
            sql`(${table.prevKeyEnvelope} is null) = (${table.prevParentKeyEpoch} is null) and (${table.prevKeyEnvelope} is null) = (${table.prevKeyEpoch} is null) and (${table.prevKeyEnvelope} is null or (octet_length(${table.prevKeyEnvelope}) = 72 and ${table.prevKeyEpoch} >= 1))`,
        ),
        // A re-keyed record may carry no legacy signature: its signer is then the re-keyer alone.
        check(
            'drive_nodes_signature_valid',
            sql`(${table.metadataSignature} is null and (${table.metadataSignerId} is null or ${table.metadataRekeySignature} is not null)) or (${table.metadataSignature} is not null and octet_length(${table.metadataSignature}) = 64 and ${table.metadataEnvelope} is not null)`,
        ),
        check(
            'drive_nodes_dropped_valid',
            sql`(${table.metadataDroppedSignerId} is null) = (${table.metadataOriginDroppedBy} is null)`,
        ),
        check(
            'drive_nodes_origin_valid',
            sql`(${table.metadataOriginEnvelope} is null and ${table.metadataOriginKeyEnvelope} is null and ${table.metadataOriginSignerId} is null and ${table.metadataOriginSignature} is null and ${table.metadataRekeySignature} is null) or (${table.metadataOriginEnvelope} is not null and ${table.metadataOriginSignerId} is not null and ${table.metadataOriginKeyEnvelope} is not null and ${table.metadataOriginSignature} is not null and ${table.metadataRekeySignature} is not null and ${table.metadataEnvelope} is not null and octet_length(${table.metadataOriginEnvelope}) between 42 and 4136 and octet_length(${table.metadataOriginKeyEnvelope}) = 72 and octet_length(${table.metadataOriginSignature}) = 64 and octet_length(${table.metadataRekeySignature}) = 64)`,
        ),
        check(
            'drive_nodes_file_has_no_children_marker',
            sql`${table.kind} = 'folder' or ${table.heightBound} = 0`,
        ),
    ],
);

export const driveObjects = pgTable(
    'drive_objects',
    {
        id: uuid().primaryKey(), // client-generated
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        objectKey: text('object_key').notNull().unique(), // "ws/{workspaceId}/{objectId}"
        contentSuite: smallint('content_suite').notNull().default(1),
        chunkSize: integer('chunk_size').notNull(),
        chunkCount: integer('chunk_count').notNull(),
        contentNonce: bytea('content_nonce').notNull(),
        // Suite 1 only. Under suites 2 and 3 the version envelope holds it, so the server cannot
        // subtract it from the stored size and learn whether a thumbnail trailer is there.
        plaintextSize: bigint('plaintext_size', { mode: 'bigint' }),
        // Declared by the client at begin (the trailer and, under suite 3, the padding included)
        // and confirmed at the store; what the allowance is charged.
        ciphertextSize: bigint('ciphertext_size', { mode: 'bigint' }).notNull(),
        status: text().notNull().$type<'pending' | 'ready' | 'missing'>().default('pending'),
        storageClass: text('storage_class')
            .notNull()
            .$type<'standard' | 'cold'>()
            .default('standard'),
        replicatedAt: timestamp('replicated_at', { withTimezone: true }),
        lastReadAt: timestamp('last_read_at', { withTimezone: true }),
        // When the audit last confirmed the object at the store; least recent goes first.
        auditedAt: timestamp('audited_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        readyAt: timestamp('ready_at', { withTimezone: true }),
    },
    (table) => [
        index('drive_objects_workspace_idx').on(table.workspaceId),
        index('drive_objects_audit_idx')
            .on(table.auditedAt)
            .where(sql`status in ('ready', 'missing')`),
        index('drive_objects_tier_idx')
            .on(table.storageClass, table.lastReadAt)
            .where(sql`status = 'ready'`),
        check(
            'drive_objects_status_valid',
            sql`${table.status} in ('pending', 'ready', 'missing')`,
        ),
        check('drive_objects_class_valid', sql`${table.storageClass} in ('standard', 'cold')`),
        check(
            'drive_objects_framing_valid',
            sql`${table.chunkSize} > 0 and ${table.chunkCount} >= 1 and octet_length(${table.contentNonce}) = 16 and ((${table.contentSuite} = 1 and ${table.plaintextSize} >= 0 and ${table.ciphertextSize} = ${table.plaintextSize} + 16 * ${table.chunkCount}) or (${table.contentSuite} in (2, 3) and ${table.plaintextSize} is null and ${table.ciphertextSize} >= 16 * ${table.chunkCount}))`,
        ),
    ],
);

export const fileVersions = pgTable(
    'file_versions',
    {
        id: uuid().primaryKey(), // client-generated
        nodeId: uuid('node_id')
            .notNull()
            .references(() => driveNodes.id, { onDelete: 'cascade' }),
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        // Null only once purged: retiring the object clears the pointer.
        objectId: uuid('object_id').references(() => driveObjects.id, { onDelete: 'set null' }),
        // 72 bytes under suite 1 (the key), 84 under suites 2 and 3 (the key with the sizes); null once purged.
        contentKeyEnvelope: bytea('content_key_envelope'),
        // Who sealed the content-key envelope, and their signature over the version; null
        // before signatures and once purged.
        signerId: uuid('signer').references(() => users.id, { onDelete: 'set null' }),
        signature: bytea('signature'),
        // A re-keyed version's origin, as on drive_nodes: the writer's envelope (the same
        // length as the current one, so the same suite), its signer (no foreign key) and
        // signature, its opening key under the node key, and the re-keyer's signature.
        originEnvelope: bytea('origin_envelope'),
        originKeyEnvelope: bytea('origin_key_envelope'),
        originSignerId: uuid('origin_signer'),
        originSignature: bytea('origin_signature'),
        rekeySignature: bytea('rekey_signature'),
        // As on drive_nodes: who signed a dropped origin, and who dropped it.
        droppedSignerId: uuid('dropped_signer'),
        originDroppedBy: uuid('origin_dropped_by'),
        status: text().notNull().$type<'pending' | 'ready' | 'purged'>().default('pending'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        readyAt: timestamp('ready_at', { withTimezone: true }),
        supersededAt: timestamp('superseded_at', { withTimezone: true }),
        purgedAt: timestamp('purged_at', { withTimezone: true }),
    },
    (table) => [
        index('file_versions_object_idx').on(table.objectId),
        index('file_versions_node_idx').on(table.nodeId),
        index('file_versions_signer_idx')
            .on(table.signerId)
            .where(sql`signer is not null`),
        index('file_versions_superseded_idx')
            .on(table.workspaceId, table.supersededAt)
            .where(sql`superseded_at is not null and purged_at is null`),
        check('file_versions_status_valid', sql`${table.status} in ('pending', 'ready', 'purged')`),
        check(
            'file_versions_envelope_valid',
            sql`(${table.status} = 'purged' and ${table.contentKeyEnvelope} is null and ${table.purgedAt} is not null) or (${table.status} <> 'purged' and octet_length(${table.contentKeyEnvelope}) in (72, 84) and ${table.objectId} is not null)`,
        ),
        check(
            'file_versions_signature_valid',
            sql`(${table.signature} is null and (${table.signerId} is null or ${table.rekeySignature} is not null)) or (${table.signature} is not null and octet_length(${table.signature}) = 64 and ${table.contentKeyEnvelope} is not null)`,
        ),
        check(
            'file_versions_dropped_valid',
            sql`(${table.droppedSignerId} is null) = (${table.originDroppedBy} is null)`,
        ),
        check(
            'file_versions_origin_valid',
            sql`(${table.originEnvelope} is null and ${table.originKeyEnvelope} is null and ${table.originSignerId} is null and ${table.originSignature} is null and ${table.rekeySignature} is null) or (${table.originEnvelope} is not null and ${table.originSignerId} is not null and ${table.originKeyEnvelope} is not null and ${table.originSignature} is not null and ${table.rekeySignature} is not null and ${table.contentKeyEnvelope} is not null and octet_length(${table.originEnvelope}) in (72, 84) and octet_length(${table.originEnvelope}) = octet_length(${table.contentKeyEnvelope}) and octet_length(${table.originKeyEnvelope}) = 72 and octet_length(${table.originSignature}) = 64 and octet_length(${table.rekeySignature}) = 64)`,
        ),
    ],
);

/*
 * Every origin a rotation dropped (docs/integrity-design.md, "What the server
 * enforces"): the record, the dropped origin whole (envelope, signer,
 * signature, its wrap and the previous re-keyer's binding), who dropped it and
 * at which epoch. Ciphertext, signatures and uuids only. Append-only evidence: a rotating member
 * (or a departing one's poisoned wraps) can make an honest client drop an
 * origin the server cannot check, so the drop is kept even after the record
 * is written again. Ids are plain uuids, as an origin's signer is.
 */
export const driveOriginDrops = pgTable(
    'drive_origin_drops',
    {
        id: uuid().defaultRandom().primaryKey(),
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        nodeId: uuid('node_id').notNull(),
        // The metadata record at its version, or one version of a file.
        metadataVersion: integer('metadata_version'),
        versionId: uuid('version_id'),
        // The dropped origin whole, with the wrap that was to open it and the binding the
        // previous re-keyer signed over both: with the node key at that epoch, a reader can tell
        // a poisoned wrap (the previous re-keyer's fault) from a dropper who lied about it.
        originSignerId: uuid('origin_signer').notNull(),
        originEnvelope: bytea('origin_envelope').notNull(),
        originSignature: bytea('origin_signature').notNull(),
        originKeyEnvelope: bytea('origin_key_envelope').notNull(),
        previousRekeySignature: bytea('previous_rekey_signature').notNull(),
        // Null once that account is gone (the row's signer column is nulled with it).
        previousRekeyerId: uuid('previous_rekeyer'),
        // The rest of what the previous re-keyer's statement covers, which the drop overwrites
        // (the envelope they sealed and its epoch) or a purge takes (the version's object and
        // suite): with them the row alone rebuilds that statement. Null on drops recorded before
        // they were kept; whole on every drop since.
        previousEnvelope: bytea('previous_envelope'),
        previousKeyEpoch: integer('previous_key_epoch'),
        nodeKind: text('node_kind').$type<'folder' | 'file'>(),
        objectId: uuid('object_id'),
        contentSuite: smallint('content_suite'),
        droppedBy: uuid('dropped_by').notNull(),
        targetEpoch: integer('target_epoch').notNull(),
        droppedAt: timestamp('dropped_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index('drive_origin_drops_node_idx').on(table.workspaceId, table.nodeId),
        check(
            'drive_origin_drops_valid',
            sql`(${table.metadataVersion} is null) <> (${table.versionId} is null) and octet_length(${table.originEnvelope}) between 42 and 4136 and octet_length(${table.originSignature}) = 64 and octet_length(${table.originKeyEnvelope}) = 72 and octet_length(${table.previousRekeySignature}) = 64 and ${table.targetEpoch} >= 1`,
        ),
        check(
            'drive_origin_drops_previous_valid',
            sql`(${table.previousEnvelope} is null and ${table.previousKeyEpoch} is null and ${table.nodeKind} is null and ${table.objectId} is null and ${table.contentSuite} is null) or (${table.previousEnvelope} is not null and ${table.previousKeyEpoch} is not null and ${table.previousKeyEpoch} >= 1 and ${table.previousKeyEpoch} < ${table.targetEpoch} and ((${table.metadataVersion} is not null and ${table.nodeKind} is not null and ${table.nodeKind} in ('folder', 'file') and ${table.objectId} is null and ${table.contentSuite} is null and octet_length(${table.previousEnvelope}) between 42 and 4136) or (${table.versionId} is not null and ${table.nodeKind} is null and ${table.objectId} is not null and ${table.contentSuite} is not null and ((${table.contentSuite} = 1 and octet_length(${table.previousEnvelope}) = 72) or (${table.contentSuite} in (2, 3) and octet_length(${table.previousEnvelope}) = 84)) and octet_length(${table.previousEnvelope}) = octet_length(${table.originEnvelope}))))`,
        ),
    ],
);

export const driveUploads = pgTable(
    'drive_uploads',
    {
        id: uuid().defaultRandom().primaryKey(),
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        nodeId: uuid('node_id')
            .notNull()
            .references(() => driveNodes.id, { onDelete: 'cascade' }),
        versionId: uuid('version_id')
            .notNull()
            .references(() => fileVersions.id, { onDelete: 'cascade' }),
        // The upload outlives its object row (aborted, then retired through the outbox).
        objectId: uuid('object_id').references(() => driveObjects.id, { onDelete: 'set null' }),
        objectKey: text('object_key').notNull(),
        // The node key epoch the content-key envelope was wrapped under, and the
        // node's current version when the upload began: complete re-checks both.
        keyEpoch: integer('key_epoch').notNull(),
        expectedVersionId: uuid('expected_version_id'),
        newNode: boolean('new_node').notNull().default(false),
        multipartId: text('multipart_id').notNull(),
        reservedBytes: bigint('reserved_bytes', { mode: 'bigint' }).notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        status: text()
            .notNull()
            .$type<'open' | 'completing' | 'conflicted' | 'completed' | 'aborted'>()
            .default('open'),
        completingAt: timestamp('completing_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        /*
         * A move from another workspace of the same pool (docs/families-shared-pool.md
         * 3.8): the file it replaces, as begin found it (its node's change sequence and
         * current version, and the bytes its versions free), and who moved it. Completion
         * removes that file in its own transaction, or fails `stale` if it changed. No
         * foreign keys: a source workspace deleted meanwhile makes the move stale, never a
         * plain upload. Null for every other upload.
         */
        moveWorkspaceId: uuid('move_workspace_id'),
        moveNodeId: uuid('move_node_id'),
        moveVersionId: uuid('move_version_id'),
        moveChangeSeq: bigint('move_change_seq', { mode: 'number' }),
        moveFreedBytes: bigint('move_freed_bytes', { mode: 'bigint' }),
        moveBy: uuid('move_by'),
    },
    (table) => [
        index('drive_uploads_expiry_idx')
            .on(table.expiresAt)
            .where(sql`status in ('open', 'completing', 'conflicted')`),
        index('drive_uploads_node_idx').on(table.nodeId),
        // One live move per file: the bytes it frees are counted once, never by two moves at once.
        uniqueIndex('drive_uploads_one_move_idx')
            .on(table.moveNodeId)
            .where(
                sql`status in ('open', 'completing', 'conflicted') and move_node_id is not null`,
            ),
        check(
            'drive_uploads_move_whole',
            sql`(${table.moveNodeId} is null) = (${table.moveWorkspaceId} is null) and (${table.moveNodeId} is null) = (${table.moveVersionId} is null) and (${table.moveNodeId} is null) = (${table.moveChangeSeq} is null) and (${table.moveNodeId} is null) = (${table.moveFreedBytes} is null) and (${table.moveNodeId} is null) = (${table.moveBy} is null) and (${table.moveFreedBytes} is null or ${table.moveFreedBytes} >= 0)`,
        ),
        check(
            'drive_uploads_status_valid',
            sql`${table.status} in ('open', 'completing', 'conflicted', 'completed', 'aborted')`,
        ),
        check(
            'drive_uploads_values_valid',
            sql`${table.keyEpoch} >= 1 and ${table.reservedBytes} >= 0 and (${table.status} <> 'completing' or ${table.completingAt} is not null) and (${table.status} in ('aborted', 'completed') or ${table.objectId} is not null)`,
        ),
    ],
);

/*
 * The outbox every object deletion goes through. Not keyed to the workspace or
 * the object by FK: the row outlives both, which is the point.
 */
export const driveObjectDeletions = pgTable(
    'drive_object_deletions',
    {
        objectId: uuid('object_id').primaryKey(),
        workspaceId: uuid('workspace_id').notNull(),
        objectKey: text('object_key').notNull(),
        published: boolean().notNull(),
        replicated: boolean().notNull().default(false),
        primaryDeletedAt: timestamp('primary_deleted_at', { withTimezone: true }),
        deleteReplicaAfter: timestamp('delete_replica_after', { withTimezone: true }),
        doneAt: timestamp('done_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index('drive_object_deletions_pending_idx')
            .on(table.createdAt)
            .where(sql`done_at is null`),
    ],
);

/*
 * Where a rolling sweep left off, one row per sweep. The orphan sweep walks the
 * bucket a bounded page at a time and continues from here on its next run.
 */
export const driveSweeps = pgTable('drive_sweeps', {
    name: text().primaryKey(),
    cursor: text(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/*
 * A share: one node's key sealed to one grantee, with a role. The envelope's
 * length names its suite: 72 bytes sealed between the two identities' X25519
 * keys (1), 1160 with an ML-KEM-768 ciphertext beside it (2), 1256 with an
 * ephemeral X25519 key and the granter's Ed25519 signature (3), and 4565 with
 * the granter's hybrid signature (4, the only one written or served now; see
 * docs/identity-pq-design.md). The server holds only public halves. Revocation is a timestamp the walk consults live; the previous envelope
 * exists for rotations, which re-seal the remaining shares under both keys.
 */
export const driveShares = pgTable(
    'drive_shares',
    {
        id: uuid().defaultRandom().primaryKey(),
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        nodeId: uuid('node_id')
            .notNull()
            .references(() => driveNodes.id, { onDelete: 'cascade' }),
        granterUserId: uuid('granter_user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        granteeUserId: uuid('grantee_user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        role: text().notNull().$type<'viewer' | 'editor'>(),
        keyEpoch: integer('key_epoch').notNull(),
        shareEnvelope: bytea('share_envelope').notNull(),
        prevShareEnvelope: bytea('prev_share_envelope'),
        prevKeyEpoch: integer('prev_key_epoch'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
    },
    (table) => [
        uniqueIndex('drive_shares_live_grant')
            .on(table.nodeId, table.granteeUserId)
            .where(sql`revoked_at is null`),
        index('drive_shares_grantee_idx')
            .on(table.granteeUserId)
            .where(sql`revoked_at is null`),
        index('drive_shares_node_idx').on(table.workspaceId, table.nodeId),
        check('drive_shares_role_valid', sql`${table.role} in ('viewer', 'editor')`),
        check('drive_shares_not_self', sql`${table.granterUserId} <> ${table.granteeUserId}`),
        check(
            'drive_shares_envelopes_valid',
            sql`${table.keyEpoch} >= 1 and octet_length(${table.shareEnvelope}) in (72, 1160, 1256, 4565) and (${table.prevShareEnvelope} is null) = (${table.prevKeyEpoch} is null) and (${table.prevShareEnvelope} is null or octet_length(${table.prevShareEnvelope}) in (72, 1160, 1256, 4565))`,
        ),
    ],
);

/*
 * A link: a share without a grantee. The path token's hash finds the row; the
 * fragment secret never reaches the server; the envelope was sealed under the
 * secret and an optional password stretched with the stored salt. Viewer only,
 * with optional expiry, revocable, and counted so an owner can see it was used.
 */
export const driveLinks = pgTable(
    'drive_links',
    {
        id: uuid().defaultRandom().primaryKey(),
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        nodeId: uuid('node_id')
            .notNull()
            .references(() => driveNodes.id, { onDelete: 'cascade' }),
        granterUserId: uuid('granter_user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        tokenHash: bytea('token_hash').notNull().unique(),
        keyEpoch: integer('key_epoch').notNull(),
        linkEnvelope: bytea('link_envelope').notNull(),
        linkSalt: bytea('link_salt').notNull(),
        // The secret and token sealed under the node key: the owner's way to show the link again or change it.
        secretEnvelope: bytea('secret_envelope'),
        hasPassword: boolean('has_password').notNull().default(false),
        // How the link key is derived (see @hushos/crypto/links): 1 before the labelled derivation.
        kdfVersion: smallint('kdf_version').notNull().default(2),
        expiresAt: timestamp('expires_at', { withTimezone: true }),
        useCount: integer('use_count').notNull().default(0),
        lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
    },
    (table) => [
        index('drive_links_node_idx').on(table.workspaceId, table.nodeId),
        check(
            'drive_links_valid',
            sql`${table.keyEpoch} >= 1 and octet_length(${table.tokenHash}) = 32 and octet_length(${table.linkEnvelope}) = 72 and octet_length(${table.linkSalt}) = 16 and (${table.secretEnvelope} is null or octet_length(${table.secretEnvelope}) in (104, 136)) and ${table.useCount} >= 0`,
        ),
    ],
);

/*
 * Reports. Anyone who can see content through a share or a link can report it;
 * their device seals the node key to every operator's identity key, so the
 * server, holding only sealed bodies, still reads nothing. The row keeps what
 * triage needs after the tree moves on: who reported what, how they saw it,
 * whose it was, and where the report stands. Nothing here cascades from the
 * workspace or the node, because a report outlives what it is about.
 */
export const REPORT_CATEGORIES = [
    'csam',
    'terrorism',
    'ncii',
    'malware',
    'copyright',
    'harassment',
    'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];
export type ReportStatus = 'open' | 'dismissed' | 'removed' | 'filed';
export type EvidenceStatus = 'pending' | 'copied' | 'skipped' | 'failed' | 'purged';

export const driveReports = pgTable(
    'drive_reports',
    {
        id: uuid().primaryKey(), // client-generated: it is sealed into every key envelope's context
        workspaceId: uuid('workspace_id').notNull(),
        nodeId: uuid('node_id').notNull(),
        nodeKind: text('node_kind').notNull().$type<'folder' | 'file'>(),
        keyEpoch: integer('key_epoch').notNull(),
        linkId: uuid('link_id'),
        shareId: uuid('share_id'),
        category: text().notNull().$type<ReportCategory>(),
        // The reporter's own words, and who they are: cleared, with the share they saw it
        // through (which names them too), when the report is released.
        reason: text(),
        reporterUserId: uuid('reporter_user_id'),
        reporterEmail: text('reporter_email'),
        reporterAddressHash: bytea('reporter_address_hash'),
        uploaderUserId: uuid('uploader_user_id'),
        uploaderEmail: text('uploader_email'),
        status: text().notNull().$type<ReportStatus>().default('open'),
        // Keeps the bytes past resolution: the deletion outbox skips what an open or held report names.
        heldAt: timestamp('held_at', { withTimezone: true }),
        // Closed without a hold: the keys and personal details are gone, and nothing reopens or holds it again.
        releasedAt: timestamp('released_at', { withTimezone: true }),
        evidenceStatus: text('evidence_status')
            .notNull()
            .$type<EvidenceStatus>()
            .default('pending'),
        itemCount: integer('item_count').notNull().default(0),
        itemsTruncated: boolean('items_truncated').notNull().default(false),
        filedWith: text('filed_with'),
        filedReference: text('filed_reference'),
        resolvedAt: timestamp('resolved_at', { withTimezone: true }),
        resolvedBy: uuid('resolved_by'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index('drive_reports_queue_idx').on(table.status, table.createdAt),
        index('drive_reports_node_idx').on(table.nodeId),
        check(
            'drive_reports_category_valid',
            sql`${table.category} in ('csam', 'terrorism', 'ncii', 'malware', 'copyright', 'harassment', 'other')`,
        ),
        check(
            'drive_reports_status_valid',
            sql`${table.status} in ('open', 'dismissed', 'removed', 'filed')`,
        ),
        check(
            'drive_reports_release_valid',
            sql`${table.releasedAt} is null or (${table.status} <> 'open' and ${table.heldAt} is null and ${table.reason} is null and ${table.reporterUserId} is null and ${table.reporterEmail} is null and ${table.reporterAddressHash} is null and ${table.uploaderEmail} is null and ${table.shareId} is null)`,
        ),
        check(
            'drive_reports_reason_valid',
            sql`${table.reason} is not null or ${table.releasedAt} is not null`,
        ),
        check(
            'drive_reports_evidence_valid',
            sql`${table.evidenceStatus} in ('pending', 'copied', 'skipped', 'failed', 'purged')`,
        ),
        check(
            'drive_reports_values_valid',
            sql`${table.keyEpoch} >= 1 and (${table.reason} is null or char_length(${table.reason}) between 1 and 2000) and (${table.reporterEmail} is null or char_length(${table.reporterEmail}) <= 254) and (${table.reporterAddressHash} is null or octet_length(${table.reporterAddressHash}) = 32) and ${table.itemCount} >= 0 and (${table.filedWith} is null or char_length(${table.filedWith}) <= 200) and (${table.filedReference} is null or char_length(${table.filedReference}) <= 200)`,
        ),
    ],
);

/* The node key sealed to one operator, opened only under that operator's identity: a sealed box (112 bytes) or, since the hybrid suite, 1224 bytes with an ML-KEM-768 ciphertext beside it. */
export const driveReportKeys = pgTable(
    'drive_report_keys',
    {
        reportId: uuid('report_id')
            .notNull()
            .references(() => driveReports.id, { onDelete: 'cascade' }),
        operatorUserId: uuid('operator_user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        keyEnvelope: bytea('key_envelope').notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.reportId, table.operatorUserId] }),
        check(
            'drive_report_keys_envelope_valid',
            sql`octet_length(${table.keyEnvelope}) in (112, 1224)`,
        ),
    ],
);

/*
 * What the reported subtree looked like when it was reported: every live node
 * beneath the reported one (bounded), with the envelopes and object framing
 * an operator needs to open it, kept here so the owner purging the tree does
 * not empty the report. The object keys name what the hold keeps and what the
 * worker copies to the evidence store. A release clears the envelopes, the
 * signatures and who wrote what, keeping the tree's shape and the object ids
 * the evidence purge needs to find the copies it deletes.
 */
export const driveReportItems = pgTable(
    'drive_report_items',
    {
        reportId: uuid('report_id')
            .notNull()
            .references(() => driveReports.id, { onDelete: 'cascade' }),
        nodeId: uuid('node_id').notNull(),
        parentId: uuid('parent_id'),
        depth: integer().notNull(),
        kind: text().notNull().$type<'folder' | 'file'>(),
        keyEpoch: integer('key_epoch').notNull(),
        parentKeyEpoch: integer('parent_key_epoch').notNull(),
        keyEnvelope: bytea('key_envelope'),
        metadataVersion: integer('metadata_version').notNull(),
        metadataEnvelope: bytea('metadata_envelope'),
        versionId: uuid('version_id'),
        objectId: uuid('object_id'),
        objectKey: text('object_key'),
        contentKeyEnvelope: bytea('content_key_envelope'),
        contentNonce: bytea('content_nonce'),
        contentSuite: smallint('content_suite'),
        chunkSize: integer('chunk_size'),
        chunkCount: integer('chunk_count'),
        // Suite 1 only; under suite 2 the operator learns the size from the envelope, as any reader does.
        plaintextSize: bigint('plaintext_size', { mode: 'bigint' }),
        ciphertextSize: bigint('ciphertext_size', { mode: 'bigint' }),
        // The writers' signatures as they stood, so an operator can tell who wrote what.
        // No reference to the account: the snapshot outlives it.
        metadataSignerId: uuid('metadata_signer'),
        metadataSignature: bytea('metadata_signature'),
        versionSignerId: uuid('version_signer'),
        versionSignature: bytea('version_signature'),
        // A re-keyed record's writer (its origin's signer) beside the re-keyer above, so the
        // evidence keeps who wrote it, not only who last locked it (decision D10, the minimum).
        metadataOriginSignerId: uuid('metadata_origin_signer'),
        versionOriginSignerId: uuid('version_origin_signer'),
        evidenceCopiedAt: timestamp('evidence_copied_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        primaryKey({ columns: [table.reportId, table.nodeId] }),
        index('drive_report_items_object_idx').on(table.objectId),
        index('drive_report_items_parent_idx').on(table.reportId, table.parentId),
        check(
            'drive_report_items_signatures_valid',
            sql`(${table.metadataSignature} is null or octet_length(${table.metadataSignature}) = 64) and (${table.versionSignature} is null or octet_length(${table.versionSignature}) = 64)`,
        ),
        check(
            'drive_report_items_valid',
            sql`${table.depth} >= 0 and ${table.keyEpoch} >= 1 and ${table.parentKeyEpoch} >= 1 and ((${table.kind} = 'folder' and ${table.versionId} is null) or (${table.kind} = 'file' and (${table.versionId} is null or (${table.objectId} is not null and ${table.objectKey} is not null))))`,
        ),
        // As snapshotted, everything an operator needs to open it; once released, none of it.
        check(
            'drive_report_items_sealed_valid',
            sql`(${table.keyEnvelope} is not null and octet_length(${table.keyEnvelope}) = 72 and ${table.metadataEnvelope} is not null and octet_length(${table.metadataEnvelope}) between 42 and 4136 and (${table.versionId} is null or (${table.contentKeyEnvelope} is not null and octet_length(${table.contentKeyEnvelope}) in (72, 84) and ${table.contentNonce} is not null and octet_length(${table.contentNonce}) = 16 and ${table.chunkSize} > 0 and ${table.chunkCount} >= 1 and (${table.plaintextSize} is null or ${table.plaintextSize} >= 0) and ${table.ciphertextSize} >= 0))) or (${table.keyEnvelope} is null and ${table.metadataEnvelope} is null and ${table.contentKeyEnvelope} is null and ${table.contentNonce} is null and ${table.metadataSignerId} is null and ${table.metadataSignature} is null and ${table.versionSignerId} is null and ${table.versionSignature} is null)`,
        ),
    ],
);

/* The audit trail: every look and every decision, by whom, in order. */
export const driveReportEvents = pgTable(
    'drive_report_events',
    {
        id: uuid().defaultRandom().primaryKey(),
        reportId: uuid('report_id')
            .notNull()
            .references(() => driveReports.id, { onDelete: 'cascade' }),
        actorUserId: uuid('actor_user_id'),
        action: text().notNull(),
        note: text(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        index('drive_report_events_report_idx').on(table.reportId, table.createdAt),
        check(
            'drive_report_events_valid',
            sql`char_length(${table.action}) between 1 and 40 and (${table.note} is null or char_length(${table.note}) <= 2000)`,
        ),
    ],
);

/*
 * An operator's request for the evidence copy of a report's bytes, answered by
 * the worker, which alone holds the evidence store's credentials: it presigns
 * a short-lived URL per copied object and writes them here for the page to
 * pick up. Every request is on the report's record.
 */
export const driveReportRequests = pgTable(
    'drive_report_requests',
    {
        id: uuid().defaultRandom().primaryKey(),
        reportId: uuid('report_id')
            .notNull()
            .references(() => driveReports.id, { onDelete: 'cascade' }),
        requestedBy: uuid('requested_by').notNull(),
        status: text().notNull().$type<'pending' | 'ready' | 'failed'>().default('pending'),
        // { [versionId]: url } once ready.
        urls: jsonb().$type<Record<string, string>>(),
        urlExpiresAt: timestamp('url_expires_at', { withTimezone: true }),
        error: text(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        answeredAt: timestamp('answered_at', { withTimezone: true }),
    },
    (table) => [
        index('drive_report_requests_pending_idx')
            .on(table.createdAt)
            .where(sql`status = 'pending'`),
        check(
            'drive_report_requests_status_valid',
            sql`${table.status} in ('pending', 'ready', 'failed')`,
        ),
    ],
);

/*
 * A subtree key rotation in progress, at most one per workspace: the root and
 * the target epoch, drawn from the workspace's counter so it is above every
 * epoch any node ever carried. Previous envelopes and grants live until it
 * finishes; a crashed client resumes from the work query.
 */
export const driveRotations = pgTable(
    'drive_rotations',
    {
        id: uuid().defaultRandom().primaryKey(),
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        nodeId: uuid('node_id')
            .notNull()
            .references(() => driveNodes.id, { onDelete: 'cascade' }),
        targetEpoch: integer('target_epoch').notNull(),
        startedBy: uuid('started_by'),
        startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
        finishedAt: timestamp('finished_at', { withTimezone: true }),
    },
    (table) => [
        uniqueIndex('drive_rotations_one_active')
            .on(table.workspaceId)
            .where(sql`finished_at is null`),
        check('drive_rotations_epoch_valid', sql`${table.targetEpoch} >= 1`),
    ],
);

/*
 * Membership changes a share's feed cannot read off the ancestry filter: a
 * node moved out of the shared subtree, or a subtree moved in, at the
 * workspace's change sequence of the move. A client drops the subtree on
 * `left` and lists it on `entered`.
 */
export const driveShareEvents = pgTable(
    'drive_share_events',
    {
        shareId: uuid('share_id')
            .notNull()
            .references(() => driveShares.id, { onDelete: 'cascade' }),
        changeSeq: bigint('change_seq', { mode: 'number' }).notNull(),
        nodeId: uuid('node_id').notNull(),
        kind: text().notNull().$type<'entered' | 'left'>(),
    },
    (table) => [
        primaryKey({ columns: [table.shareId, table.changeSeq] }),
        check('drive_share_events_kind_valid', sql`${table.kind} in ('entered', 'left')`),
    ],
);

/*
 * One sealed JSON document per kind a workspace keeps beside its tree, opened
 * with the workspace key: the tag registry is the first. The server sees a
 * kind, a version and bytes. A write names the version it saw and becomes the
 * next; a stale one is refused with the current row, like every Drive write.
 */
export const workspaceDocuments = pgTable(
    'workspace_documents',
    {
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        kind: text().notNull(),
        version: integer().notNull(),
        envelope: bytea().notNull(),
        envelopeSuite: smallint('envelope_suite').notNull().default(1),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.workspaceId, table.kind] }),
        check('workspace_documents_kind_valid', sql`${table.kind} ~ '^[a-z][a-z0-9-]{0,31}$'`),
        check('workspace_documents_version_valid', sql`${table.version} >= 1`),
        check(
            'workspace_documents_envelope_valid',
            sql`octet_length(${table.envelope}) between 42 and 1048616`,
        ),
    ],
);

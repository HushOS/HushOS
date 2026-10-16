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
    text,
    timestamp,
    unique,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import { bytea, users } from './auth';

/*
 * Groups (docs/groups-design.md, with the 1b server contract in
 * docs/groups-server.md). Every signed statement is stored as its exact bytes
 * and parsed only through @hushos/crypto, so a change to a statement's layout
 * changes no column; the columns beside a statement are projections the
 * server indexes and locks on, written from the parsed statement, never from a
 * request body. Rosters and successions are history: nothing deletes or
 * rewrites them while the group exists, and the account that signed one may
 * be gone, so signers carry no foreign key.
 */

export type GroupKind = 'family' | 'org';
export type GroupRole = 'billing' | 'data_admin' | 'guardian' | 'members' | 'recovery';
export type MembershipState = 'accepted' | 'active' | 'left' | 'removed';
export type InvitationState = 'open' | 'accepted' | 'revoked' | 'expired';

export const GROUP_ROLES: readonly GroupRole[] = [
    'billing',
    'data_admin',
    'guardian',
    'members',
    'recovery',
];
/* The statement cap every implementation shares (MAX_STATEMENT_BYTES, 4 MiB). */
export const MAX_GROUP_STATEMENT_BYTES = 4 * 1024 * 1024;
/* A succession names four keys and a roster: a few kilobytes; this leaves room and no more. */
export const MAX_SUCCESSION_STATEMENT_BYTES = 16 * 1024;
export const GROUP_KEY_SEAL_BYTES = 4597;
export const AREA_GRANT_BYTES = 4565;

const rolesCheck = (column: AnyPgColumn) =>
    sql`${column} <@ array['billing', 'data_admin', 'guardian', 'members', 'recovery']::text[]`;
const groupSignatureLengths = (ed25519: AnyPgColumn, mlDsa: AnyPgColumn, signer: AnyPgColumn) =>
    sql`octet_length(${ed25519}) = 64 and octet_length(${mlDsa}) = 3309 and octet_length(${signer}) = 3373`;

export const groups = pgTable(
    'groups',
    {
        // Client-derived: scopedId('group', creator_user_id, id_seed).
        id: uuid().primaryKey(),
        idSeed: text('id_seed').notNull(),
        kind: text().$type<GroupKind>().notNull(),
        // Plaintext, as members and invitations show it (docs/groups-design.md 6).
        name: text().notNull(),
        creatorUserId: uuid('creator_user_id').notNull(),
        // The version 1 group key: the anchor of the server's own acceptance of the chain.
        firstEd25519PublicKey: bytea('first_ed25519_public_key').notNull(),
        firstMlDsaPublicKey: bytea('first_ml_dsa_public_key').notNull(),
        // The head of the chain, a projection of the latest roster and succession.
        rosterVersion: integer('roster_version').notNull(),
        rosterDigest: bytea('roster_digest').notNull(),
        groupKeyVersion: integer('group_key_version').notNull(),
        /*
         * The compare-and-set token: one more on every roster or succession stored. A
         * succession moves the chain without a new roster version, so a writer names
         * this, not the roster version, as the chain it checked against.
         */
        chainRevision: bigint('chain_revision', { mode: 'number' }).notNull().default(1),
        // The head roster dropped a `members` holder: no roster lands until a succession does.
        successionDue: boolean('succession_due').notNull().default(false),
        // Null: the instance's GROUP_SEAT_LIMIT_DEFAULT. Billing writes it from 1e.
        seatLimit: integer('seat_limit'),
        dissolvedAt: timestamp('dissolved_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check('groups_kind_valid', sql`${table.kind} in ('family', 'org')`),
        check('groups_name_length', sql`char_length(${table.name}) between 1 and 100`),
        check('groups_id_seed_valid', sql`${table.idSeed} ~ '^[A-Za-z0-9_-]{22}$'`),
        check(
            'groups_first_keys_valid',
            sql`octet_length(${table.firstEd25519PublicKey}) = 32 and octet_length(${table.firstMlDsaPublicKey}) = 1952`,
        ),
        check(
            'groups_head_valid',
            sql`${table.rosterVersion} >= 1 and octet_length(${table.rosterDigest}) = 32 and ${table.groupKeyVersion} >= 1 and ${table.chainRevision} >= 1 and (${table.seatLimit} is null or ${table.seatLimit} >= 1)`,
        ),
    ],
);

/*
 * One row per person who accepted an invitation or was admitted. "Invited"
 * lives in group_invitations: there is no account to name until acceptance.
 * `roles` is a projection of the person's latest roster entry.
 */
export const groupMemberships = pgTable(
    'group_memberships',
    {
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),
        // The entry on the rosters stays when the account goes.
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        state: text().$type<MembershipState>().notNull(),
        roles: text()
            .$type<GroupRole>()
            .array()
            .notNull()
            .default(sql`'{}'::text[]`),
        invitationId: uuid('invitation_id').references((): AnyPgColumn => groupInvitations.id, {
            onDelete: 'set null',
        }),
        admittedBy: uuid('admitted_by').references(() => users.id, { onDelete: 'set null' }),
        acceptedAt: timestamp('accepted_at', { withTimezone: true }),
        admittedAt: timestamp('admitted_at', { withTimezone: true }),
        leftAt: timestamp('left_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.groupId, table.userId] }),
        index('group_memberships_user_idx').on(table.userId),
        index('group_memberships_admitted_by_idx')
            .on(table.admittedBy)
            .where(sql`${table.admittedBy} is not null`),
        index('group_memberships_invitation_idx')
            .on(table.invitationId)
            .where(sql`${table.invitationId} is not null`),
        check(
            'group_memberships_state_valid',
            sql`${table.state} in ('accepted', 'active', 'left', 'removed')`,
        ),
        check('group_memberships_roles_valid', rolesCheck(table.roles)),
        check(
            'group_memberships_timeline_valid',
            sql`(${table.state} <> 'active' or ${table.admittedAt} is not null) and ((${table.state} in ('left', 'removed')) = (${table.leftAt} is not null))`,
        ),
    ],
);

/* Every roster, one per version, as signed. */
export const groupRosters = pgTable(
    'group_rosters',
    {
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),
        version: integer().notNull(),
        // SHA-256 of `statement`, computed by the server from the bytes it stores.
        digest: bytea().notNull(),
        previousDigest: bytea('previous_digest'),
        groupKeyVersion: integer('group_key_version').notNull(),
        signerUserId: uuid('signer_user_id').notNull(),
        /*
         * The ML-DSA key the signer's identity signature verified under (its digest is
         * the signer's entry's). Kept with the roster so the chain can be checked from
         * version 1, by the server and by every new device, after the signer's account
         * and its identities are gone.
         */
        signerMlDsaPublicKey: bytea('signer_ml_dsa_public_key').notNull(),
        statement: bytea().notNull(),
        ed25519Signature: bytea('ed25519_signature').notNull(),
        mlDsaSignature: bytea('ml_dsa_signature').notNull(),
        signerSignature: bytea('signer_signature').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.groupId, table.version] }),
        unique('group_rosters_digest').on(table.groupId, table.digest),
        // What seals, grants and successions name: a roster by version and digest together.
        unique('group_rosters_version_digest').on(table.groupId, table.version, table.digest),
        check(
            'group_rosters_chain_valid',
            sql`${table.version} >= 1 and ${table.groupKeyVersion} >= 1 and octet_length(${table.digest}) = 32 and (${table.version} = 1) = (${table.previousDigest} is null) and (${table.previousDigest} is null or octet_length(${table.previousDigest}) = 32)`,
        ),
        check(
            'group_rosters_statement_valid',
            sql`octet_length(${table.statement}) between 1 and 4194304 and octet_length(${table.signerMlDsaPublicKey}) = 1952 and ${groupSignatureLengths(table.ed25519Signature, table.mlDsaSignature, table.signerSignature)}`,
        ),
    ],
);

/* One succession per old group key, tied to the roster it follows. */
export const groupKeySuccessions = pgTable(
    'group_key_successions',
    {
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),
        oldVersion: integer('old_version').notNull(),
        newVersion: integer('new_version').notNull(),
        lastRosterVersion: integer('last_roster_version').notNull(),
        lastRosterDigest: bytea('last_roster_digest').notNull(),
        newEd25519PublicKey: bytea('new_ed25519_public_key').notNull(),
        newMlDsaPublicKey: bytea('new_ml_dsa_public_key').notNull(),
        signerUserId: uuid('signer_user_id').notNull(),
        // As for rosters: the signer's ML-DSA key, so the chain outlives the signer's account.
        signerMlDsaPublicKey: bytea('signer_ml_dsa_public_key').notNull(),
        digest: bytea().notNull(),
        statement: bytea().notNull(),
        ed25519Signature: bytea('ed25519_signature').notNull(),
        mlDsaSignature: bytea('ml_dsa_signature').notNull(),
        signerSignature: bytea('signer_signature').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.groupId, table.oldVersion] }),
        unique('group_key_successions_digest').on(table.groupId, table.digest),
        foreignKey({
            name: 'group_key_successions_roster_fk',
            columns: [table.groupId, table.lastRosterVersion, table.lastRosterDigest],
            foreignColumns: [groupRosters.groupId, groupRosters.version, groupRosters.digest],
        }),
        check(
            'group_key_successions_versions_valid',
            sql`${table.oldVersion} >= 1 and ${table.newVersion} = ${table.oldVersion} + 1 and ${table.lastRosterVersion} >= 1`,
        ),
        check(
            'group_key_successions_lengths_valid',
            sql`octet_length(${table.lastRosterDigest}) = 32 and octet_length(${table.digest}) = 32 and octet_length(${table.newEd25519PublicKey}) = 32 and octet_length(${table.newMlDsaPublicKey}) = 1952 and octet_length(${table.signerMlDsaPublicKey}) = 1952 and octet_length(${table.statement}) between 1 and 16384 and ${groupSignatureLengths(table.ed25519Signature, table.mlDsaSignature, table.signerSignature)}`,
        ),
    ],
);

/*
 * The group seed sealed to each `members` holder, per group key version
 * (docs/groups-design.md 2.3; the design's `group_keys`). A holder's new
 * identity replaces their seal in place.
 */
export const groupKeySeals = pgTable(
    'group_key_seals',
    {
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),
        groupKeyVersion: integer('group_key_version').notNull(),
        holderUserId: uuid('holder_user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        holderKeyVersion: integer('holder_key_version').notNull(),
        sealerUserId: uuid('sealer_user_id').notNull(),
        rosterVersion: integer('roster_version').notNull(),
        rosterDigest: bytea('roster_digest').notNull(),
        envelope: bytea().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        primaryKey({ columns: [table.groupId, table.groupKeyVersion, table.holderUserId] }),
        index('group_key_seals_holder_idx').on(table.holderUserId),
        foreignKey({
            name: 'group_key_seals_roster_fk',
            columns: [table.groupId, table.rosterVersion, table.rosterDigest],
            foreignColumns: [groupRosters.groupId, groupRosters.version, groupRosters.digest],
        }),
        check(
            'group_key_seals_valid',
            sql`${table.groupKeyVersion} >= 1 and ${table.holderKeyVersion} >= 1 and ${table.rosterVersion} >= 1 and octet_length(${table.rosterDigest}) = 32 and octet_length(${table.envelope}) = 4597`,
        ),
    ],
);

/*
 * An invitation by email: the token (in the link's fragment) hashed at rest
 * as sign-up tokens are. Accepting binds it to the signed-in account, which
 * must have the invited address. Once it is no longer open, the cleanup job
 * forgets the address after 30 days; the row stays for the membership that
 * names it.
 */
export const groupInvitations = pgTable(
    'group_invitations',
    {
        id: uuid().defaultRandom().primaryKey(),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),
        email: text(),
        normalizedEmail: text('normalized_email'),
        tokenHash: bytea('token_hash').notNull().unique(),
        roles: text()
            .$type<GroupRole>()
            .array()
            .notNull()
            .default(sql`'{}'::text[]`),
        invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
        state: text().$type<InvitationState>().notNull().default('open'),
        acceptedBy: uuid('accepted_by').references(() => users.id, { onDelete: 'set null' }),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        uniqueIndex('group_invitations_open_idx')
            .on(table.groupId, table.normalizedEmail)
            .where(sql`${table.state} = 'open'`),
        index('group_invitations_expiry_idx').on(table.expiresAt),
        index('group_invitations_invited_by_idx')
            .on(table.invitedBy)
            .where(sql`${table.invitedBy} is not null`),
        index('group_invitations_accepted_by_idx')
            .on(table.acceptedBy)
            .where(sql`${table.acceptedBy} is not null`),
        check(
            'group_invitations_state_valid',
            // accepted_by goes null with the account; it is never set on any other state.
            sql`${table.state} in ('open', 'accepted', 'revoked', 'expired') and (${table.acceptedBy} is null or ${table.state} = 'accepted')`,
        ),
        check('group_invitations_roles_valid', rolesCheck(table.roles)),
        check(
            'group_invitations_valid',
            sql`octet_length(${table.tokenHash}) = 32 and ${table.expiresAt} > ${table.createdAt} and (${table.email} is null) = (${table.normalizedEmail} is null) and (${table.email} is null or char_length(${table.email}) between 3 and 320) and (${table.state} <> 'open' or ${table.email} is not null)`,
        ),
    ],
);

/*
 * Someone who left, or whose account was deleted, while the head roster still
 * lists them active: due to be marked left. While a group has any, only a
 * roster that marks every one of them left is accepted (docs/groups-server.md
 * 3), and a holder among them makes that roster drop a holder. No foreign key
 * to the account: a deleted account's departure must outlive it.
 */
export const groupDepartures = pgTable(
    'group_departures',
    {
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),
        userId: uuid('user_id').notNull(),
        // Whether their entry held `members`: marking them left then drops a holder.
        heldMembers: boolean('held_members').notNull(),
        departedAt: timestamp('departed_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [primaryKey({ columns: [table.groupId, table.userId] })],
);

/*
 * A holder's hold on a member they are about to remove (docs/groups-server.md
 * 8): while it is live, the member's Drive writes, epoch draws and rotation
 * starts in the group's areas are refused, so they cannot keep moving the
 * areas' epochs past the remover's rotation, or start a run the removal must
 * wait on. It lapses at `expires_at`, and goes when they are removed or depart.
 */
export const groupHolds = pgTable(
    'group_holds',
    {
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        heldBy: uuid('held_by').references(() => users.id, { onDelete: 'set null' }),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (table) => [primaryKey({ columns: [table.groupId, table.userId] })],
);

/*
 * What the server's own acceptance of the stored chain produced (the
 * GroupChainCache), so a write checks one statement instead of the whole
 * chain. Derived data: missing, or at another revision than the group's, it is
 * rebuilt from version 1 and written back with a compare-and-set.
 */
export const groupChainCaches = pgTable(
    'group_chain_caches',
    {
        groupId: uuid('group_id')
            .primaryKey()
            .references(() => groups.id, { onDelete: 'cascade' }),
        chainRevision: bigint('chain_revision', { mode: 'number' }).notNull(),
        cache: jsonb().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [check('group_chain_caches_revision_valid', sql`${table.chainRevision} >= 1`)],
);

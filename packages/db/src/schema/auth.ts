import { sql } from 'drizzle-orm';
import {
    check,
    customType,
    index,
    integer,
    pgTable,
    smallint,
    text,
    timestamp,
    uuid,
} from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => 'bytea',
    codec: 'bytea',
});

export const users = pgTable(
    'users',
    {
        id: uuid().defaultRandom().primaryKey(),
        name: text().notNull(),
        email: text().notNull(),
        normalizedEmail: text('normalized_email').notNull().unique(),
        emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [check('users_name_length', sql`char_length(${table.name}) between 1 and 100`)],
);

export const opaqueCredentials = pgTable(
    'opaque_credentials',
    {
        userId: uuid('user_id')
            .primaryKey()
            .references(() => users.id, { onDelete: 'cascade' }),
        registrationRecord: text('registration_record').notNull(),
        profileVersion: smallint('profile_version').notNull(),
        serverSetupId: text('server_setup_id').notNull(),
        version: integer().notNull().default(1),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check('opaque_credentials_version_positive', sql`${table.version} > 0`),
        check('opaque_credentials_profile_supported', sql`${table.profileVersion} = 1`),
    ],
);

export const accountKeys = pgTable(
    'account_keys',
    {
        userId: uuid('user_id')
            .primaryKey()
            .references(() => users.id, { onDelete: 'cascade' }),
        keyVersion: integer('key_version').notNull().default(1),
        credentialVersion: integer('credential_version').notNull().default(1),
        envelopeVersion: smallint('envelope_version').notNull(),
        wrappingSalt: bytea('wrapping_salt').notNull(),
        wrappingNonce: bytea('wrapping_nonce').notNull(),
        encryptedKey: bytea('encrypted_key').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check(
            'account_keys_versions_positive',
            sql`${table.keyVersion} > 0 and ${table.credentialVersion} > 0`,
        ),
        check(
            'account_keys_envelope_supported',
            sql`${table.envelopeVersion} = 1 and octet_length(${table.wrappingSalt}) = 32 and octet_length(${table.wrappingNonce}) = 24 and octet_length(${table.encryptedKey}) = 48`,
        ),
    ],
);

export const sessions = pgTable(
    'sessions',
    {
        id: uuid().defaultRandom().primaryKey(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        tokenHash: bytea('token_hash').notNull().unique(),
        credentialVersion: integer('credential_version').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('sessions_user_idx').on(table.userId),
        index('sessions_expiry_idx').on(table.expiresAt),
        check('sessions_token_hash_length', sql`octet_length(${table.tokenHash}) = 32`),
        check('sessions_version_positive', sql`${table.credentialVersion} > 0`),
        check('sessions_expiry_valid', sql`${table.expiresAt} > ${table.createdAt}`),
    ],
);

export const opaqueLoginAttempts = pgTable(
    'opaque_login_attempts',
    {
        purpose: text().notNull().default('login'),
        sessionTokenHash: bytea('session_token_hash'),
        tokenHash: bytea('token_hash').primaryKey(),
        userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
        credentialVersion: integer('credential_version'),
        profileVersion: smallint('profile_version').notNull(),
        serverState: text('server_state').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (table) => [
        check(
            'opaque_login_attempts_purpose_binding',
            sql`(${table.purpose} = 'login' and ${table.sessionTokenHash} is null) or (${table.purpose} in ('delete', 'password', 'master-key', 'recovery-key') and ${table.sessionTokenHash} is not null and octet_length(${table.sessionTokenHash}) = 32)`,
        ),
        index('opaque_login_attempts_user_idx').on(table.userId),
        index('opaque_login_attempts_expiry_idx').on(table.expiresAt),
        check('opaque_login_attempts_token_length', sql`octet_length(${table.tokenHash}) = 32`),
        check('opaque_login_attempts_expiry_valid', sql`${table.expiresAt} > ${table.createdAt}`),
        check('opaque_login_attempts_profile_supported', sql`${table.profileVersion} = 1`),
        check(
            'opaque_login_attempts_credential_binding',
            sql`(${table.userId} is null and ${table.credentialVersion} is null) or (${table.userId} is not null and ${table.credentialVersion} is not null and ${table.credentialVersion} > 0)`,
        ),
    ],
);

// A verified enrollment reserves the immutable UUID used by OPAQUE registration.
export const accountEnrollments = pgTable(
    'account_enrollments',
    {
        id: uuid().defaultRandom().primaryKey(),
        purpose: text().notNull().default('register'),
        email: text().notNull(),
        normalizedEmail: text('normalized_email').notNull(),
        verificationTokenHash: bytea('verification_token_hash').unique(),
        enrollmentTokenHash: bytea('enrollment_token_hash').unique(),
        verifiedAt: timestamp('verified_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (table) => [
        check(
            'account_enrollments_purpose_valid',
            sql`${table.purpose} in ('register', 'recover')`,
        ),
        index('account_enrollments_expiry_idx').on(table.expiresAt),
        index('account_enrollments_email_idx').on(table.normalizedEmail),
        check('account_enrollments_expiry_valid', sql`${table.expiresAt} > ${table.createdAt}`),
        check(
            'account_enrollments_state_valid',
            sql`(${table.verifiedAt} is null and octet_length(${table.verificationTokenHash}) = 32 and ${table.verificationTokenHash} is not null and ${table.enrollmentTokenHash} is null) or (${table.verifiedAt} is not null and ${table.verificationTokenHash} is null and octet_length(${table.enrollmentTokenHash}) = 32 and ${table.enrollmentTokenHash} is not null)`,
        ),
    ],
);

export const authRateLimits = pgTable(
    'auth_rate_limits',
    {
        keyHash: bytea('key_hash').primaryKey(),
        count: integer().notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (table) => [
        index('auth_rate_limits_expiry_idx').on(table.expiresAt),
        check('auth_rate_limits_count_positive', sql`${table.count} > 0`),
        check('auth_rate_limits_key_length', sql`octet_length(${table.keyHash}) = 32`),
    ],
);

export const accountRecoveryKeys = pgTable(
    'account_recovery_keys',
    {
        userId: uuid('user_id')
            .primaryKey()
            .references(() => users.id, { onDelete: 'cascade' }),
        version: smallint().notNull().default(1),
        keyVersion: integer('key_version').notNull().default(1),
        recoveryVersion: integer('recovery_version').notNull().default(1),
        wrappingSalt: bytea('wrapping_salt').notNull(),
        wrappingNonce: bytea('wrapping_nonce').notNull(),
        encryptedKey: bytea('encrypted_key').notNull(),
        backupNonce: bytea('backup_nonce').notNull(),
        encryptedRecoveryKey: bytea('encrypted_recovery_key').notNull(),
        publicKey: bytea('public_key').notNull(),
        confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check(
            'account_recovery_keys_versions_valid',
            sql`${table.version} = 1 and ${table.keyVersion} > 0 and ${table.recoveryVersion} > 0`,
        ),
        check(
            'account_recovery_keys_lengths_valid',
            sql`octet_length(${table.wrappingSalt}) = 32 and octet_length(${table.wrappingNonce}) = 24 and octet_length(${table.encryptedKey}) = 48 and octet_length(${table.backupNonce}) = 24 and octet_length(${table.encryptedRecoveryKey}) = 48 and octet_length(${table.publicKey}) = 32`,
        ),
    ],
);

export const accountRecoveryAttempts = pgTable(
    'account_recovery_attempts',
    {
        tokenHash: bytea('token_hash').primaryKey(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        enrollmentId: uuid('enrollment_id')
            .notNull()
            .references(() => accountEnrollments.id, { onDelete: 'cascade' }),
        credentialVersion: integer('credential_version').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (table) => [
        index('account_recovery_attempts_expiry_idx').on(table.expiresAt),
        index('account_recovery_attempts_user_idx').on(table.userId),
        check(
            'account_recovery_attempts_valid',
            sql`octet_length(${table.tokenHash}) = 32 and ${table.credentialVersion} > 0 and ${table.expiresAt} > ${table.createdAt}`,
        ),
    ],
);

export const accountIdentities = pgTable(
    'account_identities',
    {
        userId: uuid('user_id')
            .primaryKey()
            .references(() => users.id, { onDelete: 'cascade' }),
        version: smallint().notNull().default(1),
        keyVersion: integer('key_version').notNull().default(1),
        wrappingSalt: bytea('wrapping_salt').notNull(),
        encryptionPublicKey: bytea('encryption_public_key').notNull(),
        encryptionPrivateKeyNonce: bytea('encryption_private_key_nonce').notNull(),
        encryptedEncryptionPrivateKey: bytea('encrypted_encryption_private_key').notNull(),
        signingPublicKey: bytea('signing_public_key').notNull(),
        signingSeedNonce: bytea('signing_seed_nonce').notNull(),
        encryptedSigningSeed: bytea('encrypted_signing_seed').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check(
            'account_identities_versions_valid',
            sql`${table.version} = 1 and ${table.keyVersion} > 0`,
        ),
        check(
            'account_identities_lengths_valid',
            sql`octet_length(${table.wrappingSalt}) = 32 and octet_length(${table.encryptionPublicKey}) = 32 and octet_length(${table.encryptionPrivateKeyNonce}) = 24 and octet_length(${table.encryptedEncryptionPrivateKey}) = 48 and octet_length(${table.signingPublicKey}) = 32 and octet_length(${table.signingSeedNonce}) = 24 and octet_length(${table.encryptedSigningSeed}) = 48`,
        ),
    ],
);

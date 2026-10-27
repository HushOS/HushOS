import { sql } from 'drizzle-orm';
import {
    check,
    customType,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    smallint,
    text,
    timestamp,
    uniqueIndex,
    uuid,
    type AnyPgColumn,
} from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => 'bytea',
    codec: 'bytea',
});

export type SignupIntent = { plan?: string; referral?: string; source?: string; currency?: string };

/*
 * Secrets the server minted for itself on first start and must keep for as long
 * as the instance lives: the OPAQUE server setup, when the environment provides
 * none. Backed up with the database, since every password depends on it.
 */
export const serverSecrets = pgTable('server_secrets', {
    name: text().primaryKey(),
    value: text().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const users = pgTable(
    'users',
    {
        id: uuid().defaultRandom().primaryKey(),
        name: text().notNull(),
        email: text().notNull(),
        normalizedEmail: text('normalized_email').notNull().unique(),
        emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }).notNull(),
        // Operator access: admins reach the management area. Granted from the
        // command line, never from a request.
        role: text().notNull().$type<'member' | 'admin'>().default('member'),
        // Set by an operator acting on a report: no session is served and no sign-in succeeds until cleared.
        suspendedAt: timestamp('suspended_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check('users_name_length', sql`char_length(${table.name}) between 1 and 100`),
        check('users_role_valid', sql`${table.role} in ('member', 'admin')`),
    ],
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

export type DeviceKind = 'web' | 'ios' | 'android';
/*
 * How a device got in (docs/devices-design.md 1). Step 1 writes `enrolment`,
 * `password` and `existing`; the rest arrive with approval. Null is the
 * pending state approval will use: a device row that is not approved yet.
 */
export type DeviceApproval =
    | 'enrolment'
    | 'password'
    | 'device'
    | 'phrase'
    | 'email-wait'
    | 'guardian'
    | 'existing';

/*
 * One app installation or browser profile signed in to an account. Its name and
 * kind are what the client said about itself; the Ed25519 key is the device's
 * own, made on the device and used to come back to this row at the next sign-in
 * (`deviceSessionStatement`). A revoked row stays for 90 days, then goes.
 */
export const accountDevices = pgTable(
    'account_devices',
    {
        id: uuid().defaultRandom().primaryKey(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        // Null until the client describes itself: listed as an unknown device.
        kind: text().$type<DeviceKind>(),
        name: text(),
        signingPublicKey: bytea('signing_public_key'),
        approvedBy: text('approved_by').$type<DeviceApproval>(),
        approvedByDeviceId: uuid('approved_by_device_id').references(
            (): AnyPgColumn => accountDevices.id,
            { onDelete: 'set null' },
        ),
        approvedAt: timestamp('approved_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
    },
    (table) => [
        // Behind the self-reference's on-delete-set-null, so a sweep's deletes don't scan the table.
        index('account_devices_approver_idx')
            .on(table.approvedByDeviceId)
            .where(sql`${table.approvedByDeviceId} is not null`),
        index('account_devices_user_live_idx')
            .on(table.userId)
            .where(sql`${table.revokedAt} is null`),
        // Per account, never global: a global constraint would say whether a key is in use elsewhere.
        uniqueIndex('account_devices_user_key_idx')
            .on(table.userId, table.signingPublicKey)
            .where(sql`${table.signingPublicKey} is not null`),
        check(
            'account_devices_kind_valid',
            sql`${table.kind} is null or ${table.kind} in ('web', 'ios', 'android')`,
        ),
        check(
            'account_devices_name_length',
            sql`${table.name} is null or char_length(${table.name}) between 1 and 40`,
        ),
        check(
            'account_devices_key_length',
            sql`${table.signingPublicKey} is null or octet_length(${table.signingPublicKey}) = 32`,
        ),
        check(
            'account_devices_approved_by_valid',
            sql`${table.approvedBy} is null or ${table.approvedBy} in ('enrolment', 'password', 'device', 'phrase', 'email-wait', 'guardian', 'existing')`,
        ),
        check(
            'account_devices_approver_valid',
            sql`${table.approvedBy} = 'device' or ${table.approvedByDeviceId} is null`,
        ),
        check(
            'account_devices_approval_pair',
            sql`(${table.approvedBy} is null) = (${table.approvedAt} is null)`,
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
        /*
         * The device the session belongs to; at most one live session per device.
         * Nullable for one release, so a container still on the previous version can
         * sign people in during a rolling update; `sessions_device_not_null` follows.
         */
        deviceId: uuid('device_id').references(() => accountDevices.id, { onDelete: 'cascade' }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('sessions_user_idx').on(table.userId),
        index('sessions_expiry_idx').on(table.expiresAt),
        uniqueIndex('sessions_device_idx').on(table.deviceId),
        check('sessions_token_hash_length', sql`octet_length(${table.tokenHash}) = 32`),
        check('sessions_version_positive', sql`${table.credentialVersion} > 0`),
        check('sessions_expiry_valid', sql`${table.expiresAt} > ${table.createdAt}`),
    ],
);

/*
 * Sessions that ended because their device was removed, by token digest, for a
 * week: a removed device that comes back online is told it was removed (not
 * merely signed out), so it can clear what it kept. Nothing else is recorded.
 */
export const removedSessionTokens = pgTable(
    'removed_session_tokens',
    {
        tokenHash: bytea('token_hash').primaryKey(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (table) => [
        index('removed_session_tokens_expiry_idx').on(table.expiresAt),
        check('removed_session_tokens_hash_length', sql`octet_length(${table.tokenHash}) = 32`),
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
            sql`(${table.purpose} = 'login' and ${table.sessionTokenHash} is null) or (${table.purpose} in ('delete', 'password', 'master-key', 'recovery-key', 'devices') and ${table.sessionTokenHash} is not null and octet_length(${table.sessionTokenHash}) = 32)`,
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
        // What the person came for (a plan, a referral), carried until the account exists.
        intent: jsonb().$type<SignupIntent>(),
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
        /*
         * The ML-KEM-768 half, for hybrid share sealing: the public key, the seed
         * wrapped under the root, and the Ed25519 binding by the signing key. All
         * null on an identity made before hybrid sharing, until its next unlock.
         */
        kemPublicKey: bytea('kem_public_key'),
        kemSeedNonce: bytea('kem_seed_nonce'),
        encryptedKemSeed: bytea('encrypted_kem_seed'),
        // Version 1 only: the Ed25519 binding, no longer a path to trust.
        kemSignature: bytea('kem_signature'),
        /*
         * Version 2 (docs/identity-pq-design.md): the ML-DSA-65 half of the
         * person's hybrid signature, its 32-byte seed wrapped under the root,
         * and the keys statement over all four public keys, signed with both
         * signing keys (3373 bytes). Null on a version 1 identity.
         */
        mlDsaPublicKey: bytea('ml_dsa_public_key'),
        mlDsaSeedNonce: bytea('ml_dsa_seed_nonce'),
        encryptedMlDsaSeed: bytea('encrypted_ml_dsa_seed'),
        keysSignature: bytea('keys_signature'),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check(
            'account_identities_versions_valid',
            sql`${table.version} in (1, 2) and ${table.keyVersion} > 0`,
        ),
        check(
            'account_identities_kem_valid',
            sql`(${table.kemPublicKey} is null and ${table.kemSeedNonce} is null and ${table.encryptedKemSeed} is null and ${table.kemSignature} is null) or (${table.kemPublicKey} is not null and ${table.kemSeedNonce} is not null and ${table.encryptedKemSeed} is not null and octet_length(${table.kemPublicKey}) = 1184 and octet_length(${table.kemSeedNonce}) = 24 and octet_length(${table.encryptedKemSeed}) = 80 and (${table.kemSignature} is null or octet_length(${table.kemSignature}) = 64))`,
        ),
        check(
            'account_identities_ml_dsa_valid',
            sql`(${table.version} = 1 and ${table.mlDsaPublicKey} is null and ${table.mlDsaSeedNonce} is null and ${table.encryptedMlDsaSeed} is null and ${table.keysSignature} is null) or (${table.version} = 2 and ${table.kemPublicKey} is not null and ${table.kemSignature} is null and ${table.mlDsaPublicKey} is not null and ${table.mlDsaSeedNonce} is not null and ${table.encryptedMlDsaSeed} is not null and ${table.keysSignature} is not null and octet_length(${table.mlDsaPublicKey}) = 1952 and octet_length(${table.mlDsaSeedNonce}) = 24 and octet_length(${table.encryptedMlDsaSeed}) = 48 and octet_length(${table.keysSignature}) = 3373)`,
        ),
        check(
            'account_identities_lengths_valid',
            sql`octet_length(${table.wrappingSalt}) = 32 and octet_length(${table.encryptionPublicKey}) = 32 and octet_length(${table.encryptionPrivateKeyNonce}) = 24 and octet_length(${table.encryptedEncryptionPrivateKey}) = 48 and octet_length(${table.signingPublicKey}) = 32 and octet_length(${table.signingSeedNonce}) = 24 and octet_length(${table.encryptedSigningSeed}) = 48`,
        ),
    ],
);

/*
 * Every identity an account has replaced, kept sealed under the account root as
 * it was, because shares sealed to the old keys still open only with them. Each
 * row carries the succession that replaced it: the new key version and public
 * keys, and the old signing key's signature over the statement in
 * docs/integrity-design.md, so a contact can walk from a pinned identity to the
 * current one link by link without asking for anything else.
 */
export const accountIdentityHistory = pgTable(
    'account_identity_history',
    {
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        version: smallint().notNull(),
        keyVersion: integer('key_version').notNull(),
        wrappingSalt: bytea('wrapping_salt').notNull(),
        encryptionPublicKey: bytea('encryption_public_key').notNull(),
        encryptionPrivateKeyNonce: bytea('encryption_private_key_nonce').notNull(),
        encryptedEncryptionPrivateKey: bytea('encrypted_encryption_private_key').notNull(),
        signingPublicKey: bytea('signing_public_key').notNull(),
        signingSeedNonce: bytea('signing_seed_nonce').notNull(),
        encryptedSigningSeed: bytea('encrypted_signing_seed').notNull(),
        kemPublicKey: bytea('kem_public_key'),
        kemSeedNonce: bytea('kem_seed_nonce'),
        encryptedKemSeed: bytea('encrypted_kem_seed'),
        kemSignature: bytea('kem_signature'),
        mlDsaPublicKey: bytea('ml_dsa_public_key'),
        mlDsaSeedNonce: bytea('ml_dsa_seed_nonce'),
        encryptedMlDsaSeed: bytea('encrypted_ml_dsa_seed'),
        keysSignature: bytea('keys_signature'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
        replacedAt: timestamp('replaced_at', { withTimezone: true }).defaultNow().notNull(),
        // The succession: what replaced this identity, signed by this identity's signing key.
        replacedByKeyVersion: integer('replaced_by_key_version').notNull(),
        newEncryptionPublicKey: bytea('new_encryption_public_key').notNull(),
        newSigningPublicKey: bytea('new_signing_public_key').notNull(),
        newKemPublicKey: bytea('new_kem_public_key').notNull(),
        // Null on successions from a version 1 identity, made before hybrid signatures.
        newMlDsaPublicKey: bytea('new_ml_dsa_public_key'),
        // 64 bytes (Ed25519, version 1 statements) or 3373 (hybrid, version 2).
        successionSignature: bytea('succession_signature').notNull(),
        /*
         * The successor's consent (docs/identity-pq-design.md, "Successor consent"):
         * the old identity's hybrid signature over the consent statement as "old",
         * then the new identity's as "new", 6746 bytes. Checked on upload; null on
         * links made before it, or by a client that does not send it yet. Set with
         * the link, or once later by the account's own backfill (only while null,
         * backfillSuccessionConsent), and never rewritten: a master-key rotation
         * re-wraps the private keys of this row and leaves it alone.
         */
        successionConsent: bytea('succession_consent'),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.keyVersion] }),
        check(
            'account_identity_history_consent_valid',
            sql`${table.successionConsent} is null or (${table.version} = 2 and octet_length(${table.successionConsent}) = 6746)`,
        ),
        check(
            'account_identity_history_versions_valid',
            sql`${table.version} in (1, 2) and ${table.keyVersion} > 0 and ${table.replacedByKeyVersion} > ${table.keyVersion}`,
        ),
        check(
            'account_identity_history_kem_valid',
            sql`(${table.kemPublicKey} is null and ${table.kemSeedNonce} is null and ${table.encryptedKemSeed} is null and ${table.kemSignature} is null) or (octet_length(${table.kemPublicKey}) = 1184 and octet_length(${table.kemSeedNonce}) = 24 and octet_length(${table.encryptedKemSeed}) = 80 and (${table.kemSignature} is null or octet_length(${table.kemSignature}) = 64))`,
        ),
        check(
            'account_identity_history_ml_dsa_valid',
            sql`(${table.version} = 1 and ${table.mlDsaPublicKey} is null and ${table.mlDsaSeedNonce} is null and ${table.encryptedMlDsaSeed} is null and ${table.keysSignature} is null and ${table.newMlDsaPublicKey} is null and octet_length(${table.successionSignature}) = 64) or (${table.version} = 2 and ${table.kemPublicKey} is not null and ${table.mlDsaPublicKey} is not null and ${table.mlDsaSeedNonce} is not null and ${table.encryptedMlDsaSeed} is not null and ${table.keysSignature} is not null and ${table.newMlDsaPublicKey} is not null and octet_length(${table.mlDsaPublicKey}) = 1952 and octet_length(${table.mlDsaSeedNonce}) = 24 and octet_length(${table.encryptedMlDsaSeed}) = 48 and octet_length(${table.keysSignature}) = 3373 and octet_length(${table.newMlDsaPublicKey}) = 1952 and octet_length(${table.successionSignature}) = 3373)`,
        ),
        check(
            'account_identity_history_lengths_valid',
            sql`octet_length(${table.wrappingSalt}) = 32 and octet_length(${table.encryptionPublicKey}) = 32 and octet_length(${table.encryptionPrivateKeyNonce}) = 24 and octet_length(${table.encryptedEncryptionPrivateKey}) = 48 and octet_length(${table.signingPublicKey}) = 32 and octet_length(${table.signingSeedNonce}) = 24 and octet_length(${table.encryptedSigningSeed}) = 48 and octet_length(${table.newEncryptionPublicKey}) = 32 and octet_length(${table.newSigningPublicKey}) = 32 and octet_length(${table.newKemPublicKey}) = 1184`,
        ),
    ],
);

/*
 * A person's settings, one sealed document per account: contact pins and the
 * sharing ledger today, anything else that must agree across devices later.
 * Envelope version 1 was sealed under a key derived from the identity's X25519
 * key; version 2 under the settings key below, so replacing the identity does
 * not strand it. The settings version is a compare-and-set: a device saving
 * over a newer document is refused and re-reads.
 */
export const userSettings = pgTable(
    'user_settings',
    {
        userId: uuid('user_id')
            .primaryKey()
            .references(() => users.id, { onDelete: 'cascade' }),
        version: smallint().notNull().default(1),
        settingsVersion: integer('settings_version').notNull(),
        nonce: bytea().notNull(),
        ciphertext: bytea().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check(
            'user_settings_valid',
            sql`${table.version} in (1, 2) and ${table.settingsVersion} >= 1 and octet_length(${table.nonce}) = 24 and octet_length(${table.ciphertext}) between 16 and 65552`,
        ),
    ],
);

/*
 * The random 32-byte key settings envelope version 2 is sealed under, wrapped
 * under the account root (XChaCha20-Poly1305, 72 bytes with the nonce; see
 * docs/integrity-design.md). Stored once; a master-key rotation re-wraps it
 * with the other account envelopes.
 */
export const accountSettingsKeys = pgTable(
    'account_settings_keys',
    {
        userId: uuid('user_id')
            .primaryKey()
            .references(() => users.id, { onDelete: 'cascade' }),
        nonce: bytea().notNull(),
        ciphertext: bytea().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check(
            'account_settings_keys_lengths_valid',
            sql`octet_length(${table.nonce}) = 24 and octet_length(${table.ciphertext}) = 48`,
        ),
    ],
);

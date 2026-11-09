import { sql } from 'drizzle-orm';
import {
    bigint,
    boolean,
    check,
    index,
    integer,
    pgTable,
    primaryKey,
    smallint,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import { accountDevices, bytea, users, type DeviceKind } from './auth';

/*
 * Two-step sign-in (docs/two-step-design.md 10). The step is a server rule: an
 * account has it on exactly when it has a confirmed factor here, and no flag
 * elsewhere can disagree. Nothing in these tables is end-to-end encrypted; the
 * TOTP secret is sealed under the server's two-step key and backup codes are
 * stored as a keyed, slow hash, both made outside this package.
 */

export type TwoStepFactorKind = 'totp' | 'webauthn';
/* What can answer the step: a factor, a backup code or the recovery phrase. */
export type TwoStepMethod = TwoStepFactorKind | 'backup' | 'phrase';

/*
 * One authenticator app or security key of an account.
 *
 * - confirmed_at: null while an authenticator app is being enrolled. A pending
 *   row never satisfies the step and is swept ten minutes after it was made.
 * - last_used_at: to the hour, never finer (section 9, "What the server learns").
 * - totp_*: the secret sealed under the two-step key named by totp_key_id (the
 *   first 8 bytes of its SHA-256), and the last time step a code was taken
 *   for; a code is accepted only for a later one.
 * - credential_id onwards: a WebAuthn credential as registered. No attestation
 *   statement and no AAGUID.
 */
export const twoStepFactors = pgTable(
    'two_step_factors',
    {
        id: uuid().defaultRandom().primaryKey(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        kind: text().$type<TwoStepFactorKind>().notNull(),
        // Not encrypted, as a device's name is not.
        name: text().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
        lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
        totpKeyId: bytea('totp_key_id'),
        totpNonce: bytea('totp_nonce'),
        totpSecret: bytea('totp_secret'),
        totpLastStep: bigint('totp_last_step', { mode: 'number' }),
        credentialId: bytea('credential_id'),
        publicKey: bytea('public_key'),
        signCount: bigint('sign_count', { mode: 'number' }),
        transports: text().array(),
        backupEligible: boolean('backup_eligible'),
        backupState: boolean('backup_state'),
    },
    (table) => [
        // The same key is not added twice; its leading column serves every read by account.
        uniqueIndex('two_step_factors_credential_idx').on(table.userId, table.credentialId),
        // At most one authenticator app per account.
        uniqueIndex('two_step_factors_totp_idx')
            .on(table.userId)
            .where(sql`${table.kind} = 'totp' and ${table.confirmedAt} is not null`),
        // For the sweep of enrolments nobody finished.
        index('two_step_factors_pending_idx')
            .on(table.createdAt)
            .where(sql`${table.confirmedAt} is null`),
        check('two_step_factors_kind_valid', sql`${table.kind} in ('totp', 'webauthn')`),
        check('two_step_factors_name_length', sql`char_length(${table.name}) between 1 and 40`),
        check(
            'two_step_factors_last_used_hour',
            sql`${table.lastUsedAt} is null or mod(extract(epoch from ${table.lastUsedAt}), 3600) = 0`,
        ),
        check(
            'two_step_factors_kind_columns',
            sql`(${table.kind} = 'totp' and ${table.totpKeyId} is not null and octet_length(${table.totpKeyId}) = 8 and ${table.totpNonce} is not null and octet_length(${table.totpNonce}) = 24 and ${table.totpSecret} is not null and octet_length(${table.totpSecret}) = 36 and ${table.totpLastStep} is not null and ${table.totpLastStep} >= 0 and ${table.credentialId} is null and ${table.publicKey} is null and ${table.signCount} is null and ${table.transports} is null and ${table.backupEligible} is null and ${table.backupState} is null) or (${table.kind} = 'webauthn' and ${table.totpKeyId} is null and ${table.totpNonce} is null and ${table.totpSecret} is null and ${table.totpLastStep} is null and ${table.credentialId} is not null and octet_length(${table.credentialId}) between 1 and 1023 and ${table.publicKey} is not null and octet_length(${table.publicKey}) >= 1 and ${table.signCount} is not null and ${table.signCount} between 0 and 4294967295 and ${table.transports} is not null and ${table.backupEligible} is not null and ${table.backupState} is not null)`,
        ),
    ],
);

/*
 * An account's backup codes, ten at a time: each as Argon2id over an HMAC under
 * the two-step key named by key_id, salted per account (two_step_state). A new
 * set deletes the old one in the same transaction; a used code stays, marked,
 * until then.
 */
export const twoStepBackupCodes = pgTable(
    'two_step_backup_codes',
    {
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        codeHash: bytea('code_hash').notNull(),
        keyId: bytea('key_id').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        usedAt: timestamp('used_at', { withTimezone: true }),
    },
    (table) => [
        primaryKey({ columns: [table.userId, table.codeHash] }),
        check(
            'two_step_backup_codes_lengths_valid',
            sql`octet_length(${table.codeHash}) = 32 and octet_length(${table.keyId}) = 8`,
        ),
    ],
);

/*
 * What a step token is for: answering the step at sign-in (`login`), enrolling
 * a first method at sign-in under a policy (`enrol`), or authorising one
 * security change from a live session (the rest).
 */
export const TWO_STEP_PURPOSES = [
    'login',
    'password',
    'master-key',
    'recovery-key',
    'delete',
    'two-step',
    'device-approval',
    'child-reset',
    'enrol',
] as const;
export type TwoStepPurpose = (typeof TWO_STEP_PURPOSES)[number];

const purposes = TWO_STEP_PURPOSES.map((purpose) => `'${purpose}'`).join(', ');

/*
 * A step token, by its hash, for five minutes. It is bound to the account and
 * the credential version it was issued under, and to a session for every
 * purpose but `login` and `enrol`, which have none yet. A sign-in's token also
 * carries the device the session will attach to (a device that proved its key,
 * or none) and the browser's previous session token. `failures` counts wrong
 * answers; the row goes at the fifth.
 */
export const twoStepAttempts = pgTable(
    'two_step_attempts',
    {
        tokenHash: bytea('token_hash').primaryKey(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        purpose: text().$type<TwoStepPurpose>().notNull(),
        sessionTokenHash: bytea('session_token_hash'),
        credentialVersion: integer('credential_version').notNull(),
        deviceId: uuid('device_id').references(() => accountDevices.id, { onDelete: 'cascade' }),
        previousTokenHash: bytea('previous_token_hash'),
        webauthnChallenge: bytea('webauthn_challenge'),
        failures: smallint().notNull().default(0),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    },
    (table) => [
        index('two_step_attempts_user_idx').on(table.userId),
        index('two_step_attempts_expiry_idx').on(table.expiresAt),
        // Behind the device's on-delete-cascade, so a sweep's deletes don't scan the table.
        index('two_step_attempts_device_idx')
            .on(table.deviceId)
            .where(sql`${table.deviceId} is not null`),
        check('two_step_attempts_purpose_valid', sql.raw(`"purpose" in (${purposes})`)),
        check(
            'two_step_attempts_session_binding',
            sql`(${table.purpose} in ('login', 'enrol')) = (${table.sessionTokenHash} is null) and (${table.sessionTokenHash} is null or octet_length(${table.sessionTokenHash}) = 32)`,
        ),
        check(
            'two_step_attempts_login_only',
            sql`${table.purpose} = 'login' or (${table.deviceId} is null and ${table.previousTokenHash} is null)`,
        ),
        check(
            'two_step_attempts_lengths_valid',
            sql`octet_length(${table.tokenHash}) = 32 and (${table.previousTokenHash} is null or octet_length(${table.previousTokenHash}) = 32) and (${table.webauthnChallenge} is null or octet_length(${table.webauthnChallenge}) = 32)`,
        ),
        check(
            'two_step_attempts_valid',
            sql`${table.credentialVersion} > 0 and ${table.failures} between 0 and 5 and ${table.expiresAt} > ${table.createdAt}`,
        ),
    ],
);

/*
 * What an account's step keeps beside its factors, made once and kept while the
 * account lives: the WebAuthn user handle (random, not the account id), the
 * salt of its backup codes, and the lockout state of sign-ins that proved no
 * device: how many codes in a row were wrong, and when that froze the
 * authenticator app for new devices. A known device's own count is
 * account_devices.two_step_failures.
 */
export const twoStepState = pgTable(
    'two_step_state',
    {
        userId: uuid('user_id')
            .primaryKey()
            .references(() => users.id, { onDelete: 'cascade' }),
        webauthnUserHandle: bytea('webauthn_user_handle').notNull().unique(),
        backupCodeSalt: bytea('backup_code_salt').notNull(),
        consecutiveFailures: integer('consecutive_failures').notNull().default(0),
        totpFrozenAt: timestamp('totp_frozen_at', { withTimezone: true }),
    },
    (table) => [
        check(
            'two_step_state_valid',
            sql`octet_length(${table.webauthnUserHandle}) = 32 and octet_length(${table.backupCodeSalt}) = 16 and ${table.consecutiveFailures} >= 0`,
        ),
    ],
);

/*
 * The security log a person reads in Settings (section 7), kept for 90 days:
 * the kind of event, the method that answered the step if one did, and the
 * kind of device. Never a name, an address or a browser. The device id goes
 * null when the device does; the line stays.
 */
export const accountSecurityEvents = pgTable(
    'account_security_events',
    {
        id: uuid().defaultRandom().primaryKey(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        kind: text().notNull(),
        method: text().$type<TwoStepMethod>(),
        deviceId: uuid('device_id').references(() => accountDevices.id, { onDelete: 'set null' }),
        deviceKind: text('device_kind').$type<DeviceKind>(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('account_security_events_user_idx').on(table.userId, table.createdAt),
        index('account_security_events_created_idx').on(table.createdAt),
        // Behind the device's on-delete-set-null, so a sweep's deletes don't scan the table.
        index('account_security_events_device_idx')
            .on(table.deviceId)
            .where(sql`${table.deviceId} is not null`),
        check(
            'account_security_events_kind_length',
            sql`char_length(${table.kind}) between 1 and 40`,
        ),
        check(
            'account_security_events_method_valid',
            sql`${table.method} is null or ${table.method} in ('totp', 'webauthn', 'backup', 'phrase')`,
        ),
        check(
            'account_security_events_device_kind_valid',
            sql`${table.deviceKind} is null or ${table.deviceKind} in ('web', 'ios', 'android')`,
        ),
    ],
);

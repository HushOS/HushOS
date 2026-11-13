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
 * Two-step sign-in (docs/two-step-design.md 10). The step is a server rule: these rows decide
 * whether the server opens a session and releases the password envelope, and nothing here is
 * end-to-end encrypted. An account has the step on exactly when it has a confirmed factor;
 * there is no flag that could disagree with the factors.
 */

export type TwoStepFactorKind = 'totp' | 'webauthn';
/* What can pass the step: a factor's kind, a backup code or the recovery phrase. */
export type TwoStepMethod = TwoStepFactorKind | 'backup' | 'phrase';

/*
 * What a step token is for. `login` and `enrol` come from a sign-in that has no session yet;
 * every other purpose is a step-up bound to the session that asked.
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
export type TwoStepSessionPurpose = Exclude<TwoStepPurpose, 'login' | 'enrol'>;

const sessionPurposes = TWO_STEP_PURPOSES.filter(
    (purpose) => purpose !== 'login' && purpose !== 'enrol',
)
    .map((purpose) => `'${purpose}'`)
    .join(', ');

/*
 * A method: an authenticator app (TOTP) or, from the security-key release, a WebAuthn
 * credential. A row is pending until `confirmed_at` is set; a pending row never satisfies the
 * step, and the worker deletes it ten minutes after it was made.
 *
 * - TOTP: the shared secret sealed under the two-step key (XChaCha20-Poly1305, 20 bytes and the
 *   tag), the id of the key it is sealed under, and the last time step a code was accepted for.
 *   The server can open the secret while it runs; a copy of the database without the key cannot.
 * - WebAuthn: the credential id, COSE public key, signature counter, transports and the two
 *   backup flags. No attestation statement and no AAGUID are kept.
 * - `last_used_at` is kept to the hour, as the list shows it.
 */
export const twoStepFactors = pgTable(
    'two_step_factors',
    {
        id: uuid().defaultRandom().primaryKey(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        kind: text().notNull().$type<TwoStepFactorKind>(),
        // A security key's name, chosen by whoever added it and not encrypted. An app has none.
        name: text(),
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
        // Per account, never global: a global constraint would say whether a key is in use elsewhere.
        // It also serves every lookup by account, the session guard's included.
        uniqueIndex('two_step_factors_user_credential_idx').on(table.userId, table.credentialId),
        uniqueIndex('two_step_factors_one_totp_idx')
            .on(table.userId)
            .where(sql`${table.kind} = 'totp' and ${table.confirmedAt} is not null`),
        index('two_step_factors_pending_idx')
            .on(table.createdAt)
            .where(sql`${table.confirmedAt} is null`),
        check('two_step_factors_kind_valid', sql`${table.kind} in ('totp', 'webauthn')`),
        check(
            'two_step_factors_totp_valid',
            sql`(${table.kind} = 'totp' and ${table.name} is null and ${table.totpKeyId} is not null and ${table.totpNonce} is not null and ${table.totpSecret} is not null and ${table.totpLastStep} is not null and octet_length(${table.totpKeyId}) = 8 and octet_length(${table.totpNonce}) = 24 and octet_length(${table.totpSecret}) = 36 and ${table.totpLastStep} >= 0 and (${table.confirmedAt} is null or ${table.totpLastStep} > 0)) or (${table.kind} <> 'totp' and ${table.totpKeyId} is null and ${table.totpNonce} is null and ${table.totpSecret} is null and ${table.totpLastStep} is null)`,
        ),
        check(
            'two_step_factors_webauthn_valid',
            sql`(${table.kind} = 'webauthn' and ${table.name} is not null and char_length(${table.name}) between 1 and 40 and ${table.credentialId} is not null and ${table.publicKey} is not null and ${table.signCount} is not null and ${table.transports} is not null and ${table.backupEligible} is not null and ${table.backupState} is not null and octet_length(${table.credentialId}) between 1 and 1023 and octet_length(${table.publicKey}) between 1 and 2048 and ${table.signCount} between 0 and 4294967295 and cardinality(${table.transports}) <= 8) or (${table.kind} <> 'webauthn' and ${table.credentialId} is null and ${table.publicKey} is null and ${table.signCount} is null and ${table.transports} is null and ${table.backupEligible} is null and ${table.backupState} is null)`,
        ),
        check(
            'two_step_factors_times_valid',
            sql`(${table.confirmedAt} is not null or ${table.lastUsedAt} is null) and (${table.lastUsedAt} is null or ${table.lastUsedAt} = date_trunc('hour', ${table.lastUsedAt}, 'UTC'))`,
        ),
    ],
);

/*
 * Backup codes, never in plain text: each row is
 * Argon2id(HMAC-SHA-256(twoStepKey, code), accountSalt), with the id of the key it was made
 * under (a set keeps verifying under its own key until the person makes a new one). A code is
 * used once: `used_at` is set by a conditional update, so two requests with one code give one
 * success. A new set deletes the old one in the same transaction.
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
 * Step tokens: what `login/finish` hands a sign-in that must pass the step, and what a session
 * asks for before a security change. Only the token's hash is kept. A token is bound to the
 * credential version it was made at, to its purpose and, for a step-up, to its session. A
 * token that ends by opening a session (`login`, and `enrol` when policies arrive) also
 * carries the device that proved its key (null without a proof) and the browser's previous
 * session, for the session the step will open.
 *
 * A token allows five answers. `answers` counts the slots taken: one is taken, under the
 * account's lock, before an answer is checked, so however many requests arrive at once only
 * five are ever checked. `failures` counts the slots that turned out wrong: the fifth deletes
 * the row, so a stored count never passes 4, and never passes the slots taken.
 */
export const twoStepAttempts = pgTable(
    'two_step_attempts',
    {
        tokenHash: bytea('token_hash').primaryKey(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        purpose: text().notNull().$type<TwoStepPurpose>(),
        sessionTokenHash: bytea('session_token_hash'),
        credentialVersion: integer('credential_version').notNull(),
        deviceId: uuid('device_id').references(() => accountDevices.id, { onDelete: 'cascade' }),
        previousTokenHash: bytea('previous_token_hash'),
        webauthnChallenge: bytea('webauthn_challenge'),
        answers: smallint().notNull().default(0),
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
        check(
            'two_step_attempts_purpose_binding',
            sql`(${table.purpose} in ('login', 'enrol') and ${table.sessionTokenHash} is null) or (${table.purpose} in (${sql.raw(sessionPurposes)}) and ${table.sessionTokenHash} is not null and octet_length(${table.sessionTokenHash}) = 32)`,
        ),
        // Only a token that ends by opening a session carries what that session attaches to.
        check(
            'two_step_attempts_session_opening',
            sql`${table.purpose} in ('login', 'enrol') or (${table.deviceId} is null and ${table.previousTokenHash} is null)`,
        ),
        check(
            'two_step_attempts_lengths_valid',
            sql`octet_length(${table.tokenHash}) = 32 and (${table.previousTokenHash} is null or octet_length(${table.previousTokenHash}) = 32) and (${table.webauthnChallenge} is null or octet_length(${table.webauthnChallenge}) = 32)`,
        ),
        check(
            'two_step_attempts_valid',
            sql`${table.credentialVersion} > 0 and ${table.failures} between 0 and 4 and ${table.answers} between ${table.failures} and 5 and ${table.expiresAt} > ${table.createdAt}`,
        ),
    ],
);

/*
 * What an account's step keeps beside its factors, made once and kept while the account lives:
 * the WebAuthn user handle (random, never the account id), the salt its backup codes are hashed
 * with, and the counters for sign-ins that proved no device: how many wrong answers in a row,
 * and when that froze the authenticator app for new devices. A device that proved its key has
 * its own count, `account_devices.two_step_failures`.
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
 * The security log (docs/two-step-design.md 7): one line per sign-in, failed step, change to
 * the step and other security event, kept for 90 days. A line carries the kind of event, the
 * method that passed the step, the device's kind and the time; never a name, an address or a
 * browser. The device link goes when the device does.
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
        // The kinds arrive with the code that writes them; the shape is fixed here.
        check('account_security_events_kind_valid', sql`${table.kind} ~ '^[a-z][a-z0-9-]{0,39}$'`),
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

/*
 * The web processes that read two-step rows, one row each (docs/two-step-design.md 8): the key
 * a process seals new secrets under and the keys it can read, as key ids (the first 8 bytes of
 * a key's SHA-256, in hex; never a key), and when it last said so. Each process writes its
 * own row at its readiness checks. The worker re-seals secrets towards a key only when every
 * process seen lately seals under it and has for a while, so a rollout that is half way, or
 * about to be taken back, moves nothing to a key some process cannot read.
 *
 * - `instance_id` is random, made when the process starts: a restart is a new reader.
 * - `sealing_since` is when this process first said it seals under `sealing_key_id`.
 * - A row not seen for an hour is deleted by the worker.
 */
export const twoStepKeyReaders = pgTable(
    'two_step_key_readers',
    {
        instanceId: uuid('instance_id').primaryKey(),
        sealingKeyId: text('sealing_key_id').notNull(),
        readableKeyIds: text('readable_key_ids').array().notNull(),
        sealingSince: timestamp('sealing_since', { withTimezone: true }).notNull(),
        seenAt: timestamp('seen_at', { withTimezone: true }).notNull(),
    },
    (table) => [
        index('two_step_key_readers_seen_idx').on(table.seenAt),
        check('two_step_key_readers_sealing_valid', sql`${table.sealingKeyId} ~ '^[0-9a-f]{16}$'`),
        // The keys a process has are at most three: the current one, the previous one, the derived one.
        check(
            'two_step_key_readers_readable_valid',
            sql`cardinality(${table.readableKeyIds}) between 1 and 8 and ${table.sealingKeyId} = any(${table.readableKeyIds})`,
        ),
        check('two_step_key_readers_times_valid', sql`${table.sealingSince} <= ${table.seenAt}`),
    ],
);

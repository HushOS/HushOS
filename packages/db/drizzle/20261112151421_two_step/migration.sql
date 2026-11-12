-- Two-step sign-in (docs/two-step-design.md 10): the tables, "sessions"."two_step_at" and
-- "account_devices"."two_step_failures". No existing row changes: nobody has a factor until a
-- later release lets them make one. undo.sql beside this file takes it back.
-- Hand-edited: the comments and lock_timeout. drizzle runs every pending migration in one
-- transaction, so the exclusive locks ADD COLUMN takes on "account_devices" and "sessions" are held
-- until the run commits. Both columns are added without rewriting their table (one is nullable with
-- no default, the other has a constant default). lock_timeout bounds the wait for each lock, so a
-- long transaction ahead cannot queue every signed-in request behind this migration: the migration
-- fails and is retried instead.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "account_security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"method" text,
	"device_id" uuid,
	"device_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_security_events_kind_valid" CHECK ("kind" ~ '^[a-z][a-z0-9-]{0,39}$'),
	CONSTRAINT "account_security_events_method_valid" CHECK ("method" is null or "method" in ('totp', 'webauthn', 'backup', 'phrase')),
	CONSTRAINT "account_security_events_device_kind_valid" CHECK ("device_kind" is null or "device_kind" in ('web', 'ios', 'android'))
);
--> statement-breakpoint
CREATE TABLE "two_step_attempts" (
	"token_hash" bytea PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"session_token_hash" bytea,
	"credential_version" integer NOT NULL,
	"device_id" uuid,
	"previous_token_hash" bytea,
	"webauthn_challenge" bytea,
	"failures" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "two_step_attempts_purpose_binding" CHECK (("purpose" in ('login', 'enrol') and "session_token_hash" is null) or ("purpose" in ('password', 'master-key', 'recovery-key', 'delete', 'two-step', 'device-approval', 'child-reset') and "session_token_hash" is not null and octet_length("session_token_hash") = 32)),
	CONSTRAINT "two_step_attempts_login_only" CHECK ("purpose" = 'login' or ("device_id" is null and "previous_token_hash" is null)),
	CONSTRAINT "two_step_attempts_lengths_valid" CHECK (octet_length("token_hash") = 32 and ("previous_token_hash" is null or octet_length("previous_token_hash") = 32) and ("webauthn_challenge" is null or octet_length("webauthn_challenge") = 32)),
	CONSTRAINT "two_step_attempts_valid" CHECK ("credential_version" > 0 and "failures" between 0 and 4 and "expires_at" > "created_at")
);
--> statement-breakpoint
CREATE TABLE "two_step_backup_codes" (
	"user_id" uuid,
	"code_hash" bytea,
	"key_id" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "two_step_backup_codes_pkey" PRIMARY KEY("user_id","code_hash"),
	CONSTRAINT "two_step_backup_codes_lengths_valid" CHECK (octet_length("code_hash") = 32 and octet_length("key_id") = 8)
);
--> statement-breakpoint
CREATE TABLE "two_step_factors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"totp_key_id" bytea,
	"totp_nonce" bytea,
	"totp_secret" bytea,
	"totp_last_step" bigint,
	"credential_id" bytea,
	"public_key" bytea,
	"sign_count" bigint,
	"transports" text[],
	"backup_eligible" boolean,
	"backup_state" boolean,
	CONSTRAINT "two_step_factors_kind_valid" CHECK ("kind" in ('totp', 'webauthn')),
	CONSTRAINT "two_step_factors_totp_valid" CHECK (("kind" = 'totp' and "name" is null and "totp_key_id" is not null and "totp_nonce" is not null and "totp_secret" is not null and "totp_last_step" is not null and octet_length("totp_key_id") = 8 and octet_length("totp_nonce") = 24 and octet_length("totp_secret") = 36 and "totp_last_step" >= 0 and ("confirmed_at" is null or "totp_last_step" > 0)) or ("kind" <> 'totp' and "totp_key_id" is null and "totp_nonce" is null and "totp_secret" is null and "totp_last_step" is null)),
	CONSTRAINT "two_step_factors_webauthn_valid" CHECK (("kind" = 'webauthn' and "name" is not null and char_length("name") between 1 and 40 and "credential_id" is not null and "public_key" is not null and "sign_count" is not null and "transports" is not null and "backup_eligible" is not null and "backup_state" is not null and octet_length("credential_id") between 1 and 1023 and octet_length("public_key") between 1 and 2048 and "sign_count" between 0 and 4294967295 and cardinality("transports") <= 8) or ("kind" <> 'webauthn' and "credential_id" is null and "public_key" is null and "sign_count" is null and "transports" is null and "backup_eligible" is null and "backup_state" is null)),
	CONSTRAINT "two_step_factors_times_valid" CHECK (("confirmed_at" is not null or "last_used_at" is null) and ("last_used_at" is null or "last_used_at" = date_trunc('hour', "last_used_at", 'UTC')))
);
--> statement-breakpoint
CREATE TABLE "two_step_state" (
	"user_id" uuid PRIMARY KEY,
	"webauthn_user_handle" bytea NOT NULL UNIQUE,
	"backup_code_salt" bytea NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"totp_frozen_at" timestamp with time zone,
	CONSTRAINT "two_step_state_valid" CHECK (octet_length("webauthn_user_handle") = 32 and octet_length("backup_code_salt") = 16 and "consecutive_failures" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account_devices" ADD COLUMN "two_step_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "two_step_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "account_security_events_user_idx" ON "account_security_events" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "account_security_events_created_idx" ON "account_security_events" ("created_at");--> statement-breakpoint
CREATE INDEX "account_security_events_device_idx" ON "account_security_events" ("device_id") WHERE "device_id" is not null;--> statement-breakpoint
CREATE INDEX "two_step_attempts_user_idx" ON "two_step_attempts" ("user_id");--> statement-breakpoint
CREATE INDEX "two_step_attempts_expiry_idx" ON "two_step_attempts" ("expires_at");--> statement-breakpoint
CREATE INDEX "two_step_attempts_device_idx" ON "two_step_attempts" ("device_id") WHERE "device_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "two_step_factors_user_credential_idx" ON "two_step_factors" ("user_id","credential_id");--> statement-breakpoint
CREATE UNIQUE INDEX "two_step_factors_one_totp_idx" ON "two_step_factors" ("user_id") WHERE "kind" = 'totp' and "confirmed_at" is not null;--> statement-breakpoint
CREATE INDEX "two_step_factors_pending_idx" ON "two_step_factors" ("created_at") WHERE "confirmed_at" is null;--> statement-breakpoint
ALTER TABLE "account_security_events" ADD CONSTRAINT "account_security_events_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_security_events" ADD CONSTRAINT "account_security_events_device_id_account_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "account_devices"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "two_step_attempts" ADD CONSTRAINT "two_step_attempts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "two_step_attempts" ADD CONSTRAINT "two_step_attempts_device_id_account_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "account_devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "two_step_backup_codes" ADD CONSTRAINT "two_step_backup_codes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "two_step_factors" ADD CONSTRAINT "two_step_factors_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "two_step_state" ADD CONSTRAINT "two_step_state_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_devices" ADD CONSTRAINT "account_devices_two_step_failures_valid" CHECK ("two_step_failures" >= 0);--> statement-breakpoint
ALTER TABLE "opaque_login_attempts" DROP CONSTRAINT "opaque_login_attempts_purpose_binding", ADD CONSTRAINT "opaque_login_attempts_purpose_binding" CHECK (("purpose" = 'login' and "session_token_hash" is null) or ("purpose" in ('delete', 'password', 'master-key', 'recovery-key', 'devices', 'two-step') and "session_token_hash" is not null and octet_length("session_token_hash") = 32));
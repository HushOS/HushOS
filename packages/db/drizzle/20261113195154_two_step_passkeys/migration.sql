-- Passkeys and security keys as a second step, and the default method (docs/two-step-design.md 3, 12):
--   - "two_step_key_registrations", empty: a key being added, between the options the server hands
--     out and the key's answer. The WebAuthn columns of "two_step_factors" have been there since
--     20261112160538_two_step, and the session guard already counts a confirmed factor of any kind.
--   - "two_step_state"."default_kind", nullable with no default (no rewrite): the kind of method
--     the person is offered first.
--   - three notices among the kinds a notification event may have: a key added, a key removed, and
--     a key whose counter did not go up.
-- Hand-edited: the comments, lock_timeout and the UPDATE at the end.
-- Locks: ADD COLUMN and the two CHECKs take an exclusive lock on "two_step_state" and on
-- "notification_events" and read each once (one row per account that ever started the step; 30
-- days of events at most); the new table's foreign key locks "users" against writes. All are held
-- until the run commits: milliseconds. lock_timeout bounds each wait, so a long transaction ahead
-- cannot queue every sign-in behind this migration: the migration fails and is retried instead.
-- An older release cannot serve an event of a new kind (its response schema refuses it), so
-- before rolling back past this migration delete those events; undo.sql beside this file does
-- (docs/self-hosting.md).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "two_step_key_registrations" (
	"token_hash" bytea PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"session_token_hash" bytea NOT NULL,
	"credential_version" integer NOT NULL,
	"challenge" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "two_step_key_registrations_valid" CHECK (octet_length("token_hash") = 32 and octet_length("session_token_hash") = 32 and octet_length("challenge") = 32 and "credential_version" > 0 and "expires_at" > "created_at")
);
--> statement-breakpoint
ALTER TABLE "two_step_state" ADD COLUMN "default_kind" text;--> statement-breakpoint
CREATE INDEX "two_step_key_registrations_user_idx" ON "two_step_key_registrations" ("user_id");--> statement-breakpoint
CREATE INDEX "two_step_key_registrations_expiry_idx" ON "two_step_key_registrations" ("expires_at");--> statement-breakpoint
ALTER TABLE "two_step_key_registrations" ADD CONSTRAINT "two_step_key_registrations_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "two_step_state" ADD CONSTRAINT "two_step_state_default_valid" CHECK ("default_kind" is null or "default_kind" in ('webauthn', 'totp', 'device'));--> statement-breakpoint
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_kind_valid", ADD CONSTRAINT "notification_events_kind_valid" CHECK (kind in ('new-device', 'device-removed', 'devices-removed', 'password-attempts', 'two-step-on', 'two-step-off', 'two-step-app-added', 'two-step-app-removed', 'backup-codes-made', 'backup-code-used', 'phrase-used', 'phrase-replaced', 'password-reset', 'account-key-rotated', 'step-failed', 'change-step-failed', 'totp-frozen', 'two-step-key-added', 'two-step-key-removed', 'key-counter', 'shared', 'family-invitation', 'family-waiting'));--> statement-breakpoint
-- The first method turned on is the default. Every account that has the step today turned it on
-- with an authenticator app, the only method there was, so that is what it is offered first, and
-- adding a passkey later does not move it. An account without a confirmed app is left alone.
UPDATE "two_step_state" AS state SET "default_kind" = 'totp' WHERE EXISTS (SELECT 1 FROM "two_step_factors" AS factor WHERE factor."user_id" = state."user_id" AND factor."kind" = 'totp' AND factor."confirmed_at" IS NOT NULL);

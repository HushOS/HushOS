-- Approve on another device as a second step (docs/two-step-design.md 12):
--   - "two_step_factors" takes the kind 'device': the account takes an approval from one of its
--     other devices as its second step. No new column: the row holds no secret and no name. One
--     per account. The session guard already counts a confirmed factor of any kind.
--   - "two_step_device_requests", empty: one request to approve, from its commitment to its end,
--     with the rough place the asking device is in while the request is open, where the operator's
--     proxy says one (TRUSTED_COUNTRY_HEADER, TRUSTED_REGION_HEADER, TRUSTED_CITY_HEADER).
--   - 'device' among the methods a line of the security log may name.
--   - three kinds among those a notification event may have: the method added, the method
--     removed, and the prompt an approving device is pinged for.
-- Hand-edited: the comments and lock_timeout.
-- Locks: the CHECKs take an exclusive lock on "two_step_factors", "account_security_events" and
-- "notification_events" and read each once (a row per method, 90 days of log lines, 30 days of
-- events); the new table's foreign keys lock "users" and "account_devices" against writes. All
-- are held until the run commits: milliseconds. lock_timeout bounds each wait, so a long
-- transaction ahead cannot queue every sign-in behind this migration: the migration fails and is
-- retried instead.
-- An older release cannot serve a method, a log line or an event of a new kind, so before rolling
-- back past this migration remove them; undo.sql beside this file does (docs/self-hosting.md).
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "two_step_device_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"token_hash" bytea NOT NULL,
	"purpose" text NOT NULL,
	"class" text NOT NULL,
	"device_id" uuid,
	"device_kind" text,
	"device_name" text,
	"location" text,
	"commitment" bytea NOT NULL,
	"approver_device_id" uuid,
	"approver_key" bytea,
	"device_key" bytea,
	"nonce" bytea,
	"signature" bytea,
	"state" text DEFAULT 'waiting' NOT NULL,
	"ended_reason" text,
	"counted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "two_step_device_requests_purpose_valid" CHECK ("purpose" in ('login', 'password', 'master-key', 'recovery-key', 'delete', 'two-step', 'device-approval', 'child-reset')),
	CONSTRAINT "two_step_device_requests_class_valid" CHECK (("class" = 'unknown' and "purpose" = 'login' and "device_id" is null) or ("class" = 'known' and "purpose" = 'login' and "device_id" is not null) or ("class" = 'change' and "purpose" <> 'login' and "device_id" is not null)),
	CONSTRAINT "two_step_device_requests_device_valid" CHECK (("device_kind" is null or "device_kind" in ('web', 'ios', 'android')) and ("device_name" is null or char_length("device_name") between 1 and 40)),
	CONSTRAINT "two_step_device_requests_lengths_valid" CHECK (octet_length("token_hash") = 32 and octet_length("commitment") = 32 and ("approver_key" is null or octet_length("approver_key") = 32) and ("device_key" is null or octet_length("device_key") = 32) and ("nonce" is null or octet_length("nonce") = 32) and ("signature" is null or octet_length("signature") = 64)),
	CONSTRAINT "two_step_device_requests_state_valid" CHECK ("state" in ('waiting', 'opened', 'revealed', 'approved', 'ended') and ("state" <> 'waiting' or ("approver_device_id" is null and "approver_key" is null)) and ("state" not in ('opened', 'revealed', 'approved') or ("approver_device_id" is not null and "approver_key" is not null)) and ("state" not in ('waiting', 'opened') or ("device_key" is null and "nonce" is null and "signature" is null)) and ("state" not in ('revealed', 'approved') or ("device_key" is not null and "nonce" is not null)) and (("device_key" is null) = ("nonce" is null)) and ("state" <> 'revealed' or "signature" is null) and ("state" <> 'approved' or "signature" is not null)),
	CONSTRAINT "two_step_device_requests_location_valid" CHECK ("location" is null or ("state" <> 'ended' and char_length("location") between 1 and 200)),
	CONSTRAINT "two_step_device_requests_end_valid" CHECK (("state" = 'ended') = ("ended_reason" is not null) and ("state" = 'ended') = ("ended_at" is not null) and ("ended_reason" is null or "ended_reason" in ('used', 'passed', 'denied', 'wrong-code', 'not-me', 'mismatch', 'replaced', 'expired', 'off')) and "expires_at" > "created_at")
);
--> statement-breakpoint
CREATE INDEX "two_step_device_requests_user_idx" ON "two_step_device_requests" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "two_step_device_requests_token_idx" ON "two_step_device_requests" ("token_hash");--> statement-breakpoint
CREATE INDEX "two_step_device_requests_created_idx" ON "two_step_device_requests" ("created_at");--> statement-breakpoint
CREATE INDEX "two_step_device_requests_device_idx" ON "two_step_device_requests" ("device_id") WHERE "device_id" is not null;--> statement-breakpoint
CREATE INDEX "two_step_device_requests_approver_idx" ON "two_step_device_requests" ("approver_device_id") WHERE "approver_device_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "two_step_factors_one_device_idx" ON "two_step_factors" ("user_id") WHERE "kind" = 'device';--> statement-breakpoint
ALTER TABLE "two_step_device_requests" ADD CONSTRAINT "two_step_device_requests_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "two_step_device_requests" ADD CONSTRAINT "two_step_device_requests_device_id_account_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "account_devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "two_step_device_requests" ADD CONSTRAINT "two_step_device_requests_T2guW4DVYiIA_fkey" FOREIGN KEY ("approver_device_id") REFERENCES "account_devices"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "two_step_factors" ADD CONSTRAINT "two_step_factors_device_valid" CHECK ("kind" <> 'device' or "name" is null);--> statement-breakpoint
ALTER TABLE "notification_events" DROP CONSTRAINT "notification_events_kind_valid", ADD CONSTRAINT "notification_events_kind_valid" CHECK (kind in ('new-device', 'device-removed', 'devices-removed', 'password-attempts', 'two-step-on', 'two-step-off', 'two-step-app-added', 'two-step-app-removed', 'backup-codes-made', 'backup-code-used', 'phrase-used', 'phrase-replaced', 'password-reset', 'account-key-rotated', 'step-failed', 'change-step-failed', 'totp-frozen', 'two-step-key-added', 'two-step-key-removed', 'key-counter', 'two-step-device-added', 'two-step-device-removed', 'approval-request', 'shared', 'family-invitation', 'family-waiting'));--> statement-breakpoint
ALTER TABLE "account_security_events" DROP CONSTRAINT "account_security_events_method_valid", ADD CONSTRAINT "account_security_events_method_valid" CHECK ("method" is null or "method" in ('totp', 'webauthn', 'device', 'backup', 'phrase'));--> statement-breakpoint
ALTER TABLE "two_step_factors" DROP CONSTRAINT "two_step_factors_kind_valid", ADD CONSTRAINT "two_step_factors_kind_valid" CHECK ("kind" in ('totp', 'webauthn', 'device'));
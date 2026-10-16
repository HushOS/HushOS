-- Hand-edited. drizzle runs every pending migration in one transaction (drizzle-orm's pg migrator,
-- which drizzle-kit migrate uses), so the exclusive lock ADD COLUMN takes on "sessions" is held until
-- the run commits. lock_timeout bounds the wait for it, so a long transaction ahead cannot queue every
-- signed-in request behind this migration: the migration fails and is retried instead.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "account_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"kind" text,
	"name" text,
	"signing_public_key" bytea,
	"approved_by" text,
	"approved_by_device_id" uuid,
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "account_devices_kind_valid" CHECK ("kind" is null or "kind" in ('web', 'ios', 'android')),
	CONSTRAINT "account_devices_name_length" CHECK ("name" is null or char_length("name") between 1 and 40),
	CONSTRAINT "account_devices_key_length" CHECK ("signing_public_key" is null or octet_length("signing_public_key") = 32),
	CONSTRAINT "account_devices_approved_by_valid" CHECK ("approved_by" is null or "approved_by" in ('enrolment', 'password', 'device', 'phrase', 'email-wait', 'guardian', 'existing')),
	CONSTRAINT "account_devices_approver_valid" CHECK ("approved_by" = 'device' or "approved_by_device_id" is null),
	CONSTRAINT "account_devices_approval_pair" CHECK (("approved_by" is null) = ("approved_at" is null))
);
--> statement-breakpoint
CREATE TABLE "removed_session_tokens" (
	"token_hash" bytea PRIMARY KEY,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "removed_session_tokens_hash_length" CHECK (octet_length("token_hash") = 32)
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_id" uuid;--> statement-breakpoint
-- The backfill (drizzle-kit does not write data): every live session becomes a device of its own,
-- approved as "existing", reusing the session's id so the result is deterministic and needs no
-- mapping. The client fills in kind, name and key on its next request. device_id stays nullable for
-- one release: a container still on the previous version may insert a session without one during a
-- rolling update, and getSessionUser simply does not resolve it. sessions_device_not_null follows,
-- and begins by deleting sessions that still have no device.
DELETE FROM "sessions" WHERE "expires_at" <= now();--> statement-breakpoint
INSERT INTO "account_devices" ("id", "user_id", "approved_by", "approved_at", "created_at", "last_seen_at")
SELECT "id", "user_id", 'existing', "created_at", "created_at", "last_seen_at" FROM "sessions";--> statement-breakpoint
UPDATE "sessions" SET "device_id" = "id";--> statement-breakpoint
CREATE INDEX "account_devices_approver_idx" ON "account_devices" ("approved_by_device_id") WHERE "approved_by_device_id" is not null;--> statement-breakpoint
CREATE INDEX "account_devices_user_live_idx" ON "account_devices" ("user_id") WHERE "revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "account_devices_user_key_idx" ON "account_devices" ("user_id","signing_public_key") WHERE "signing_public_key" is not null;--> statement-breakpoint
CREATE INDEX "removed_session_tokens_expiry_idx" ON "removed_session_tokens" ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_device_idx" ON "sessions" ("device_id");--> statement-breakpoint
ALTER TABLE "account_devices" ADD CONSTRAINT "account_devices_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_devices" ADD CONSTRAINT "account_devices_approved_by_device_id_account_devices_id_fkey" FOREIGN KEY ("approved_by_device_id") REFERENCES "account_devices"("id") ON DELETE SET NULL;--> statement-breakpoint
-- Added unchecked, then checked. Inside drizzle's single transaction this gains nothing: ADD COLUMN
-- already holds the exclusive lock on "sessions" until commit. Kept for when this runs on its own.
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_account_devices_id_fkey" FOREIGN KEY ("device_id") REFERENCES "account_devices"("id") ON DELETE CASCADE NOT VALID;--> statement-breakpoint
ALTER TABLE "sessions" VALIDATE CONSTRAINT "sessions_device_id_account_devices_id_fkey";--> statement-breakpoint
ALTER TABLE "opaque_login_attempts" DROP CONSTRAINT "opaque_login_attempts_purpose_binding", ADD CONSTRAINT "opaque_login_attempts_purpose_binding" CHECK (("purpose" = 'login' and "session_token_hash" is null) or ("purpose" in ('delete', 'password', 'master-key', 'recovery-key', 'devices') and "session_token_hash" is not null and octet_length("session_token_hash") = 32));
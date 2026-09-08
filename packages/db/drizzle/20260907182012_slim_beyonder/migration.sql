CREATE TABLE "account_recovery_attempts" (
	"token_hash" bytea PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"enrollment_id" uuid NOT NULL,
	"credential_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_recovery_attempts_valid" CHECK (octet_length("token_hash") = 32 and "credential_version" > 0 and "expires_at" > "created_at")
);
--> statement-breakpoint
CREATE TABLE "account_recovery_keys" (
	"user_id" uuid PRIMARY KEY,
	"version" smallint DEFAULT 1 NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"recovery_version" integer DEFAULT 1 NOT NULL,
	"wrapping_salt" bytea NOT NULL,
	"wrapping_nonce" bytea NOT NULL,
	"encrypted_key" bytea NOT NULL,
	"backup_nonce" bytea NOT NULL,
	"encrypted_recovery_key" bytea NOT NULL,
	"public_key" bytea NOT NULL,
	"confirmed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_recovery_keys_versions_valid" CHECK ("version" = 1 and "key_version" = 1 and "recovery_version" > 0),
	CONSTRAINT "account_recovery_keys_lengths_valid" CHECK (octet_length("wrapping_salt") = 32 and octet_length("wrapping_nonce") = 24 and octet_length("encrypted_key") = 48 and octet_length("backup_nonce") = 24 and octet_length("encrypted_recovery_key") = 48 and octet_length("public_key") = 32)
);
--> statement-breakpoint
CREATE TABLE "personal_workspaces" (
	"user_id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE TABLE "storage_entitlements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"source" text NOT NULL,
	"source_reference" text NOT NULL UNIQUE,
	"quota_bytes" bigint NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_entitlements_valid" CHECK ("quota_bytes" > 0 and ("expires_at" is null or "expires_at" > "starts_at"))
);
--> statement-breakpoint
CREATE TABLE "workspace_storage" (
	"workspace_id" uuid PRIMARY KEY,
	"base_quota_bytes" bigint NOT NULL,
	"used_bytes" bigint DEFAULT 0 NOT NULL,
	"reserved_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_storage_nonnegative" CHECK ("base_quota_bytes" >= 0 and "used_bytes" >= 0 and "reserved_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "account_enrollments" ADD COLUMN "purpose" text DEFAULT 'register' NOT NULL;--> statement-breakpoint
CREATE INDEX "account_recovery_attempts_expiry_idx" ON "account_recovery_attempts" ("expires_at");--> statement-breakpoint
CREATE INDEX "account_recovery_attempts_user_idx" ON "account_recovery_attempts" ("user_id");--> statement-breakpoint
CREATE INDEX "storage_entitlements_workspace_idx" ON "storage_entitlements" ("workspace_id");--> statement-breakpoint
ALTER TABLE "account_recovery_attempts" ADD CONSTRAINT "account_recovery_attempts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_recovery_attempts" ADD CONSTRAINT "account_recovery_attempts_x8fqe9uaapVF_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "account_enrollments"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_recovery_keys" ADD CONSTRAINT "account_recovery_keys_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "personal_workspaces" ADD CONSTRAINT "personal_workspaces_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "personal_workspaces" ADD CONSTRAINT "personal_workspaces_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "storage_entitlements" ADD CONSTRAINT "storage_entitlements_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_storage" ADD CONSTRAINT "workspace_storage_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "account_enrollments" ADD CONSTRAINT "account_enrollments_purpose_valid" CHECK ("purpose" in ('register', 'recover'));
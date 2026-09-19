CREATE TABLE "account_enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"email" text NOT NULL,
	"normalized_email" text NOT NULL,
	"verification_token_hash" bytea UNIQUE,
	"enrollment_token_hash" bytea UNIQUE,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "account_enrollments_expiry_valid" CHECK ("expires_at" > "created_at"),
	CONSTRAINT "account_enrollments_state_valid" CHECK (("verified_at" is null and octet_length("verification_token_hash") = 32 and "verification_token_hash" is not null and "enrollment_token_hash" is null) or ("verified_at" is not null and "verification_token_hash" is null and octet_length("enrollment_token_hash") = 32 and "enrollment_token_hash" is not null))
);
--> statement-breakpoint
CREATE TABLE "account_keys" (
	"user_id" uuid PRIMARY KEY,
	"key_version" integer DEFAULT 1 NOT NULL,
	"credential_version" integer DEFAULT 1 NOT NULL,
	"envelope_version" smallint NOT NULL,
	"wrapping_salt" bytea NOT NULL,
	"wrapping_nonce" bytea NOT NULL,
	"encrypted_key" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_keys_versions_positive" CHECK ("key_version" > 0 and "credential_version" > 0),
	CONSTRAINT "account_keys_envelope_supported" CHECK ("envelope_version" = 1 and octet_length("wrapping_salt") = 32 and octet_length("wrapping_nonce") = 24 and octet_length("encrypted_key") = 48)
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"key_hash" bytea PRIMARY KEY,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_rate_limits_count_positive" CHECK ("count" > 0),
	CONSTRAINT "auth_rate_limits_key_length" CHECK (octet_length("key_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "opaque_credentials" (
	"user_id" uuid PRIMARY KEY,
	"registration_record" text NOT NULL,
	"profile_version" smallint NOT NULL,
	"server_setup_id" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "opaque_credentials_version_positive" CHECK ("version" > 0),
	CONSTRAINT "opaque_credentials_profile_supported" CHECK ("profile_version" = 1)
);
--> statement-breakpoint
CREATE TABLE "opaque_login_attempts" (
	"token_hash" bytea PRIMARY KEY,
	"user_id" uuid,
	"credential_version" integer,
	"profile_version" smallint NOT NULL,
	"server_state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "opaque_login_attempts_token_length" CHECK (octet_length("token_hash") = 32),
	CONSTRAINT "opaque_login_attempts_expiry_valid" CHECK ("expires_at" > "created_at"),
	CONSTRAINT "opaque_login_attempts_profile_supported" CHECK ("profile_version" = 1),
	CONSTRAINT "opaque_login_attempts_credential_binding" CHECK (("user_id" is null and "credential_version" is null) or ("user_id" is not null and "credential_version" is not null and "credential_version" > 0))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid NOT NULL,
	"token_hash" bytea NOT NULL UNIQUE,
	"credential_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_length" CHECK (octet_length("token_hash") = 32),
	CONSTRAINT "sessions_version_positive" CHECK ("credential_version" > 0),
	CONSTRAINT "sessions_expiry_valid" CHECK ("expires_at" > "created_at")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"name" text NOT NULL,
	"email" text NOT NULL,
	"normalized_email" text NOT NULL UNIQUE,
	"email_verified_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_name_length" CHECK (char_length("name") between 1 and 100)
);
--> statement-breakpoint
CREATE INDEX "account_enrollments_expiry_idx" ON "account_enrollments" ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_rate_limits_expiry_idx" ON "auth_rate_limits" ("expires_at");--> statement-breakpoint
CREATE INDEX "opaque_login_attempts_user_idx" ON "opaque_login_attempts" ("user_id");--> statement-breakpoint
CREATE INDEX "opaque_login_attempts_expiry_idx" ON "opaque_login_attempts" ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expiry_idx" ON "sessions" ("expires_at");--> statement-breakpoint
ALTER TABLE "account_keys" ADD CONSTRAINT "account_keys_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "opaque_credentials" ADD CONSTRAINT "opaque_credentials_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "opaque_login_attempts" ADD CONSTRAINT "opaque_login_attempts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
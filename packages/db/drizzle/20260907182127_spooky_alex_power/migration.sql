CREATE TABLE "account_identities" (
	"user_id" uuid PRIMARY KEY,
	"version" smallint DEFAULT 1 NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"wrapping_salt" bytea NOT NULL,
	"encryption_public_key" bytea NOT NULL,
	"encryption_private_key_nonce" bytea NOT NULL,
	"encrypted_encryption_private_key" bytea NOT NULL,
	"signing_public_key" bytea NOT NULL,
	"signing_seed_nonce" bytea NOT NULL,
	"encrypted_signing_seed" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_identities_versions_valid" CHECK ("version" = 1 and "key_version" = 1),
	CONSTRAINT "account_identities_lengths_valid" CHECK (octet_length("wrapping_salt") = 32 and octet_length("encryption_public_key") = 32 and octet_length("encryption_private_key_nonce") = 24 and octet_length("encrypted_encryption_private_key") = 48 and octet_length("signing_public_key") = 32 and octet_length("signing_seed_nonce") = 24 and octet_length("encrypted_signing_seed") = 48)
);
--> statement-breakpoint
ALTER TABLE "account_identities" ADD CONSTRAINT "account_identities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
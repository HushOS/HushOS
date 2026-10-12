CREATE TABLE "account_identity_history" (
	"user_id" uuid,
	"version" smallint NOT NULL,
	"key_version" integer,
	"wrapping_salt" bytea NOT NULL,
	"encryption_public_key" bytea NOT NULL,
	"encryption_private_key_nonce" bytea NOT NULL,
	"encrypted_encryption_private_key" bytea NOT NULL,
	"signing_public_key" bytea NOT NULL,
	"signing_seed_nonce" bytea NOT NULL,
	"encrypted_signing_seed" bytea NOT NULL,
	"kem_public_key" bytea,
	"kem_seed_nonce" bytea,
	"encrypted_kem_seed" bytea,
	"kem_signature" bytea,
	"created_at" timestamp with time zone NOT NULL,
	"replaced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"replaced_by_key_version" integer NOT NULL,
	"new_encryption_public_key" bytea NOT NULL,
	"new_signing_public_key" bytea NOT NULL,
	"new_kem_public_key" bytea NOT NULL,
	"succession_signature" bytea NOT NULL,
	CONSTRAINT "account_identity_history_pkey" PRIMARY KEY("user_id","key_version"),
	CONSTRAINT "account_identity_history_versions_valid" CHECK ("version" = 1 and "key_version" > 0 and "replaced_by_key_version" > "key_version"),
	CONSTRAINT "account_identity_history_kem_valid" CHECK (("kem_public_key" is null and "kem_seed_nonce" is null and "encrypted_kem_seed" is null and "kem_signature" is null) or (octet_length("kem_public_key") = 1184 and octet_length("kem_seed_nonce") = 24 and octet_length("encrypted_kem_seed") = 80 and octet_length("kem_signature") = 64)),
	CONSTRAINT "account_identity_history_lengths_valid" CHECK (octet_length("wrapping_salt") = 32 and octet_length("encryption_public_key") = 32 and octet_length("encryption_private_key_nonce") = 24 and octet_length("encrypted_encryption_private_key") = 48 and octet_length("signing_public_key") = 32 and octet_length("signing_seed_nonce") = 24 and octet_length("encrypted_signing_seed") = 48 and octet_length("new_encryption_public_key") = 32 and octet_length("new_signing_public_key") = 32 and octet_length("new_kem_public_key") = 1184 and octet_length("succession_signature") = 64)
);
--> statement-breakpoint
ALTER TABLE "account_identity_history" ADD CONSTRAINT "account_identity_history_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
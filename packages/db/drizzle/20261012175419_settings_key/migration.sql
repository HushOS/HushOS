CREATE TABLE "account_settings_keys" (
	"user_id" uuid PRIMARY KEY,
	"nonce" bytea NOT NULL,
	"ciphertext" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_settings_keys_lengths_valid" CHECK (octet_length("nonce") = 24 and octet_length("ciphertext") = 48)
);
--> statement-breakpoint
ALTER TABLE "account_settings_keys" ADD CONSTRAINT "account_settings_keys_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_settings" DROP CONSTRAINT "user_settings_valid", ADD CONSTRAINT "user_settings_valid" CHECK ("version" in (1, 2) and "settings_version" >= 1 and octet_length("nonce") = 24 and octet_length("ciphertext") between 16 and 65552);
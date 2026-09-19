CREATE TABLE "user_settings" (
	"user_id" uuid PRIMARY KEY,
	"version" smallint DEFAULT 1 NOT NULL,
	"settings_version" integer NOT NULL,
	"nonce" bytea NOT NULL,
	"ciphertext" bytea NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_settings_valid" CHECK ("version" = 1 and "settings_version" >= 1 and octet_length("nonce") = 24 and octet_length("ciphertext") between 16 and 65552)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "role" text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_role_valid" CHECK ("role" in ('member', 'admin'));
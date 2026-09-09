CREATE TABLE "workspace_keys" (
	"workspace_id" uuid,
	"user_id" uuid,
	"version" smallint DEFAULT 1 NOT NULL,
	"key_version" integer NOT NULL,
	"workspace_key_version" integer DEFAULT 1 NOT NULL,
	"wrapping_salt" bytea NOT NULL,
	"wrapping_nonce" bytea NOT NULL,
	"encrypted_key" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_keys_pkey" PRIMARY KEY("workspace_id","user_id"),
	CONSTRAINT "workspace_keys_versions_valid" CHECK ("version" = 1 and "key_version" > 0 and "workspace_key_version" > 0),
	CONSTRAINT "workspace_keys_lengths_valid" CHECK (octet_length("wrapping_salt") = 32 and octet_length("wrapping_nonce") = 24 and octet_length("encrypted_key") = 48)
);
--> statement-breakpoint
CREATE INDEX "workspace_keys_user_idx" ON "workspace_keys" ("user_id");--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD CONSTRAINT "workspace_keys_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_keys" ADD CONSTRAINT "workspace_keys_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
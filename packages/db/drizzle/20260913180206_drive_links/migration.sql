CREATE TABLE "drive_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"granter_user_id" uuid NOT NULL,
	"token_hash" bytea NOT NULL UNIQUE,
	"key_epoch" integer NOT NULL,
	"link_envelope" bytea NOT NULL,
	"link_salt" bytea NOT NULL,
	"has_password" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "drive_links_valid" CHECK ("key_epoch" >= 1 and octet_length("token_hash") = 32 and octet_length("link_envelope") = 72 and octet_length("link_salt") = 16 and "use_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "drive_links_node_idx" ON "drive_links" ("workspace_id","node_id");--> statement-breakpoint
ALTER TABLE "drive_links" ADD CONSTRAINT "drive_links_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_links" ADD CONSTRAINT "drive_links_node_id_drive_nodes_id_fkey" FOREIGN KEY ("node_id") REFERENCES "drive_nodes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_links" ADD CONSTRAINT "drive_links_granter_user_id_users_id_fkey" FOREIGN KEY ("granter_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
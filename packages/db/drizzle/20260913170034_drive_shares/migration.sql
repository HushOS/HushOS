CREATE TABLE "drive_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"granter_user_id" uuid NOT NULL,
	"grantee_user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"share_envelope" bytea NOT NULL,
	"prev_share_envelope" bytea,
	"prev_key_epoch" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "drive_shares_role_valid" CHECK ("role" in ('viewer', 'editor')),
	CONSTRAINT "drive_shares_not_self" CHECK ("granter_user_id" <> "grantee_user_id"),
	CONSTRAINT "drive_shares_envelopes_valid" CHECK ("key_epoch" >= 1 and octet_length("share_envelope") = 72 and ("prev_share_envelope" is null) = ("prev_key_epoch" is null) and ("prev_share_envelope" is null or octet_length("prev_share_envelope") = 72))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "drive_shares_live_grant" ON "drive_shares" ("node_id","grantee_user_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "drive_shares_grantee_idx" ON "drive_shares" ("grantee_user_id") WHERE revoked_at is null;--> statement-breakpoint
CREATE INDEX "drive_shares_node_idx" ON "drive_shares" ("workspace_id","node_id");--> statement-breakpoint
ALTER TABLE "drive_shares" ADD CONSTRAINT "drive_shares_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_shares" ADD CONSTRAINT "drive_shares_node_id_drive_nodes_id_fkey" FOREIGN KEY ("node_id") REFERENCES "drive_nodes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_shares" ADD CONSTRAINT "drive_shares_granter_user_id_users_id_fkey" FOREIGN KEY ("granter_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_shares" ADD CONSTRAINT "drive_shares_grantee_user_id_users_id_fkey" FOREIGN KEY ("grantee_user_id") REFERENCES "users"("id") ON DELETE CASCADE;
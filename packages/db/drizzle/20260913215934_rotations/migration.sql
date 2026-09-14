CREATE TABLE "drive_rotations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"target_epoch" integer NOT NULL,
	"started_by" uuid,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "drive_rotations_epoch_valid" CHECK ("target_epoch" >= 1)
);
--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD COLUMN "prev_key_epoch" integer;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_rotations_one_active" ON "drive_rotations" ("workspace_id") WHERE finished_at is null;--> statement-breakpoint
ALTER TABLE "drive_rotations" ADD CONSTRAINT "drive_rotations_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_rotations" ADD CONSTRAINT "drive_rotations_node_id_drive_nodes_id_fkey" FOREIGN KEY ("node_id") REFERENCES "drive_nodes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_links" DROP CONSTRAINT "drive_links_valid", ADD CONSTRAINT "drive_links_valid" CHECK ("key_epoch" >= 1 and octet_length("token_hash") = 32 and octet_length("link_envelope") = 72 and octet_length("link_salt") = 16 and ("secret_envelope" is null or octet_length("secret_envelope") in (104, 136)) and "use_count" >= 0);--> statement-breakpoint
ALTER TABLE "drive_nodes" DROP CONSTRAINT "drive_nodes_prev_envelope_valid", ADD CONSTRAINT "drive_nodes_prev_envelope_valid" CHECK (("prev_key_envelope" is null) = ("prev_parent_key_epoch" is null) and ("prev_key_envelope" is null) = ("prev_key_epoch" is null) and ("prev_key_envelope" is null or (octet_length("prev_key_envelope") = 72 and "prev_key_epoch" >= 1)));
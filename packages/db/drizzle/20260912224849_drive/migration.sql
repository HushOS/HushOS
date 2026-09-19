CREATE TABLE "drive_nodes" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"parent_id" uuid,
	"kind" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"parent_key_epoch" integer NOT NULL,
	"key_envelope" bytea,
	"prev_key_envelope" bytea,
	"prev_parent_key_epoch" integer,
	"metadata_version" integer DEFAULT 1 NOT NULL,
	"metadata_envelope" bytea,
	"current_version_id" uuid,
	"created_by" uuid,
	"trashed_at" timestamp with time zone,
	"height_bound" integer DEFAULT 0 NOT NULL,
	"change_seq" bigint,
	"purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_nodes_id_workspace" UNIQUE("id","workspace_id"),
	CONSTRAINT "drive_nodes_kind_valid" CHECK ("kind" in ('folder', 'file')),
	CONSTRAINT "drive_nodes_root_is_folder" CHECK ("parent_id" is not null or "kind" = 'folder'),
	CONSTRAINT "drive_nodes_versions_valid" CHECK ("key_epoch" >= 1 and "parent_key_epoch" >= 1 and "metadata_version" >= 1 and "height_bound" >= 0 and ("prev_parent_key_epoch" is null or "prev_parent_key_epoch" >= 1)),
	CONSTRAINT "drive_nodes_envelopes_valid" CHECK (("purged_at" is not null and "key_envelope" is null and "metadata_envelope" is null and "prev_key_envelope" is null) or ("purged_at" is null and octet_length("key_envelope") = 72 and octet_length("metadata_envelope") between 42 and 4136)),
	CONSTRAINT "drive_nodes_prev_envelope_valid" CHECK (("prev_key_envelope" is null) = ("prev_parent_key_epoch" is null) and ("prev_key_envelope" is null or octet_length("prev_key_envelope") = 72)),
	CONSTRAINT "drive_nodes_file_has_no_children_marker" CHECK ("kind" = 'folder' or "height_bound" = 0)
);
--> statement-breakpoint
CREATE TABLE "drive_object_deletions" (
	"object_id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"object_key" text NOT NULL,
	"published" boolean NOT NULL,
	"replicated" boolean DEFAULT false NOT NULL,
	"primary_deleted_at" timestamp with time zone,
	"delete_replica_after" timestamp with time zone,
	"done_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_objects" (
	"id" uuid PRIMARY KEY,
	"workspace_id" uuid NOT NULL,
	"object_key" text NOT NULL UNIQUE,
	"content_suite" smallint DEFAULT 1 NOT NULL,
	"chunk_size" integer NOT NULL,
	"chunk_count" integer NOT NULL,
	"content_nonce" bytea NOT NULL,
	"plaintext_size" bigint NOT NULL,
	"ciphertext_size" bigint NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_class" text DEFAULT 'standard' NOT NULL,
	"replicated_at" timestamp with time zone,
	"last_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	CONSTRAINT "drive_objects_kind_valid" CHECK ("kind" in ('content', 'thumbnail')),
	CONSTRAINT "drive_objects_status_valid" CHECK ("status" in ('pending', 'ready', 'missing')),
	CONSTRAINT "drive_objects_class_valid" CHECK ("storage_class" in ('standard', 'cold')),
	CONSTRAINT "drive_objects_framing_valid" CHECK ("content_suite" = 1 and "chunk_size" > 0 and "chunk_count" >= 1 and octet_length("content_nonce") = 16 and "plaintext_size" >= 0 and "ciphertext_size" = "plaintext_size" + 16 * "chunk_count")
);
--> statement-breakpoint
CREATE TABLE "drive_uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"workspace_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"object_id" uuid,
	"object_key" text NOT NULL,
	"purpose" text NOT NULL,
	"key_epoch" integer NOT NULL,
	"expected_version_id" uuid,
	"new_node" boolean DEFAULT false NOT NULL,
	"multipart_id" text NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"completing_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_uploads_purpose_valid" CHECK ("purpose" in ('content', 'thumbnail')),
	CONSTRAINT "drive_uploads_status_valid" CHECK ("status" in ('open', 'completing', 'conflicted', 'completed', 'aborted')),
	CONSTRAINT "drive_uploads_values_valid" CHECK ("key_epoch" >= 1 and "reserved_bytes" >= 0 and ("status" <> 'completing' or "completing_at" is not null) and ("status" in ('aborted', 'completed') or "object_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "file_versions" (
	"id" uuid PRIMARY KEY,
	"node_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"object_id" uuid,
	"thumbnail_object_id" uuid,
	"content_key_envelope" bytea,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	CONSTRAINT "file_versions_status_valid" CHECK ("status" in ('pending', 'ready', 'purged')),
	CONSTRAINT "file_versions_envelope_valid" CHECK (("status" = 'purged' and "content_key_envelope" is null and "purged_at" is not null) or ("status" <> 'purged' and octet_length("content_key_envelope") = 72 and "object_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "change_seq" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "key_epoch_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_nodes_one_root" ON "drive_nodes" ("workspace_id") WHERE parent_id is null;--> statement-breakpoint
CREATE INDEX "drive_nodes_parent_idx" ON "drive_nodes" ("parent_id") WHERE trashed_at is null;--> statement-breakpoint
CREATE INDEX "drive_nodes_change_idx" ON "drive_nodes" ("workspace_id","change_seq") WHERE change_seq is not null;--> statement-breakpoint
CREATE INDEX "drive_nodes_trash_idx" ON "drive_nodes" ("workspace_id","trashed_at") WHERE trashed_at is not null;--> statement-breakpoint
CREATE INDEX "drive_nodes_purged_idx" ON "drive_nodes" ("workspace_id","purged_at") WHERE purged_at is not null;--> statement-breakpoint
CREATE INDEX "drive_object_deletions_pending_idx" ON "drive_object_deletions" ("created_at") WHERE done_at is null;--> statement-breakpoint
CREATE INDEX "drive_objects_workspace_idx" ON "drive_objects" ("workspace_id");--> statement-breakpoint
CREATE INDEX "drive_uploads_expiry_idx" ON "drive_uploads" ("expires_at") WHERE status in ('open', 'completing', 'conflicted');--> statement-breakpoint
CREATE INDEX "drive_uploads_node_idx" ON "drive_uploads" ("node_id");--> statement-breakpoint
CREATE INDEX "file_versions_object_idx" ON "file_versions" ("object_id");--> statement-breakpoint
CREATE INDEX "file_versions_node_idx" ON "file_versions" ("node_id");--> statement-breakpoint
CREATE INDEX "file_versions_superseded_idx" ON "file_versions" ("workspace_id","superseded_at") WHERE superseded_at is not null and purged_at is null;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_current_version_id_file_versions_id_fkey" FOREIGN KEY ("current_version_id") REFERENCES "file_versions"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "drive_nodes" ADD CONSTRAINT "drive_nodes_parent_fk" FOREIGN KEY ("parent_id","workspace_id") REFERENCES "drive_nodes"("id","workspace_id");--> statement-breakpoint
ALTER TABLE "drive_objects" ADD CONSTRAINT "drive_objects_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_node_id_drive_nodes_id_fkey" FOREIGN KEY ("node_id") REFERENCES "drive_nodes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_version_id_file_versions_id_fkey" FOREIGN KEY ("version_id") REFERENCES "file_versions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "drive_uploads" ADD CONSTRAINT "drive_uploads_object_id_drive_objects_id_fkey" FOREIGN KEY ("object_id") REFERENCES "drive_objects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_node_id_drive_nodes_id_fkey" FOREIGN KEY ("node_id") REFERENCES "drive_nodes"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_object_id_drive_objects_id_fkey" FOREIGN KEY ("object_id") REFERENCES "drive_objects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "file_versions" ADD CONSTRAINT "file_versions_thumbnail_object_id_drive_objects_id_fkey" FOREIGN KEY ("thumbnail_object_id") REFERENCES "drive_objects"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_counters_valid" CHECK ("change_seq" >= 0 and "key_epoch_seq" >= 0);
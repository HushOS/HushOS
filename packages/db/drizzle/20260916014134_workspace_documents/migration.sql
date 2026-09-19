CREATE TABLE "workspace_documents" (
	"workspace_id" uuid,
	"kind" text,
	"version" integer NOT NULL,
	"envelope" bytea NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_documents_pkey" PRIMARY KEY("workspace_id","kind"),
	CONSTRAINT "workspace_documents_kind_valid" CHECK ("kind" ~ '^[a-z][a-z0-9-]{0,31}$'),
	CONSTRAINT "workspace_documents_version_valid" CHECK ("version" >= 1),
	CONSTRAINT "workspace_documents_envelope_valid" CHECK (octet_length("envelope") between 42 and 65576)
);
--> statement-breakpoint
ALTER TABLE "workspace_documents" ADD CONSTRAINT "workspace_documents_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;
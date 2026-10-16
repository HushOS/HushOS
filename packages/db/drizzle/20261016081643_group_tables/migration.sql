-- Hand-edited (this header only). The group tables are new and empty; the index and foreign key on
-- "workspaces" lock it, every Drive write's table, until drizzle's single transaction commits. The
-- foreign keys from the new tables to "users" take SHARE ROW EXCLUSIVE on "users" until commit too,
-- which blocks sign-ups and every change to an account row meanwhile (reads go on). Each waits at
-- most five seconds for its lock and fails, to be retried, rather than queue requests behind it.
-- Statements are stored as opaque bytes (docs/groups-server.md 1): a change to the group statement
-- formats before 1c ships needs no change here, unless a column the server projects changes.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "group_chain_caches" (
	"group_id" uuid PRIMARY KEY,
	"chain_revision" bigint NOT NULL,
	"cache" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_chain_caches_revision_valid" CHECK ("chain_revision" >= 1)
);
--> statement-breakpoint
CREATE TABLE "group_departures" (
	"group_id" uuid,
	"user_id" uuid,
	"held_members" boolean NOT NULL,
	"departed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_departures_pkey" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "group_holds" (
	"group_id" uuid,
	"user_id" uuid,
	"held_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "group_holds_pkey" PRIMARY KEY("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "group_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"group_id" uuid NOT NULL,
	"email" text,
	"normalized_email" text,
	"token_hash" bytea NOT NULL UNIQUE,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"invited_by" uuid,
	"state" text DEFAULT 'open' NOT NULL,
	"accepted_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_invitations_state_valid" CHECK ("state" in ('open', 'accepted', 'revoked', 'expired') and ("accepted_by" is null or "state" = 'accepted')),
	CONSTRAINT "group_invitations_roles_valid" CHECK ("roles" <@ array['billing', 'data_admin', 'guardian', 'members', 'recovery']::text[]),
	CONSTRAINT "group_invitations_valid" CHECK (octet_length("token_hash") = 32 and "expires_at" > "created_at" and ("email" is null) = ("normalized_email" is null) and ("email" is null or char_length("email") between 3 and 320) and ("state" <> 'open' or "email" is not null))
);
--> statement-breakpoint
CREATE TABLE "group_key_seals" (
	"group_id" uuid,
	"group_key_version" integer,
	"holder_user_id" uuid,
	"holder_key_version" integer NOT NULL,
	"sealer_user_id" uuid NOT NULL,
	"roster_version" integer NOT NULL,
	"roster_digest" bytea NOT NULL,
	"envelope" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_key_seals_pkey" PRIMARY KEY("group_id","group_key_version","holder_user_id"),
	CONSTRAINT "group_key_seals_valid" CHECK ("group_key_version" >= 1 and "holder_key_version" >= 1 and "roster_version" >= 1 and octet_length("roster_digest") = 32 and octet_length("envelope") = 4597)
);
--> statement-breakpoint
CREATE TABLE "group_key_successions" (
	"group_id" uuid,
	"old_version" integer,
	"new_version" integer NOT NULL,
	"last_roster_version" integer NOT NULL,
	"last_roster_digest" bytea NOT NULL,
	"new_ed25519_public_key" bytea NOT NULL,
	"new_ml_dsa_public_key" bytea NOT NULL,
	"signer_user_id" uuid NOT NULL,
	"signer_ml_dsa_public_key" bytea NOT NULL,
	"digest" bytea NOT NULL,
	"statement" bytea NOT NULL,
	"ed25519_signature" bytea NOT NULL,
	"ml_dsa_signature" bytea NOT NULL,
	"signer_signature" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_key_successions_pkey" PRIMARY KEY("group_id","old_version"),
	CONSTRAINT "group_key_successions_digest" UNIQUE("group_id","digest"),
	CONSTRAINT "group_key_successions_versions_valid" CHECK ("old_version" >= 1 and "new_version" = "old_version" + 1 and "last_roster_version" >= 1),
	CONSTRAINT "group_key_successions_lengths_valid" CHECK (octet_length("last_roster_digest") = 32 and octet_length("digest") = 32 and octet_length("new_ed25519_public_key") = 32 and octet_length("new_ml_dsa_public_key") = 1952 and octet_length("signer_ml_dsa_public_key") = 1952 and octet_length("statement") between 1 and 16384 and octet_length("ed25519_signature") = 64 and octet_length("ml_dsa_signature") = 3309 and octet_length("signer_signature") = 3373)
);
--> statement-breakpoint
CREATE TABLE "group_memberships" (
	"group_id" uuid,
	"user_id" uuid,
	"state" text NOT NULL,
	"roles" text[] DEFAULT '{}'::text[] NOT NULL,
	"invitation_id" uuid,
	"admitted_by" uuid,
	"accepted_at" timestamp with time zone,
	"admitted_at" timestamp with time zone,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_memberships_pkey" PRIMARY KEY("group_id","user_id"),
	CONSTRAINT "group_memberships_state_valid" CHECK ("state" in ('accepted', 'active', 'left', 'removed')),
	CONSTRAINT "group_memberships_roles_valid" CHECK ("roles" <@ array['billing', 'data_admin', 'guardian', 'members', 'recovery']::text[]),
	CONSTRAINT "group_memberships_timeline_valid" CHECK (("state" <> 'active' or "admitted_at" is not null) and (("state" in ('left', 'removed')) = ("left_at" is not null)))
);
--> statement-breakpoint
CREATE TABLE "group_rosters" (
	"group_id" uuid,
	"version" integer,
	"digest" bytea NOT NULL,
	"previous_digest" bytea,
	"group_key_version" integer NOT NULL,
	"signer_user_id" uuid NOT NULL,
	"signer_ml_dsa_public_key" bytea NOT NULL,
	"statement" bytea NOT NULL,
	"ed25519_signature" bytea NOT NULL,
	"ml_dsa_signature" bytea NOT NULL,
	"signer_signature" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_rosters_pkey" PRIMARY KEY("group_id","version"),
	CONSTRAINT "group_rosters_digest" UNIQUE("group_id","digest"),
	CONSTRAINT "group_rosters_version_digest" UNIQUE("group_id","version","digest"),
	CONSTRAINT "group_rosters_chain_valid" CHECK ("version" >= 1 and "group_key_version" >= 1 and octet_length("digest") = 32 and ("version" = 1) = ("previous_digest" is null) and ("previous_digest" is null or octet_length("previous_digest") = 32)),
	CONSTRAINT "group_rosters_statement_valid" CHECK (octet_length("statement") between 1 and 4194304 and octet_length("signer_ml_dsa_public_key") = 1952 and octet_length("ed25519_signature") = 64 and octet_length("ml_dsa_signature") = 3309 and octet_length("signer_signature") = 3373)
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY,
	"id_seed" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"creator_user_id" uuid NOT NULL,
	"first_ed25519_public_key" bytea NOT NULL,
	"first_ml_dsa_public_key" bytea NOT NULL,
	"roster_version" integer NOT NULL,
	"roster_digest" bytea NOT NULL,
	"group_key_version" integer NOT NULL,
	"chain_revision" bigint DEFAULT 1 NOT NULL,
	"succession_due" boolean DEFAULT false NOT NULL,
	"seat_limit" integer,
	"dissolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "groups_kind_valid" CHECK ("kind" in ('family', 'org')),
	CONSTRAINT "groups_name_length" CHECK (char_length("name") between 1 and 100),
	CONSTRAINT "groups_id_seed_valid" CHECK ("id_seed" ~ '^[A-Za-z0-9_-]{22}$'),
	CONSTRAINT "groups_first_keys_valid" CHECK (octet_length("first_ed25519_public_key") = 32 and octet_length("first_ml_dsa_public_key") = 1952),
	CONSTRAINT "groups_head_valid" CHECK ("roster_version" >= 1 and octet_length("roster_digest") = 32 and "group_key_version" >= 1 and "chain_revision" >= 1 and ("seat_limit" is null or "seat_limit" >= 1))
);
--> statement-breakpoint
CREATE TABLE "area_grants" (
	"workspace_id" uuid,
	"workspace_key_version" integer,
	"grantee_user_id" uuid,
	"group_id" uuid NOT NULL,
	"grantee_key_version" integer,
	"granter_user_id" uuid NOT NULL,
	"roster_version" integer NOT NULL,
	"roster_digest" bytea NOT NULL,
	"envelope" bytea NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "area_grants_pkey" PRIMARY KEY("workspace_id","workspace_key_version","grantee_user_id","grantee_key_version"),
	CONSTRAINT "area_grants_valid" CHECK ("workspace_key_version" >= 1 and "grantee_key_version" >= 1 and "roster_version" >= 1 and octet_length("roster_digest") = 32 and octet_length("envelope") = 4565)
);
--> statement-breakpoint
CREATE INDEX "workspaces_group_idx" ON "workspaces" ("group_id") WHERE "group_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "group_invitations_open_idx" ON "group_invitations" ("group_id","normalized_email") WHERE "state" = 'open';--> statement-breakpoint
CREATE INDEX "group_invitations_expiry_idx" ON "group_invitations" ("expires_at");--> statement-breakpoint
CREATE INDEX "group_invitations_invited_by_idx" ON "group_invitations" ("invited_by") WHERE "invited_by" is not null;--> statement-breakpoint
CREATE INDEX "group_invitations_accepted_by_idx" ON "group_invitations" ("accepted_by") WHERE "accepted_by" is not null;--> statement-breakpoint
CREATE INDEX "group_key_seals_holder_idx" ON "group_key_seals" ("holder_user_id");--> statement-breakpoint
CREATE INDEX "group_memberships_user_idx" ON "group_memberships" ("user_id");--> statement-breakpoint
CREATE INDEX "group_memberships_admitted_by_idx" ON "group_memberships" ("admitted_by") WHERE "admitted_by" is not null;--> statement-breakpoint
CREATE INDEX "group_memberships_invitation_idx" ON "group_memberships" ("invitation_id") WHERE "invitation_id" is not null;--> statement-breakpoint
CREATE INDEX "area_grants_grantee_idx" ON "area_grants" ("grantee_user_id");--> statement-breakpoint
CREATE INDEX "area_grants_group_idx" ON "area_grants" ("group_id","grantee_user_id");--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE "group_chain_caches" ADD CONSTRAINT "group_chain_caches_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_departures" ADD CONSTRAINT "group_departures_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_holds" ADD CONSTRAINT "group_holds_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_holds" ADD CONSTRAINT "group_holds_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_holds" ADD CONSTRAINT "group_holds_held_by_users_id_fkey" FOREIGN KEY ("held_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "group_invitations" ADD CONSTRAINT "group_invitations_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_invitations" ADD CONSTRAINT "group_invitations_invited_by_users_id_fkey" FOREIGN KEY ("invited_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "group_invitations" ADD CONSTRAINT "group_invitations_accepted_by_users_id_fkey" FOREIGN KEY ("accepted_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "group_key_seals" ADD CONSTRAINT "group_key_seals_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_key_seals" ADD CONSTRAINT "group_key_seals_holder_user_id_users_id_fkey" FOREIGN KEY ("holder_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_key_seals" ADD CONSTRAINT "group_key_seals_roster_fk" FOREIGN KEY ("group_id","roster_version","roster_digest") REFERENCES "group_rosters"("group_id","version","digest");--> statement-breakpoint
ALTER TABLE "group_key_successions" ADD CONSTRAINT "group_key_successions_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_key_successions" ADD CONSTRAINT "group_key_successions_roster_fk" FOREIGN KEY ("group_id","last_roster_version","last_roster_digest") REFERENCES "group_rosters"("group_id","version","digest");--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_invitation_id_group_invitations_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "group_invitations"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "group_memberships" ADD CONSTRAINT "group_memberships_admitted_by_users_id_fkey" FOREIGN KEY ("admitted_by") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "group_rosters" ADD CONSTRAINT "group_rosters_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "area_grants" ADD CONSTRAINT "area_grants_grantee_user_id_users_id_fkey" FOREIGN KEY ("grantee_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "area_grants" ADD CONSTRAINT "area_grants_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "area_grants" ADD CONSTRAINT "area_grants_workspace_fk" FOREIGN KEY ("workspace_id","group_id") REFERENCES "workspaces"("id","group_id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "area_grants" ADD CONSTRAINT "area_grants_roster_fk" FOREIGN KEY ("group_id","roster_version","roster_digest") REFERENCES "group_rosters"("group_id","version","digest");
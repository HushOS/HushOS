-- Which web processes read two-step rows, and under which keys (docs/two-step-design.md 8): one
-- small row per web process, written at its readiness checks. The worker reads them before it
-- re-seals authenticator secrets after a key rotation. A new, empty table: nothing waits on it.
-- Hand-edited: this comment.
CREATE TABLE "two_step_key_readers" (
	"instance_id" uuid PRIMARY KEY,
	"sealing_key_id" text NOT NULL,
	"readable_key_ids" text[] NOT NULL,
	"sealing_since" timestamp with time zone NOT NULL,
	"seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "two_step_key_readers_sealing_valid" CHECK ("sealing_key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "two_step_key_readers_readable_valid" CHECK (cardinality("readable_key_ids") between 1 and 8 and "sealing_key_id" = any("readable_key_ids")),
	CONSTRAINT "two_step_key_readers_times_valid" CHECK ("sealing_since" <= "seen_at")
);
--> statement-breakpoint
CREATE INDEX "two_step_key_readers_seen_idx" ON "two_step_key_readers" ("seen_at");
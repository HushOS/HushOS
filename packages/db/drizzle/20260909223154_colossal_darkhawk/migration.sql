ALTER TABLE "workspaces" RENAME COLUMN "createdAt" TO "created_at";--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "last_seen_at" SET DEFAULT now();--> statement-breakpoint
UPDATE "sessions" SET "last_seen_at" = "created_at" WHERE "last_seen_at" IS NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "last_seen_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "account_enrollments_email_idx" ON "account_enrollments" ("normalized_email");
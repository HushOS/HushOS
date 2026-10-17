-- Hand-edited (this header and the lock timeout). Group billing (milestone 1e,
-- docs/groups-design.md 3.5): three new, empty tables, so nothing is rewritten or scanned. Their
-- foreign keys take SHARE ROW EXCLUSIVE on "groups" and "users" until drizzle's single
-- transaction commits, which pauses writes to those two tables (sign-ins included) for
-- milliseconds. Each waits at most five seconds for its lock and fails, to be retried, rather
-- than queue requests behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "group_billing_customers" (
	"group_id" uuid PRIMARY KEY,
	"provider" text NOT NULL,
	"provider_customer_id" text NOT NULL UNIQUE,
	"payer_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_billing_subscriptions" (
	"id" text PRIMARY KEY,
	"group_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"product_id" text NOT NULL,
	"product_name" text NOT NULL,
	"status" text NOT NULL,
	"recurring_interval" text NOT NULL,
	"amount" bigint,
	"currency" text,
	"units" integer NOT NULL,
	"paid_units" integer DEFAULT 0 NOT NULL,
	"pending_units" integer,
	"intended_units" integer,
	"included_members" integer NOT NULL,
	"quota_bytes" bigint NOT NULL,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_billing_subscriptions_counts_valid" CHECK ("units" >= 0 and "paid_units" >= 0 and ("pending_units" is null or "pending_units" >= 0) and ("intended_units" is null or "intended_units" >= 1) and "included_members" >= 1 and "quota_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "group_storage" (
	"group_id" uuid PRIMARY KEY,
	"quota_bytes" bigint DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_storage_quota_valid" CHECK ("quota_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX "group_billing_customers_payer_idx" ON "group_billing_customers" ("payer_user_id") WHERE "payer_user_id" is not null;--> statement-breakpoint
CREATE INDEX "group_billing_subscriptions_group_idx" ON "group_billing_subscriptions" ("group_id");--> statement-breakpoint
ALTER TABLE "group_billing_customers" ADD CONSTRAINT "group_billing_customers_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_billing_customers" ADD CONSTRAINT "group_billing_customers_payer_user_id_users_id_fkey" FOREIGN KEY ("payer_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "group_billing_subscriptions" ADD CONSTRAINT "group_billing_subscriptions_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "group_storage" ADD CONSTRAINT "group_storage_group_id_groups_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE;
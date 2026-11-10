-- Hand-edited (this header, the lock timeout and the UPDATE). Commission safety for affiliates
-- (docs/company-billing-design.md 8.4 and 8.5; its PR 2), used only with AFFILIATE_V2_ENABLED.
-- Two new tables, "affiliate_disputes" and "affiliate_ledger_state", which lock nothing that
-- exists. On "affiliate_earnings": "part" (NOT NULL, constant default 'main') with a unique
-- ("order_id", "part") beside the unique "order_id", which stays because the release before this
-- one names it in its ON CONFLICT; "net_amount" and "commission_amount" widened from integer to
-- bigint, which rewrites the table and its indexes; and the columns a refund, a dispute, a hold,
-- a clawback, a flag and a void are recorded in, each nullable or with a constant default, so a
-- container of the previous release, which names none of them when it inserts, still writes a
-- row. Every earning already there is given its pot (its commission as recorded), its payable
-- date (when it was recorded: an earning from before the switch is not held) and, where it was
-- paid, what was paid. "affiliates" gains "paused_at" and "removed_at", both nullable.
-- The ALTERs take an ACCESS EXCLUSIVE lock on "affiliate_earnings" and on "affiliates", held
-- until drizzle's single transaction commits; the rewrite, the unique index and the two checks
-- read every earning under it. Both tables are small (an earning a paid order that came through
-- an affiliate; an affiliate a creator), so that is milliseconds. Each statement waits at most
-- five seconds for a lock and fails, to be retried, rather than queue requests behind it.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
CREATE TABLE "affiliate_disputes" (
	"id" text PRIMARY KEY,
	"order_id" text NOT NULL,
	"status" text NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliate_ledger_state" (
	"id" boolean PRIMARY KEY DEFAULT true,
	"cutover_at" timestamp with time zone NOT NULL,
	"reach_back_done_at" timestamp with time zone,
	"disputes_seen_through" timestamp with time zone,
	"disputes_read_at" timestamp with time zone,
	"disputes_failure" text,
	"disputes_failed_at" timestamp with time zone,
	"refunds_read_at" timestamp with time zone,
	CONSTRAINT "affiliate_ledger_state_one" CHECK ("id")
);
--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "part" text DEFAULT 'main' NOT NULL;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "pot_amount" bigint;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "payable_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "paid_amount" bigint;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "refunded_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "refunds_read_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "refunds_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "dispute_id" text;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "dispute_status" text;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "disputed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "flag" text;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "flag_released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "flag_released_by" uuid;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "clawback_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "clawback_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "clawback_settled_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "clawback_written_off_amount" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "clawback_settled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "clawback_settled_by" uuid;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "clawback_note" text;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "clawback_origin" text;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "clawback_confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "clawback_confirmed_by" uuid;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "voided_by" uuid;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD COLUMN "void_reason" text;--> statement-breakpoint
ALTER TABLE "affiliates" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliates" ADD COLUMN "removed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ALTER COLUMN "net_amount" SET DATA TYPE bigint USING "net_amount"::bigint;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ALTER COLUMN "commission_amount" SET DATA TYPE bigint USING "commission_amount"::bigint;--> statement-breakpoint
UPDATE "affiliate_earnings" SET "pot_amount" = "commission_amount", "payable_at" = "created_at", "paid_amount" = CASE WHEN "paid_at" IS NOT NULL THEN "commission_amount" END;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD CONSTRAINT "affiliate_earnings_order_part_key" UNIQUE("order_id","part");--> statement-breakpoint
CREATE INDEX "affiliate_disputes_order_idx" ON "affiliate_disputes" ("order_id");--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD CONSTRAINT "affiliate_earnings_part" CHECK ("part" in ('main', 'sub'));--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD CONSTRAINT "affiliate_earnings_amounts" CHECK ("commission_amount" >= 0 and "refunded_amount" >= 0 and "clawback_amount" >= 0 and "clawback_settled_amount" >= 0 and "clawback_written_off_amount" >= 0 and ("pot_amount" is null or "pot_amount" >= 0) and ("paid_amount" is null or "paid_amount" >= 0));

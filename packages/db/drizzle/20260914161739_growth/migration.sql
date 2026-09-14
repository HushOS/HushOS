CREATE TABLE "affiliate_earnings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"affiliate_id" uuid NOT NULL,
	"order_id" text NOT NULL UNIQUE,
	"user_id" uuid,
	"currency" text NOT NULL,
	"net_amount" integer NOT NULL,
	"commission_amount" integer NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "affiliates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"user_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL UNIQUE,
	"code" text NOT NULL UNIQUE,
	"percent_off" integer NOT NULL,
	"duration" text NOT NULL,
	"duration_months" integer,
	"commission_bps" integer NOT NULL,
	"provider_discount_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "affiliates_valid" CHECK ("percent_off" between 1 and 100 and "commission_bps" between 0 and 10000 and ("duration" <> 'repeating' or "duration_months" between 1 and 36))
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"user_id" uuid PRIMARY KEY,
	"code" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_rewards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"referral_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"side" text NOT NULL,
	"quota_bytes" bigint NOT NULL,
	"entitlement_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referrals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	"referred_user_id" uuid NOT NULL UNIQUE,
	"kind" text NOT NULL,
	"referrer_user_id" uuid,
	"affiliate_id" uuid,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_kind" CHECK (("kind" = 'user' and "referrer_user_id" is not null and "affiliate_id" is null) or ("kind" = 'affiliate' and "affiliate_id" is not null and "referrer_user_id" is null))
);
--> statement-breakpoint
CREATE INDEX "affiliate_earnings_affiliate_idx" ON "affiliate_earnings" ("affiliate_id");--> statement-breakpoint
CREATE INDEX "referral_rewards_user_idx" ON "referral_rewards" ("user_id");--> statement-breakpoint
CREATE INDEX "referral_rewards_referral_idx" ON "referral_rewards" ("referral_id");--> statement-breakpoint
CREATE INDEX "referrals_referrer_idx" ON "referrals" ("referrer_user_id");--> statement-breakpoint
CREATE INDEX "referrals_affiliate_idx" ON "referrals" ("affiliate_id");--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD CONSTRAINT "affiliate_earnings_affiliate_id_affiliates_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "affiliate_earnings" ADD CONSTRAINT "affiliate_earnings_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_referral_id_referrals_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "referrals"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "referral_rewards" ADD CONSTRAINT "referral_rewards_entitlement_id_storage_entitlements_id_fkey" FOREIGN KEY ("entitlement_id") REFERENCES "storage_entitlements"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_user_id_users_id_fkey" FOREIGN KEY ("referred_user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_user_id_users_id_fkey" FOREIGN KEY ("referrer_user_id") REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_affiliate_id_affiliates_id_fkey" FOREIGN KEY ("affiliate_id") REFERENCES "affiliates"("id") ON DELETE SET NULL;
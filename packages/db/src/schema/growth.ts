import { sql } from 'drizzle-orm';
import {
    bigint,
    boolean,
    check,
    index,
    integer,
    pgTable,
    text,
    timestamp,
    unique,
    uuid,
} from 'drizzle-orm/pg-core';
import { users } from './auth';
import { storageEntitlements } from './storage';

/*
 * Two ways a person arrives through someone else, sharing one attribution:
 *
 * Referrals: every account has a code. Someone who signs up through it gives
 * both people extra storage, up to a cap per referrer. Paid in storage,
 * never money, and granted as an ordinary storage entitlement.
 *
 * Affiliates: creators the operators enrol by hand. Each has a slug for a
 * landing page, a coupon code that is also a discount at the payment
 * provider, and a commission on what the people they bring in pay. Earnings
 * are recorded per paid order; paying them out happens outside the system,
 * and an operator marks them paid.
 */

export const referralCodes = pgTable('referral_codes', {
    userId: uuid('user_id')
        .primaryKey()
        .references(() => users.id, { onDelete: 'cascade' }),
    // Lower-case, unambiguous letters and digits; what the invite link carries.
    code: text().notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const affiliates = pgTable(
    'affiliates',
    {
        id: uuid().defaultRandom().primaryKey(),
        // The creator's own account, when they have one: it shows their earnings in Drive.
        userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
        // An email the operator gave with no account behind it yet, normalised: the account
        // registered with it is linked at sign-up, and this is cleared. Null once linked.
        pendingEmail: text('pending_email'),
        name: text().notNull(),
        // The landing page: /go/<slug>. Lower-case letters, digits and dashes.
        slug: text().notNull().unique(),
        // The coupon, upper-case, also registered as a discount code at the provider.
        code: text().notNull().unique(),
        percentOff: integer('percent_off').notNull(),
        // How long the discount lasts on a subscription, as the provider defines it.
        duration: text().notNull().$type<'once' | 'forever' | 'repeating'>(),
        durationMonths: integer('duration_months'),
        // Commission on the net amount of every paid order the affiliate brought in.
        commissionBps: integer('commission_bps').notNull(),
        // The provider's discount, applied to checkouts started with this code.
        providerDiscountId: text('provider_discount_id'),
        active: boolean().notNull().default(true),
        /*
         * With AFFILIATE_V2_ENABLED. When they were paused, beside `active`, cleared on resume:
         * a customer attributed before it goes on earning, anything later ties and earns
         * nothing. A boolean could not say which side of the pause a customer was on.
         */
        pausedAt: timestamp('paused_at', { withTimezone: true }),
        /* Removed: the page and the code are gone and nothing earns; the row and its ledger stay. */
        removedAt: timestamp('removed_at', { withTimezone: true }),
        notes: text(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        check(
            'affiliates_valid',
            sql`${table.percentOff} between 1 and 100 and ${table.commissionBps} between 0 and 10000 and (${table.duration} <> 'repeating' or ${table.durationMonths} between 1 and 36)`,
        ),
    ],
);

// Who a person arrived through. One row per referred account, written once at sign-up.
export const referrals = pgTable(
    'referrals',
    {
        id: uuid().defaultRandom().primaryKey(),
        referredUserId: uuid('referred_user_id')
            .notNull()
            .unique()
            .references(() => users.id, { onDelete: 'cascade' }),
        kind: text().notNull().$type<'user' | 'affiliate'>(),
        referrerUserId: uuid('referrer_user_id').references(() => users.id, {
            onDelete: 'set null',
        }),
        affiliateId: uuid('affiliate_id').references(() => affiliates.id, { onDelete: 'set null' }),
        code: text().notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('referrals_referrer_idx').on(table.referrerUserId),
        index('referrals_affiliate_idx').on(table.affiliateId),
        check(
            'referrals_kind',
            sql`(${table.kind} = 'user' and ${table.referrerUserId} is not null and ${table.affiliateId} is null) or (${table.kind} = 'affiliate' and ${table.affiliateId} is not null and ${table.referrerUserId} is null)`,
        ),
    ],
);

// Storage granted for a referral, to either side; the entitlement is what the allowance reads.
export const referralRewards = pgTable(
    'referral_rewards',
    {
        id: uuid().defaultRandom().primaryKey(),
        referralId: uuid('referral_id')
            .notNull()
            .references(() => referrals.id, { onDelete: 'cascade' }),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        side: text().notNull().$type<'referrer' | 'referred' | 'referrer-paid'>(),
        quotaBytes: bigint('quota_bytes', { mode: 'bigint' }).notNull(),
        entitlementId: uuid('entitlement_id').references(() => storageEntitlements.id, {
            onDelete: 'set null',
        }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('referral_rewards_user_idx').on(table.userId),
        index('referral_rewards_referral_idx').on(table.referralId),
    ],
);

/*
 * Commission for one paid order. The order id keeps a replayed webhook from paying twice.
 *
 * With AFFILIATE_V2_ENABLED (docs/company-billing-design.md 8.4) a row also carries what lowers
 * it and what was done about it. Amounts are minor units, `bigint`. Every column added for that
 * is nullable or has a default, so a container of the release before it still inserts a row:
 *
 * - `pot_amount`: the commission as first recorded, which nothing later changes. Null on a row
 *   written without the switch: its `commission_amount` is still the pot, since only the one
 *   writer of what is left (growth.ts) lowers it, and that writer stores the pot as it does.
 * - `commission_amount`: what is left of the pot after refunds and a lost dispute.
 * - `paid_amount`: what was paid out. Null on a row paid without the switch, whose
 *   `commission_amount` is then what was paid.
 * - `payable_at`: when it may be paid. Null: not held.
 */
export const affiliateEarnings = pgTable(
    'affiliate_earnings',
    {
        id: uuid().defaultRandom().primaryKey(),
        affiliateId: uuid('affiliate_id')
            .notNull()
            .references(() => affiliates.id, { onDelete: 'cascade' }),
        orderId: text('order_id').notNull().unique(),
        // One row an order until sub-affiliates split it in two (`main` and `sub`).
        part: text().notNull().default('main').$type<'main' | 'sub'>(),
        userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
        currency: text().notNull(),
        // Minor units, as the provider reports them.
        netAmount: bigint('net_amount', { mode: 'bigint' }).notNull(),
        commissionAmount: bigint('commission_amount', { mode: 'bigint' }).notNull(),
        potAmount: bigint('pot_amount', { mode: 'bigint' }),
        payableAt: timestamp('payable_at', { withTimezone: true }),
        paidAt: timestamp('paid_at', { withTimezone: true }),
        paidAmount: bigint('paid_amount', { mode: 'bigint' }),
        /*
         * Its order was refunded after this commission was paid out: for an operator to settle
         * with the affiliate. Set once, so it is logged once.
         */
        orderRefundedAt: timestamp('order_refunded_at', { withTimezone: true }),
        // The order's succeeded refunds at Polar, capped at its net, as last read.
        refundedAmount: bigint('refunded_amount', { mode: 'bigint' }).notNull().default(0n),
        refundsReadAt: timestamp('refunds_read_at', { withTimezone: true }),
        refundsChangedAt: timestamp('refunds_changed_at', { withTimezone: true }),
        // The order's dispute that governs it (affiliate_disputes), as last read.
        disputeId: text('dispute_id'),
        disputeStatus: text('dispute_status'),
        disputedAt: timestamp('disputed_at', { withTimezone: true }),
        /*
         * Why an operator must look before it is paid: `self`, the affiliate's own account is the
         * order's customer; `member`, their account is in the company that paid (not written
         * yet). Released by an operator, or the earning is voided. A dispute still open keeps an
         * earning from being paid too, and is read from `dispute_status`, so it clears itself.
         */
        flag: text().$type<'self' | 'member'>(),
        flagReleasedAt: timestamp('flag_released_at', { withTimezone: true }),
        flagReleasedBy: uuid('flag_released_by'),
        /*
         * Money paid out that should not have been: `paid_amount` less what is left. Taken back
         * by amount: `clawback_settled_amount` netted from later payouts or repaid, and
         * `clawback_written_off_amount` given up by an operator, with a note. Settled when
         * nothing of it is open. One the cut-over made (`clawback_origin`) is counted in no net
         * until an operator confirms it.
         */
        clawbackAmount: bigint('clawback_amount', { mode: 'bigint' }).notNull().default(0n),
        clawbackAt: timestamp('clawback_at', { withTimezone: true }),
        clawbackSettledAmount: bigint('clawback_settled_amount', { mode: 'bigint' })
            .notNull()
            .default(0n),
        clawbackWrittenOffAmount: bigint('clawback_written_off_amount', { mode: 'bigint' })
            .notNull()
            .default(0n),
        clawbackSettledAt: timestamp('clawback_settled_at', { withTimezone: true }),
        clawbackSettledBy: uuid('clawback_settled_by'),
        clawbackNote: text('clawback_note'),
        clawbackOrigin: text('clawback_origin').$type<'cutover'>(),
        clawbackConfirmedAt: timestamp('clawback_confirmed_at', { withTimezone: true }),
        clawbackConfirmedBy: uuid('clawback_confirmed_by'),
        // Voided by an operator: owed to nobody, and it no longer blocks removing the affiliate.
        voidedAt: timestamp('voided_at', { withTimezone: true }),
        voidedBy: uuid('voided_by'),
        voidReason: text('void_reason'),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('affiliate_earnings_affiliate_idx').on(table.affiliateId),
        /*
         * Beside the unique `order_id` above, which the release before this one names in its
         * `ON CONFLICT`. New code names this one; the PR that writes a second row an order
         * drops the other.
         */
        unique('affiliate_earnings_order_part_key').on(table.orderId, table.part),
        check('affiliate_earnings_part', sql`${table.part} in ('main', 'sub')`),
        check(
            'affiliate_earnings_amounts',
            sql`${table.commissionAmount} >= 0 and ${table.refundedAmount} >= 0 and ${table.clawbackAmount} >= 0 and ${table.clawbackSettledAmount} >= 0 and ${table.clawbackWrittenOffAmount} >= 0 and (${table.potAmount} is null or ${table.potAmount} >= 0) and (${table.paidAmount} is null or ${table.paidAmount} >= 0)`,
        ),
    ],
);

/*
 * Orders HushOS refunds whole (withdrawEarning), kept so their commission is never recorded
 * after it was taken back: a late `order.paid` delivery's recordEarning checks it under the same
 * per-order lock. Ids only: no amount, account or affiliate.
 */
export const affiliateWithdrawnOrders = pgTable('affiliate_withdrawn_orders', {
    orderId: text('order_id').primaryKey(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/*
 * Every dispute read from Polar's list, kept by order whether or not the order has an earning
 * yet: an earning can be recorded after its order's dispute was first seen, and whoever records
 * it reads this under the order's lock. Polar sends no delivery for a dispute, so the daily read
 * is the only way one is learned of.
 */
export const affiliateDisputes = pgTable(
    'affiliate_disputes',
    {
        // Polar's id.
        id: text().primaryKey(),
        orderId: text('order_id').notNull(),
        // Polar's: prevented, early_warning, needs_response, under_review, lost, won.
        status: text().notNull(),
        openedAt: timestamp('opened_at', { withTimezone: true }).notNull(),
        lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [index('affiliate_disputes_order_idx').on(table.orderId)],
);

/*
 * One row, written when AFFILIATE_V2_ENABLED first runs (the cut-over): when that was, whether
 * its reach back to refunds and disputes from before it is done, and how far the daily read of
 * Polar's disputes has got and whether it could be read at all.
 */
export const affiliateLedgerState = pgTable(
    'affiliate_ledger_state',
    {
        id: boolean().primaryKey().default(true),
        cutoverAt: timestamp('cutover_at', { withTimezone: true }).notNull(),
        reachBackDoneAt: timestamp('reach_back_done_at', { withTimezone: true }),
        // The newest dispute's `created_at` of the last read that went all the way down.
        disputesSeenThrough: timestamp('disputes_seen_through', { withTimezone: true }),
        disputesReadAt: timestamp('disputes_read_at', { withTimezone: true }),
        // `scope`: the token lacks disputes:read. `failed`: anything else.
        disputesFailure: text('disputes_failure').$type<'scope' | 'failed'>(),
        disputesFailedAt: timestamp('disputes_failed_at', { withTimezone: true }),
    },
    (table) => [check('affiliate_ledger_state_one', sql`${table.id}`)],
);

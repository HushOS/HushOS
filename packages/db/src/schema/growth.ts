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

// Commission owed for one paid order. The order id keeps a replayed webhook from paying twice.
export const affiliateEarnings = pgTable(
    'affiliate_earnings',
    {
        id: uuid().defaultRandom().primaryKey(),
        affiliateId: uuid('affiliate_id')
            .notNull()
            .references(() => affiliates.id, { onDelete: 'cascade' }),
        orderId: text('order_id').notNull().unique(),
        userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
        currency: text().notNull(),
        // Minor units, as the provider reports them.
        netAmount: integer('net_amount').notNull(),
        commissionAmount: integer('commission_amount').notNull(),
        paidAt: timestamp('paid_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [index('affiliate_earnings_affiliate_idx').on(table.affiliateId)],
);

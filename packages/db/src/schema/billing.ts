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
import { groups } from './groups';
import { workspaces } from './workspaces';

// The provider's customer for a user. Polar finds it by external id (the user id);
// the provider id is kept for deletion and support.
export const billingCustomers = pgTable('billing_customers', {
    userId: uuid('user_id')
        .primaryKey()
        .references(() => users.id, { onDelete: 'cascade' }),
    provider: text().notNull(),
    providerCustomerId: text('provider_customer_id').notNull().unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// A read model of provider subscriptions for the billing page. Enforcement stays
// with storage_entitlements, keyed by the same subscription id.
export const billingSubscriptions = pgTable(
    'billing_subscriptions',
    {
        id: text().primaryKey(),
        userId: uuid('user_id')
            .notNull()
            .references(() => users.id, { onDelete: 'cascade' }),
        workspaceId: uuid('workspace_id')
            .notNull()
            .references(() => workspaces.id, { onDelete: 'cascade' }),
        provider: text().notNull(),
        productId: text('product_id').notNull(),
        productName: text('product_name').notNull(),
        status: text().notNull(),
        recurringInterval: text('recurring_interval').notNull(),
        // Minor units and lowercase ISO code, as the provider charges them; null for
        // rows written before currencies were recorded.
        amount: bigint('amount', { mode: 'number' }),
        currency: text(),
        quotaBytes: bigint('quota_bytes', { mode: 'bigint' }).notNull(),
        currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
        cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
        endedAt: timestamp('ended_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [index('billing_subscriptions_user_idx').on(table.userId)],
);

// Every delivery is recorded by its provider message id, so a retry of a delivery
// that was already applied is acknowledged without being applied again.
export const billingWebhookEvents = pgTable('billing_webhook_events', {
    id: text().primaryKey(),
    provider: text().notNull(),
    type: text().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
});

// The plan or referral a person signed up with, kept until a checkout consumes it.
// Lives on the account, so it survives a verification link opened on another device.
export const accountIntents = pgTable('account_intents', {
    userId: uuid('user_id')
        .primaryKey()
        .references(() => users.id, { onDelete: 'cascade' }),
    planProductId: text('plan_product_id'),
    referralCode: text('referral_code'),
    source: text(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
});

/*
 * A group's customer at the provider (docs/polar-group-billing-spike.md 3): a
 * Polar team customer with external id `group:<groupId>`, whose owner member
 * is the paying person (external id: their user id). `payer_user_id` is who
 * HushOS lets raise, cut and open the portal; it moves only with a completed
 * handover, which is not built yet.
 */
export const groupBillingCustomers = pgTable(
    'group_billing_customers',
    {
        groupId: uuid('group_id')
            .primaryKey()
            .references(() => groups.id, { onDelete: 'cascade' }),
        provider: text().notNull(),
        providerCustomerId: text('provider_customer_id').notNull().unique(),
        payerUserId: uuid('payer_user_id').references(() => users.id, { onDelete: 'set null' }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    // Account deletion asks what a person pays for, and the foreign key's set-null needs it too.
    (table) => [
        index('group_billing_customers_payer_idx')
            .on(table.payerUserId)
            .where(sql`${table.payerUserId} is not null`),
    ],
);

/*
 * A read model of a group's provider subscriptions, rewritten from the
 * provider's state on every webhook and reconcile. `units` is the member
 * capacity bought; `pending_units` a cut scheduled for the period's end. The
 * live row's figures are projected onto `groups.seat_limit` and
 * `group_storage` in the same transaction.
 */
export const groupBillingSubscriptions = pgTable(
    'group_billing_subscriptions',
    {
        id: text().primaryKey(),
        groupId: uuid('group_id')
            .notNull()
            .references(() => groups.id, { onDelete: 'cascade' }),
        provider: text().notNull(),
        productId: text('product_id').notNull(),
        productName: text('product_name').notNull(),
        status: text().notNull(),
        recurringInterval: text('recurring_interval').notNull(),
        amount: bigint('amount', { mode: 'number' }),
        currency: text(),
        units: integer().notNull(),
        /*
         * The places HushOS counts as paid for: Polar's `units` when no order of the
         * subscription is waiting for payment, else the last count that was paid.
         * A raise awaiting the bank's confirmation opens nothing until its order is
         * paid. Seats follow the lowest of this, `units` and a scheduled cut.
         */
        paidUnits: integer('paid_units').notNull().default(0),
        pendingUnits: integer('pending_units'),
        /*
         * The next-period count HushOS last asked for (a cut), kept until the
         * period it applies to begins, so a cut Polar lost (a raise deletes it) is
         * re-issued by the retry job and the daily reconcile.
         */
        intendedUnits: integer('intended_units'),
        /*
         * The cut above is the stale-raise rule's (a raise unconfirmed for
         * STALE_RAISE_DAYS), not the payer's: it is withdrawn if the raise is paid.
         */
        intendedStale: boolean('intended_stale').notNull().default(false),
        /*
         * A smaller tier the plan moves to at the period's end (`pending_update.product_id`),
         * and the one HushOS last asked for: kept like `intended_units`, because a raise
         * deletes the whole pending update at Polar and the move must be asked for again.
         */
        pendingProductId: text('pending_product_id'),
        intendedProductId: text('intended_product_id'),
        /* The move above is the stale rule's (an upgrade unpaid past STALE_RAISE_DAYS), not the payer's. */
        intendedProductStale: boolean('intended_product_stale').notNull().default(false),
        /*
         * The tier and pool paid for, as `paid_units` is for places: the product's once no
         * order of the subscription waits for payment, else the last paid (never above the
         * product's pool). An upgrade awaiting the bank gives nothing until its order is
         * paid; the pool Drive reads is this. Null on rows from before it: the product's.
         */
        paidProductId: text('paid_product_id'),
        paidQuotaBytes: bigint('paid_quota_bytes', { mode: 'bigint' }),
        /*
         * When HushOS last asked Polar again for a cut or a tier move. A reconcile skips the
         * re-issue for a while after, so the webhook a re-issue causes never causes another.
         */
        reissuedAt: timestamp('reissued_at', { withTimezone: true }),
        /* What that re-issue asked for: only the same request is held back, never a new one. */
        reissuedState: text('reissued_state'),
        includedMembers: integer('included_members').notNull(),
        quotaBytes: bigint('quota_bytes', { mode: 'bigint' }).notNull(),
        currentPeriodStart: timestamp('current_period_start', { withTimezone: true }).notNull(),
        currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }).notNull(),
        cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
        endedAt: timestamp('ended_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('group_billing_subscriptions_group_idx').on(table.groupId),
        check(
            'group_billing_subscriptions_counts_valid',
            sql`${table.units} >= 0 and ${table.paidUnits} >= 0 and (${table.pendingUnits} is null or ${table.pendingUnits} >= 0) and (${table.intendedUnits} is null or ${table.intendedUnits} >= 1) and ${table.includedMembers} >= 1 and ${table.quotaBytes} >= 0`,
        ),
    ],
);

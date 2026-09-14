import { bigint, boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
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

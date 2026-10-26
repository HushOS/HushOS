import { sql } from 'drizzle-orm';
import {
    bigint,
    boolean,
    check,
    foreignKey,
    index,
    integer,
    pgTable,
    text,
    timestamp,
    uuid,
} from 'drizzle-orm/pg-core';
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
    /*
     * When the newest reconcile written here began reading Polar, by the database's clock
     * (readingStamp): one that began earlier and commits later writes nothing.
     */
    reconciledFrom: timestamp('reconciled_from', { withTimezone: true }),
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
 *
 * No foreign key to the group, here or on its subscriptions: billing records are
 * kept for accounting after a dissolved family's records are purged
 * (purgeDissolvedFamilies), by the group's id only, as personal_plan_endings is.
 */
export const groupBillingCustomers = pgTable(
    'group_billing_customers',
    {
        groupId: uuid('group_id').primaryKey(),
        provider: text().notNull(),
        providerCustomerId: text('provider_customer_id').notNull().unique(),
        payerUserId: uuid('payer_user_id').references(() => users.id, { onDelete: 'set null' }),
        /*
         * Since when HushOS has owed Polar's own list of this family's plans (a read that failed:
         * a plan the mirror never held may be charging). Retried by the daily reconcile until it
         * succeeds, listed for operators meanwhile, and the family isn't purged while it is set.
         */
        plansUnlistedSince: timestamp('plans_unlisted_since', { withTimezone: true }),
        /*
         * When the newest reconcile written here began reading Polar, by the database's clock
         * (readingStamp): one that began earlier and commits later writes nothing.
         */
        reconciledFrom: timestamp('reconciled_from', { withTimezone: true }),
        /*
         * When the newest change written here (one plan as a raise, cut or revoke answered it)
         * was answered: a reconcile that began earlier writes nothing and reads Polar again.
         */
        changedFrom: timestamp('changed_from', { withTimezone: true }),
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
        groupId: uuid('group_id').notNull(),
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
         * The tier paid for: the product of the subscription's newest paid, unrefunded order
         * (a checkout, a renewal or a change), re-derived from Polar on every reconcile, and
         * that product's pool. Null and 0 while nothing is paid. Drive's pool is the lesser of
         * this and the product's, so an unpaid upgrade gives nothing and a smaller tier at a
         * renewal counts at once.
         */
        paidProductId: text('paid_product_id'),
        paidQuotaBytes: bigint('paid_quota_bytes', { mode: 'bigint' }),
        /*
         * Since when the product has been bigger than the tier paid for (an upgrade unpaid):
         * the oldest unpaid change order for it, or when HushOS first saw the difference.
         * Past STALE_RAISE_DAYS the plan is moved back at the period's end; null once they match.
         */
        tierMismatchSince: timestamp('tier_mismatch_since', { withTimezone: true }),
        /*
         * When HushOS last asked Polar again for a cut or a tier move. A reconcile skips the
         * re-issue for a while after, so the webhook a re-issue causes never causes another.
         */
        reissuedAt: timestamp('reissued_at', { withTimezone: true }),
        /* What that re-issue asked for: only the same request is held back, never a new one. */
        reissuedState: text('reissued_state'),
        /*
         * How many times in a row Polar answered that same request with 200 and didn't keep it;
         * failures (5xx, timeouts) don't count. HushOS stops at a few.
         */
        reissueAttempts: integer('reissue_attempts').notNull().default(0),
        /* Until when a queued retry is pending, so a family has one at a time. */
        reissueRetryAt: timestamp('reissue_retry_at', { withTimezone: true }),
        /*
         * When HushOS gave up asking Polar again (MAX_REISSUES answers of 200 that Polar didn't
         * keep): shown to operators on the management page until Polar holds the change.
         */
        reissueGaveUpAt: timestamp('reissue_gave_up_at', { withTimezone: true }),
        /*
         * Why: `not-kept` (Polar answered 200 and kept nothing, MAX_REISSUES times) or
         * `revert-unavailable` (an unpaid upgrade past STALE_RAISE_DAYS whose paid tier is no
         * longer offered, so there is nothing to move it back to).
         */
        reissueStuckReason: text('reissue_stuck_reason'),
        /*
         * A place purchase or an upgrade under way, until when: the two never run at once for
         * a family, so a raise's order can't be taken for an unconfirmed upgrade's.
         */
        changeClaimUntil: timestamp('change_claim_until', { withTimezone: true }),
        /*
         * How many times HushOS set this plan to end at its period's end because its family
         * was dissolved (a payer may take that back in Polar's portal, every time), and when
         * it last asked Polar to (written before the call, so an answer lost to a timeout
         * still counts). Its payer is emailed once per period: the period end last mailed.
         */
        dissolveCancels: integer('dissolve_cancels').notNull().default(0),
        dissolveCancelledAt: timestamp('dissolve_cancelled_at', { withTimezone: true }),
        dissolveMailedPeriodEnd: timestamp('dissolve_mailed_period_end', { withTimezone: true }),
        /*
         * Polar refused to set it to end (403 `InactiveSubscription`): when, Polar's error name,
         * and the plan's state then (dissolveStateOf). Listed for operators while the plan is
         * not set to end; not tried again until the state differs.
         */
        dissolveRefusedAt: timestamp('dissolve_refused_at', { withTimezone: true }),
        /*
         * When setting it to end first failed in a way pg-boss retries (a token error, a
         * 409, a 5xx, Polar unreachable), since the last time it was set to end, seen ending
         * by a reconcile, or refused. A failure Polar keeps repeating would otherwise be retried for ever and
         * never listed: past a day the plan is listed for operators (`dissolved-failing`).
         */
        dissolveFailingSince: timestamp('dissolve_failing_since', { withTimezone: true }),
        dissolveRefusal: text('dissolve_refusal'),
        dissolveRefusedState: text('dissolve_refused_state'),
        /*
         * HushOS set out to revoke this plan because it lapsed (unpaid, incomplete, paused) and
         * gives nothing (a checkout, a payer leaving, removed or deleting their account) and
         * couldn't: why (`paid-period`, `locked`, `refused`, `unavailable`) and when last. Listed
         * for operators while the plan hasn't ended, since what it blocks (a deletion, a leave, a
         * new plan) waits on it; cleared once a revoke lands.
         */
        lapsedRevokeRefusal: text('lapsed_revoke_refusal'),
        lapsedRevokeRefusedAt: timestamp('lapsed_revoke_refused_at', { withTimezone: true }),
        /*
         * Its product is one the catalogue can't read (archived, edited): recorded as Polar has
         * it, so a plan that can charge is never lost, but never the family's plan, its places or
         * pool, nor its payer's, since its tier can't be read. Cleared once its product reads.
         */
        productUnread: boolean('product_unread').notNull().default(false),
        /*
         * The end of the last period in which this was the family's plan while `active` or
         * `trialing` (applyGroupState sets it when it picks the family's plan): what a payment on
         * it bought. Null for a plan that never served the family (an incomplete checkout, one
         * made beside the family's plan, one a deleted family's Polar customer was billed for),
         * which bought nothing. A past-due or unpaid period never moves it, nor anything after the
         * family is deleted: the cutoff a deleted family's plan, or a second plan, is refunded
         * from (unwantedPlanCutoff).
         */
        servedUntil: timestamp('served_until', { withTimezone: true }),
        /*
         * Orders HushOS refused to credit: a raise Polar billed on another product than the one
         * it was asked on. They never count as paying for a tier.
         */
        uncreditedOrderIds: text('uncredited_order_ids').array(),
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

/*
 * A personal plan HushOS ends because its owner's files joined a family's pool
 * (docs/families-shared-pool.md 5.1): one row per personal subscription, which is
 * ended once. `pooled_at` is when HushOS first saw its owner pooled with it live;
 * `revoked_at` the moment Polar ended it, stored the first time a revoke succeeds
 * (or read from Polar's `ended_at` when it was already ended), with the period it
 * was in, so every retry prorates from the same instant. No foreign keys: a refund
 * still owed outlives the account and the family, by ids only.
 */
export const personalPlanEndings = pgTable(
    'personal_plan_endings',
    {
        subscriptionId: text('subscription_id').primaryKey(),
        /*
         * Whose plan it is, and whom the plan-ending job runs for: a person's user id, or, for a
         * family's own plan ended because it lapsed (a family checkout, leave, removal, deletion
         * or dissolve revoking it), the family's id. Which it is: whether the subscription has a
         * row in group_billing_subscriptions (billingRepository.familyPlanOf).
         */
        userId: uuid('user_id').notNull(),
        /*
         * The membership that pooled them: the family and when they were let in. Null for a
         * lapsed plan (unpaid, incomplete, paused) HushOS revoked itself, a person's or a
         * family's own: nothing is refunded then unless Polar takes a payment for it
         * afterwards, which is refunded whole (`admitted_at` and `pooled_at` are then when
         * HushOS set out to revoke it, `revoked_at` when Polar says it ended). It never holds
         * the id of the family whose own plan this is; `user_id` does.
         */
        groupId: uuid('group_id'),
        admittedAt: timestamp('admitted_at', { withTimezone: true }).notNull(),
        pooledAt: timestamp('pooled_at', { withTimezone: true }).notNull(),
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
        /*
         * A deleted family's plan that Polar billed again (endOrphanedFamilyPlan): every order of it
         * paid at or after this is refunded whole. That plan's own first recorded end, or the epoch
         * for a plan the mirror never held (HushOS gave nothing for it). Written once, with the
         * ending, and never recomputed; null on every other ending.
         */
        paidAfter: timestamp('paid_after', { withTimezone: true }),
        periodStart: timestamp('period_start', { withTimezone: true }),
        periodEnd: timestamp('period_end', { withTimezone: true }),
        /*
         * Null while work remains; `settled` once every order of the period is refunded
         * (or owed nothing), `dropped` when its owner left the family before it was
         * revoked, `ended` when Polar had ended it before they were pooled.
         */
        outcome: text(),
        /*
         * What of the period's unused part Polar won't refund on its orders (beyond what it
         * takes back on each), as the last run computed it: shown to operators, who decide.
         */
        unrefundableAmount: bigint('unrefundable_amount', { mode: 'number' }),
        unrefundableCurrency: text('unrefundable_currency'),
        /*
         * The run working this ending and until when (the database's clock): taken with a
         * conditional update, renewed between steps and checked right before every refund
         * is asked for, so a run that lost it (stalled past it while pg-boss retried) asks
         * Polar for nothing more.
         */
        leaseOwner: text('lease_owner'),
        leaseUntil: timestamp('lease_until', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('personal_plan_endings_user_idx').on(table.userId),
        index('personal_plan_endings_open_idx')
            .on(table.userId)
            .where(sql`${table.outcome} is null`),
        check(
            'personal_plan_endings_outcome_valid',
            sql`${table.outcome} is null or ${table.outcome} in ('settled', 'dropped', 'ended')`,
        ),
    ],
);

/*
 * One refund per order of the ended plan's period, keyed by HushOS's own
 * `refund_key` (also the refund's `hushos_refund` metadata at Polar, which
 * documents no idempotency key): written with its amount before Polar is asked,
 * so the operators' list can name it, and matched against the order's refunds
 * at Polar before every call. `failures` counts failed tries in a row; at five
 * the refund is listed under Refunds owed (`owed_since`) until it lands, and is
 * tried again at most once a day.
 */
export const personalPlanRefunds = pgTable(
    'personal_plan_refunds',
    {
        orderId: text('order_id').primaryKey(),
        subscriptionId: text('subscription_id').notNull(),
        refundKey: text('refund_key').notNull().unique(),
        /*
         * What HushOS means to have refunded on the order in all, minor units, before tax
         * (Polar adds the matching tax itself): recomputed from the order's refunds at every
         * run, so a refund that fails later is owed again.
         */
        amount: bigint('amount', { mode: 'number' }).notNull(),
        currency: text().notNull(),
        /*
         * `requested` (written, Polar not yet known to hold it), `pending` and
         * `succeeded` (Polar's refund, matched by key), `failed` (Polar's refund
         * failed or the call was refused; tried again), `none` (nothing to refund),
         * `disputed` (the charge is disputed: its share is dropped, never moved).
         */
        status: text().notNull(),
        providerRefundId: text('provider_refund_id'),
        /*
         * When HushOS first asked Polar for it: a live refund without the key that appears
         * on the order from then on (one Polar recorded without the metadata after a call
         * that errored, or an operator's) counts as this refund.
         */
        firstAttemptedAt: timestamp('first_attempted_at', { withTimezone: true }),
        /* When it last asked: an owed refund is asked again at most daily. */
        lastAttemptedAt: timestamp('last_attempted_at', { withTimezone: true }),
        /*
         * After an ask that timed out or got a 5xx, Polar may still make the refund late, and
         * it has no idempotency key: nothing is asked again before this (the database's clock),
         * though the order's refunds are listed first every time.
         */
        unsureUntil: timestamp('unsure_until', { withTimezone: true }),
        failures: integer().notNull().default(0),
        /*
         * A payment on a lapsed plan whose revoke never landed, kept by its owner: its
         * commission and referral reward, held back by the delivery, are still to be granted
         * (grantKeptRewards). Apart from `status`, which a later ending's refund may change.
         */
        rewardsPending: boolean('rewards_pending').notNull().default(false),
        owedSince: timestamp('owed_since', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    },
    (table) => [
        index('personal_plan_refunds_subscription_idx').on(table.subscriptionId),
        foreignKey({
            name: 'personal_plan_refunds_subscription_fk',
            columns: [table.subscriptionId],
            foreignColumns: [personalPlanEndings.subscriptionId],
        }).onDelete('cascade'),
        check(
            'personal_plan_refunds_valid',
            sql`${table.status} in ('requested', 'pending', 'succeeded', 'failed', 'none', 'disputed') and ${table.amount} >= 0 and ${table.failures} >= 0`,
        ),
    ],
);

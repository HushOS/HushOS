import { createHash } from 'node:crypto';
import { authRepository, billingRepository, growthRepository } from '@hushos/db';
import { appEnv } from '@hushos/env/app';
import { billingEnv } from '@hushos/env/billing';
import { groupsEnv } from '@hushos/env/groups';
import { log } from '@hushos/logging';
import { webhooks, type Polar, type models } from '@polar-sh/sdk/2026-10';
import { PolarClientError } from '@polar-sh/sdk';
import type { BillingSummary, Catalogue, DiscountTerms } from './api';
import {
    LapsedRevokeError,
    notePaidAfterRevoke,
    noteRefundUpdated,
    queuePlanEnding,
    revokeLapsed,
} from './endings';
import {
    LapsedFamilyPlanError,
    endLapsedPlansPaidBy,
    groupIdOf,
    lapsedPlanStaysRefusal,
    reconcileGroup,
} from './groups';
import {
    BillingError,
    PROVIDER,
    billingEnabled,
    getCatalogue,
    getFamilyCatalogue,
    offeredFamilies,
    polar,
    polarErrorName,
    statusOf,
    unavailable,
    type BillingUser,
    type CatalogueProduct,
    type FamilyCatalogueProduct,
} from './provider';
import { GROUP_CUSTOMER_PREFIX, lapsedPlan, livePlan, type CancellationReason } from './protocol';

export {
    BillingError,
    billingEnabled,
    parseMinorUnits,
    readFamilyProduct,
    type BillingErrorCode,
    type BillingUser,
} from './provider';
export {
    endPersonalPlans,
    PLAN_ENDING_LEASE_MS,
    PlanEndingBusyError,
    queuePlanEnding,
    reconcilePlanEndings,
    recheckSettledEndings,
    REFUND_FAILURES_BEFORE_OWED,
    setEndPersonalPlanQueue,
    type EndPersonalPlanJob,
} from './endings';
export {
    cancelDissolvedPlan,
    changeGroupPlan,
    createGroupPortalSession,
    DissolveCancelBusyError,
    endLapsedFamilyPlans,
    endLapsedPlansForDeparture,
    endLapsedPlansPaidBy,
    ensureGroupSeat,
    LapsedFamilyPlanError,
    lapsedPlansPaidBy,
    lapsedPlanStaysRefusal,
    familyHasPlan,
    getGroupBilling,
    isFamilyPayer,
    MAX_REISSUES,
    paysForGroup,
    relistUnlistedFamilies,
    queueDissolvedCancel,
    quoteUnitsChange,
    reconcileGroup,
    reissueCut,
    seatError,
    setCutRetryQueue,
    setDissolveCancelQueue,
    setGroupUnits,
    spaceOf,
    startGroupCheckout,
    syncGroup,
    type PlanChange,
    type SeatResult,
} from './groups';
export { quoteTierChange } from './protocol';

const WEBHOOK_MAX_BYTES = 256 * 1024;
/* Polar's statuses after which a subscription has ended (with or without `ended_at`). */
const ENDED_STATUSES = new Set<string>(billingRepository.ENDED_SUBSCRIPTION_STATUSES);
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function listCatalogue(): Promise<Catalogue> {
    const freeQuotaBytes = appEnv.INITIAL_STORAGE_QUOTA_BYTES.toString();
    if (!billingEnabled()) return { enabled: false, freeQuotaBytes, plans: [], families: [] };
    // Both read the one cached product list; families only where the server serves them.
    const [products, families] = await Promise.all([
        getCatalogue(),
        groupsEnv.GROUPS_ENABLED ? getFamilyCatalogue() : [],
    ]);
    return {
        enabled: true,
        freeQuotaBytes,
        plans: products
            .filter((product) => !product.archived)
            .map(({ archived: _archived, ...plan }) => plan),
        families: offeredFamilies(families).map(
            ({ archived: _archived, createdAt: _createdAt, ...family }) => family,
        ),
    };
}

export async function getSummary(user: BillingUser): Promise<BillingSummary> {
    if (!billingEnabled())
        return {
            enabled: false,
            hasCustomer: false,
            subscription: null,
            intendedPlan: null,
            intendedFamily: null,
            family: null,
        };
    const [summary, intent, plans, families, pooled] = await Promise.all([
        billingRepository.getBillingSummary(user.id),
        billingRepository.getPendingIntent(user.id),
        listCatalogue().then((catalogue) => catalogue.plans),
        // Read from the one cached product list even where families aren't served (below).
        getFamilyCatalogue(),
        billingRepository.getPooledFamily(user.id),
    ]);
    const live = livePlan(summary.subscription);
    // A pooled person is offered no personal plan, so none is carried to checkout either; nor
    // is one to someone whose plan lapsed, since a checkout ends that plan first and the
    // billing page asks before it does.
    const intendedPlan =
        !pooled &&
        !live &&
        !lapsedPlan(summary.subscription) &&
        intent?.planProductId &&
        plans.some((plan) => plan.id === intent.planProductId)
            ? intent.planProductId
            : null;
    // A family tier picked on the pricing page: the app opens Create a family with it, or, where
    // families aren't served (any more), Plans. Whether they're in a family is the app's to check.
    const familyPlan = intent?.planProductId
        ? intendedFamilyOf(intent.planProductId, families)
        : null;
    const priced = families.find((plan) => plan.id === familyPlan)?.prices;
    const intendedFamily = familyPlan
        ? {
              plan: familyPlan,
              currency:
                  intent?.currency && priced && Object.hasOwn(priced, intent.currency)
                      ? intent.currency
                      : null,
          }
        : null;
    const family = pooled
        ? {
              name: pooled.name,
              planName:
                  (await billingRepository.getLiveGroupSubscription(pooled.groupId))?.productName ??
                  null,
          }
        : null;
    return { enabled: true, ...summary, intendedPlan, intendedFamily, family };
}

/*
 * The family plan a signup's intent names, as the app should open it: the tier itself while it
 * is on sale; the one on sale now of the same tier and billing period when an operator has
 * replaced it since; otherwise (archived, the single plan from before the tiers) the id as it
 * is, which the app finds in no offer and sends to Plans. Null for anything but a family plan.
 */
function intendedFamilyOf(productId: string, families: FamilyCatalogueProduct[]) {
    const offered = offeredFamilies(families);
    if (offered.some((plan) => plan.id === productId)) return productId;
    const chosen = families.find((plan) => plan.id === productId);
    if (!chosen) return null;
    const successor = chosen.tier
        ? offered.find((plan) => plan.tier === chosen.tier && plan.interval === chosen.interval)
        : undefined;
    return successor?.id ?? productId;
}

/*
 * The family tier chosen at signup has been opened (the app's first landing after signup), so
 * it isn't offered again on the next visit. A personal plan is left for its checkout, which
 * consumes it; a code that came with either stays for the next checkout.
 */
export async function forgetIntendedFamily(user: BillingUser) {
    if (!billingEnabled()) return;
    const [intent, families] = await Promise.all([
        billingRepository.getPendingIntent(user.id),
        getFamilyCatalogue(),
    ]);
    const plan = intent?.planProductId;
    // Only a family plan: a personal one is left for its checkout.
    if (!plan || !families.some((family) => family.id === plan)) return;
    await billingRepository.dropIntendedPlan(user.id, plan);
}

/*
 * While a person's own files draw from a family's pool, no personal plan can be
 * bought or resumed (docs/families-shared-pool.md 3.3): their storage is the
 * family's, and billing ends any personal plan they have (5.1).
 */
async function refuseWhilePooled(user: BillingUser) {
    const family = await billingRepository.getPooledFamily(user.id);
    if (family)
        throw new BillingError(
            `Your storage comes from ${family.name}’s plan. Leave the family to choose a plan of your own.`,
            409,
            { code: 'in-family' },
        );
}

/* The live plan a switch, a cancel or a resume acts on; an unpaid, incomplete or paused one isn't. */
async function currentSubscription(user: BillingUser) {
    return livePlan((await billingRepository.getBillingSummary(user.id)).subscription);
}

/* "Pro" for a plan named "Pro (monthly)" in the catalogue; "personal" when it isn't there. */
async function planNameOf(productId: string) {
    const product = (await getCatalogue()).find((candidate) => candidate.id === productId);
    return product?.name.replace(/\s*\((monthly|yearly|annual)\)\s*$/i, '') ?? 'personal';
}

/*
 * Before a checkout: every personal plan of theirs that Polar still holds but that gives
 * nothing (`unpaid`, `incomplete`, `paused`) is revoked at Polar, so a payment taken
 * later (a card added in the portal can retry what is owed) or a scheduled resume can't
 * run it beside the plan being bought. Such a plan gives no storage, and a resume would
 * start a new period, so nothing in force is taken away; a payment Polar takes for it
 * after the revoke is refunded whole (notePaidAfterRevoke). Each is read first; one Polar
 * has made live again meanwhile (paid in the portal a moment ago) is left alone and
 * becomes the current plan, which the checkout then switches in place. Gone (404) or
 * already ended (403 `AlreadyCanceledSubscription`, a second click) is nothing to do. A
 * revoke that fails otherwise stops the checkout, so two plans never run.
 */
async function revokeLapsedPlans(userId: string) {
    const ids = await billingRepository.listLapsedPlanIds(userId);
    if (!ids.length) return;
    for (const id of ids) {
        let productId: string | null = null;
        try {
            const subscription = await polar().subscriptions.get(id);
            productId = subscription.product_id;
            if (subscription.ended_at || livePlan({ status: subscription.status, endedAt: null }))
                continue;
            await revokeLapsed(userId, id);
        } catch (error) {
            if (statusOf(error) === 404) continue;
            // The plan whose revoke failed, by its own product.
            const name = productId ? await planNameOf(productId) : 'personal';
            if (statusOf(error) === 409 && polarErrorName(error) === 'SubscriptionLocked')
                throw new BillingError(
                    `Polar is still working on a change to your ${name} plan, so it can’t be ended yet. Try again later, or contact support.`,
                    409,
                    { cause: error },
                );
            if (error instanceof LapsedRevokeError && error.reason === 'paid')
                throw new BillingError(
                    `Polar shows a payment for your ${name} plan that hasn’t taken effect yet, so it can’t be ended. Try again in a few minutes, or contact support.`,
                    409,
                    { cause: error },
                );
            if (error instanceof LapsedRevokeError)
                throw new BillingError(
                    `Your ${name} plan is still being ended. Try again in a few minutes.`,
                    409,
                    { cause: error },
                );
            throw unavailable(error);
        }
    }
    await reconcileCustomer(userId);
}

/*
 * A new customer goes through Polar's hosted checkout; an existing subscriber is
 * moved to the other plan in place, prorated, and the local state refreshed.
 */
export async function startCheckout(
    user: BillingUser,
    productId: string,
    address?: string,
    currency?: string,
) {
    await refuseWhilePooled(user);
    const plan = (await listCatalogue()).plans.find((candidate) => candidate.id === productId);
    if (!plan) throw new BillingError('That plan is not available.', 404);
    // The currency the person saw on the pricing page; Polar would otherwise pick one
    // from the address, which can differ from what they were shown.
    if (currency !== undefined && !(currency in plan.prices))
        throw new BillingError('That plan is not priced in that currency.', 400);
    await revokeLapsedPlans(user.id);
    const current = await currentSubscription(user);
    if (current) {
        if (current.productId === productId && !current.cancelAtPeriodEnd)
            throw new BillingError('You are already on that plan.', 409);
        try {
            // A subscription set to cancel refuses plan changes; choosing a plan means
            // keeping it, so it is resumed first.
            if (current.cancelAtPeriodEnd)
                await polar().subscriptions.update(current.id, { cancel_at_period_end: false });
            // The difference is charged (or credited) now, so a yearly upgrade is never
            // left waiting on a renewal invoice that a later cancellation would skip.
            if (current.productId !== productId)
                await polar().subscriptions.update(current.id, {
                    product_id: productId,
                    proration_behavior: 'invoice',
                });
        } catch (error) {
            throw unavailable(error);
        }
        await reconcileCustomer(user.id);
        await billingRepository.consumeIntent(user.id);
        // A bank may refuse the off-session charge until the customer confirms it
        // (3-D Secure, an OTP in India). Polar's portal carries that step.
        if (await hasPendingOrder(current.id)) {
            const portal = await createPortalSession(user);
            return { url: portal.url, confirmPayment: true };
        }
        return { url: null };
    }
    const body: models.CheckoutCreate = {
        products: [productId],
        external_customer_id: user.id,
        customer_ip_address: address && address !== 'unknown' ? address : null,
        currency: (currency as models.PresentmentCurrency | undefined) ?? null,
        success_url: `${appEnv.APP_ORIGIN}/app/billing?checkout_id={CHECKOUT_ID}`,
        return_url: `${appEnv.APP_ORIGIN}/app/billing`,
        allow_trial: false,
        // An affiliate's code carried from sign-up is applied here; anyone may also type one.
        discount_id: await discountFor(user.id),
        allow_discount_codes: true,
    };
    let checkout: models.Checkout;
    try {
        // Prefilled from the account; if Polar's stricter address check refuses the
        // email (it resolves the domain), the checkout asks for one instead.
        try {
            checkout = await polar().checkouts.create({
                ...body,
                customer_email: user.email,
                customer_name: user.name,
            });
        } catch (error) {
            if (!rejectsEmail(error)) throw error;
            checkout = await polar().checkouts.create(body);
        }
    } catch (error) {
        throw unavailable(error);
    }
    await billingRepository.consumeIntent(user.id);
    return { url: checkout.url };
}

/*
 * The provider discount a checkout carries, a personal plan's or a family's (the payer's):
 * the affiliate this person arrived through while it is live, else the code they were given,
 * whether a creator's or one the operator made at Polar and shared as a page (only where it
 * covers `productId`). Creators' discounts cover every product, family plans included.
 */
export async function discountFor(userId: string, productId?: string) {
    const affiliate = await growthRepository.findAffiliateForCustomer(userId);
    if (affiliate?.active && affiliate.providerDiscountId) return affiliate.providerDiscountId;
    const code = await growthRepository.pendingReferralCode(userId);
    if (!code) return null;
    const resolved = await growthRepository.resolveCode(code);
    if (resolved?.kind === 'affiliate') return resolved.affiliate.providerDiscountId ?? null;
    if (resolved?.kind === 'user') return null;
    // A paused creator's code is not the provider's to honour either.
    if (await growthRepository.findAffiliateByHandle(code)) return null;
    const offer = await findProviderDiscount(code);
    // An offer the operator limited to other products would be refused at checkout: none, then,
    // and the person may still type a code there.
    if (offer && productId && offer.productIds.length && !offer.productIds.includes(productId))
        return null;
    return offer?.id ?? null;
}

/* A discount as Polar holds it, reduced to what a page and a checkout need. */
export type ProviderDiscount = {
    id: string;
    code: string;
    name: string;
    terms: DiscountTerms;
    endsAt: string | null;
    /* Products it is limited to; empty means every product. */
    productIds: string[];
};
type PolarDiscount = Awaited<ReturnType<Polar['discounts']['list']>>['items'][number];
const DISCOUNT_CODE = /^[A-Za-z0-9_-]{3,64}$/;
const DISCOUNT_CACHE_MS = 60_000;
const discountCache = new Map<string, { at: number; value: ProviderDiscount | null }>();

/*
 * A discount the operator made at Polar, found by its code, while it can still
 * be redeemed: not before it starts, not after it ends, not once its redemptions
 * are spent. Looked up for a landing page and again at checkout, so answers are
 * kept for a minute; a failure to reach Polar is no discount, never a stale one.
 */
export async function findProviderDiscount(raw: string): Promise<ProviderDiscount | null> {
    const code = raw.trim().toUpperCase();
    if (!DISCOUNT_CODE.test(code) || !billingEnabled()) return null;
    const cached = discountCache.get(code);
    if (cached && Date.now() - cached.at < DISCOUNT_CACHE_MS) return cached.value;
    let page: { items: PolarDiscount[] };
    try {
        page = await polar().discounts.list({ query: code, limit: 100 });
    } catch (error) {
        // Most often a token without `discounts:read`: the page is missing and the checkout carries nothing.
        log.warn({
            message: 'Polar discount lookup failed',
            billing: { code, error: String(error) },
        });
        return null;
    }
    const now = Date.now();
    const match = page.items.find((discount) => discount.code?.toUpperCase() === code);
    const live =
        match &&
        (!match.starts_at || Date.parse(match.starts_at) <= now) &&
        (!match.ends_at || Date.parse(match.ends_at) > now) &&
        (match.max_redemptions === null || match.redemptions_count < match.max_redemptions);
    const value: ProviderDiscount | null = live
        ? {
              id: match.id,
              code,
              name: match.name,
              terms:
                  'basis_points' in match
                      ? {
                            type: 'percentage',
                            percentOff: match.basis_points / 100,
                            duration: match.duration,
                            durationMonths:
                                'duration_in_months' in match
                                    ? (match.duration_in_months ?? null)
                                    : null,
                        }
                      : {
                            type: 'fixed',
                            amount: match.amount,
                            currency: match.currency,
                            duration: match.duration,
                            durationMonths:
                                'duration_in_months' in match
                                    ? (match.duration_in_months ?? null)
                                    : null,
                        },
              endsAt: match.ends_at,
              productIds: (match.products ?? []).map((product) => product.id),
          }
        : null;
    discountCache.set(code, { at: Date.now(), value });
    return value;
}

/*
 * A percentage discount at the provider, for an affiliate's code. The code is
 * what a person types at checkout; the id is what a checkout started from the
 * affiliate's page carries.
 */
export async function createProviderDiscount(input: {
    name: string;
    code: string;
    percentOff: number;
    duration: 'once' | 'forever' | 'repeating';
    durationMonths: number | null;
}) {
    if (!billingEnabled()) return null;
    try {
        const discount = await polar().discounts.create({
            type: 'percentage',
            name: input.name,
            code: input.code,
            duration: input.duration,
            duration_in_months: input.duration === 'repeating' ? input.durationMonths : null,
            basis_points: input.percentOff * 100,
        });
        return discount.id;
    } catch (error) {
        if (error instanceof PolarClientError && error.statusCode === 403)
            throw new BillingError(
                'Polar refused to create the discount. The access token needs the discounts:write scope.',
                409,
                { cause: error },
            );
        if (error instanceof PolarClientError && error.statusCode === 422)
            throw new BillingError(
                'Polar did not accept that discount. The code may already exist there.',
                409,
                { cause: error },
            );
        throw unavailable(error);
    }
}

/* The affiliate's discount at the provider, brought in line with edited terms; the id stays. */
export async function updateProviderDiscount(
    id: string,
    input: {
        name: string;
        code: string;
        percentOff: number;
        duration: 'once' | 'forever' | 'repeating';
        durationMonths: number | null;
    },
) {
    if (!billingEnabled()) return;
    try {
        await polar().discounts.update(id, {
            name: input.name,
            code: input.code,
            duration: input.duration,
            duration_in_months: input.duration === 'repeating' ? input.durationMonths : null,
            basis_points: input.percentOff * 100,
        });
    } catch (error) {
        if (error instanceof PolarClientError && error.statusCode === 403)
            throw new BillingError(
                'Polar refused to change the discount. The access token needs the discounts:write scope.',
                409,
                { cause: error },
            );
        if (error instanceof PolarClientError && error.statusCode === 422)
            throw new BillingError(
                'Polar did not accept that change. The code may already exist there, or the discount has been used and its terms are fixed.',
                409,
                { cause: error },
            );
        throw unavailable(error);
    }
}

/* Removes the discount at the provider, so the code stops applying at checkout; already gone is fine. */
export async function deleteProviderDiscount(id: string) {
    if (!billingEnabled()) return;
    try {
        await polar().discounts.delete(id);
    } catch (error) {
        if (error instanceof PolarClientError && error.statusCode === 404) return;
        if (error instanceof PolarClientError && error.statusCode === 403)
            throw new BillingError(
                'Polar refused to remove the discount. The access token needs the discounts:write scope.',
                409,
                { cause: error },
            );
        throw unavailable(error);
    }
    discountCache.clear();
}

/*
 * What a paid order earns: its affiliate's commission and, for its owner, their inviter's
 * reward. For a payment on a lapsed plan HushOS set out to revoke, the plan-ending job
 * grants these once it knows the plan stays its owner's (the revoke never landed).
 */
export async function grantOrderRewards(
    userId: string,
    order: Parameters<typeof recordAffiliateEarning>[0],
) {
    await recordAffiliateEarning({ ...order, customer: { external_id: userId } });
    await rewardPaidReferral(userId);
}

/*
 * What a paid order of a family's plan earns, as a personal order does, with the family's payer
 * as its owner: the commission of the affiliate whose discount it used, else of the one the
 * payer signed up through; and the paid bonus for whoever invited the payer, once.
 */
export async function grantFamilyOrderRewards(
    groupId: string,
    order: Parameters<typeof recordAffiliateEarning>[0],
) {
    const payer = (await billingRepository.getGroupCustomer(groupId))?.payerUserId ?? null;
    await recordAffiliateEarning({ ...order, customer: payer ? { external_id: payer } : null });
    if (payer) await rewardPaidReferral(payer);
}

/* The inviter's storage when someone they invited pays for a plan; once per invitee, under a cap. */
async function rewardPaidReferral(userId: string) {
    const bonus = appEnv.REFERRAL_PAID_BONUS_BYTES;
    if (bonus <= 0n) return;
    await growthRepository.grantPaidReferralReward({
        referredUserId: userId,
        bonusBytes: bonus,
        paidCapBytes: appEnv.REFERRAL_PAID_CAP_BYTES,
    });
}

/*
 * Commission for a paid order: to the affiliate whose discount the order used,
 * else the one the customer signed up through. Recorded once per order.
 */
async function recordAffiliateEarning(order: {
    id: string;
    discount_id?: string | null;
    net_amount?: number;
    currency?: string;
    customer?: { external_id?: string | null } | null;
}) {
    const externalId = order.customer?.external_id ?? null;
    const userId = externalId && USER_ID_PATTERN.test(externalId) ? externalId : null;
    const affiliate =
        (order.discount_id
            ? await growthRepository.findAffiliateByDiscount(order.discount_id)
            : null) ?? (userId ? await growthRepository.findAffiliateForCustomer(userId) : null);
    if (!affiliate || typeof order.net_amount !== 'number' || !order.currency) return;
    await growthRepository.recordEarning({
        affiliateId: affiliate.id,
        orderId: order.id,
        userId,
        currency: order.currency,
        netAmount: order.net_amount,
        commissionBps: affiliate.commissionBps,
    });
}

function rejectsEmail(error: unknown) {
    if (!(error instanceof PolarClientError) || error.statusCode !== 422) return false;
    const detail = (error.error as { detail?: { loc?: unknown[] }[] } | undefined)?.detail;
    return Array.isArray(detail) && detail.some((item) => item.loc?.includes('customer_email'));
}

async function hasPendingOrder(subscriptionId: string) {
    try {
        const orders = await polar().orders.list({
            subscription_id: subscriptionId,
            status: 'pending',
            limit: 5,
        });
        return orders.items.some((order) => order.due_amount > 0);
    } catch {
        return false;
    }
}

export async function createPortalSession(user: BillingUser) {
    try {
        const session = await polar().customerSessions.create({
            external_customer_id: user.id,
            return_url: `${appEnv.APP_ORIGIN}/app/billing`,
        });
        return { url: session.customer_portal_url };
    } catch (error) {
        if (statusOf(error) === 404 || statusOf(error) === 422)
            throw new BillingError('You do not have a billing account yet.', 404);
        throw unavailable(error);
    }
}

async function updateCurrent(user: BillingUser, body: models.SubscriptionUpdate) {
    const current = await currentSubscription(user);
    if (!current) throw new BillingError('You do not have an active plan.', 404);
    try {
        await polar().subscriptions.update(current.id, body);
    } catch (error) {
        throw unavailable(error);
    }
    await reconcileCustomer(user.id);
    return getSummary(user);
}

export function cancelAtPeriodEnd(
    user: BillingUser,
    input: { reason?: CancellationReason; comment?: string },
) {
    return updateCurrent(user, {
        cancel_at_period_end: true,
        customer_cancellation_reason: input.reason ?? null,
        customer_cancellation_comment: input.comment?.trim() || null,
    });
}

export async function resume(user: BillingUser) {
    await refuseWhilePooled(user);
    return updateCurrent(user, { cancel_at_period_end: false });
}

/*
 * Each sync reads Polar several times: ten a person every ten minutes, as for a family's. The
 * billing page's return from checkout polls up to six times, leaving room for a refresh.
 */
const SYNC_LIMIT = { count: 10, windowMs: 10 * 60 * 1000 };

export async function sync(user: BillingUser) {
    const bucket = createHash('sha256').update(`billing:sync:${user.id}`).digest();
    if (!(await authRepository.consumeRateLimit(bucket, SYNC_LIMIT.count, SYNC_LIMIT.windowMs)))
        throw new BillingError(
            'Too many refreshes just now. Please try again in a few minutes.',
            429,
        );
    await reconcileCustomer(user.id);
    return getSummary(user);
}

function snapshot(
    subscription: Pick<
        models.Subscription,
        | 'id'
        | 'status'
        | 'recurring_interval'
        | 'current_period_end'
        | 'cancel_at_period_end'
        | 'product_id'
        | 'amount'
        | 'currency'
    > & { ended_at?: string | null },
    products: CatalogueProduct[],
): billingRepository.SubscriptionSnapshot | null {
    const product = products.find((candidate) => candidate.id === subscription.product_id);
    if (!product) {
        log.warn({
            message: 'Subscription product is not a HushOS plan',
            billing: { subscription: subscription.id, product: subscription.product_id },
        });
        return null;
    }
    return {
        id: subscription.id,
        productId: product.id,
        productName: product.name,
        status: subscription.status,
        recurringInterval: subscription.recurring_interval,
        amount: subscription.amount,
        currency: subscription.currency,
        quotaBytes: BigInt(product.quotaBytes),
        currentPeriodEnd: new Date(subscription.current_period_end),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
        endedAt: subscription.ended_at ? new Date(subscription.ended_at) : null,
    };
}

/*
 * Webhooks only say that something changed; the provider's customer state says
 * what is true now. Subscriptions that left the state (past due, unpaid, incomplete,
 * paused, ended) are read individually so a retry window is honoured, a lapsed plan
 * is kept with its status, and an ending is recorded as such. A reconcile that began
 * before the newest one written writes nothing and stops: two overlap (a burst of
 * webhooks, the daily run), and the newer read Polar later and does what follows.
 */
export async function reconcileCustomer(userId: string) {
    if (!billingEnabled() || !USER_ID_PATTERN.test(userId)) return;
    // Before the first Polar read: any reconcile that began later read Polar later.
    const readingFrom = await billingRepository.readingStamp();
    let state: models.CustomerState | null;
    try {
        state = await polar().customers.getStateExternal(userId);
    } catch (error) {
        if (statusOf(error) === 404) state = null;
        else throw unavailable(error);
    }
    const products = await getCatalogue();
    const subscriptions: billingRepository.SubscriptionSnapshot[] = [];
    for (const subscription of state?.active_subscriptions ?? []) {
        const entry = snapshot(subscription, products);
        if (entry) subscriptions.push(entry);
    }
    const seen = new Set(subscriptions.map((subscription) => subscription.id));
    for (const id of await billingRepository.listUnendedSubscriptionIds(userId)) {
        if (seen.has(id)) continue;
        try {
            const entry = snapshot(await polar().subscriptions.get(id), products);
            if (entry) subscriptions.push(entry);
        } catch (error) {
            if (statusOf(error) !== 404) throw unavailable(error);
        }
    }
    const outcome = await billingRepository.applyCustomerState({
        userId,
        provider: PROVIDER,
        customerId: state?.id ?? null,
        subscriptions,
        graceMs: billingEnv.BILLING_GRACE_DAYS * 24 * 60 * 60 * 1000,
        readingFrom,
    });
    if (outcome === 'stale') return;
    // A live personal plan of someone whose files draw from a family's pool is ended (5.1).
    if (subscriptions.some((subscription) => livePlan(subscription) || lapsedPlan(subscription)))
        await queuePlanEnding(userId);
}

/*
 * Before an account is deleted: stop billing now, then forget the customer at
 * the provider. A person who pays for a family's live plan is refused first:
 * the card on the family's customer is theirs and would go on being charged
 * (docs/polar-group-billing-spike.md 3).
 */
export async function revokeForDeletion(userId: string) {
    if (!billingEnabled()) return;
    if ((await billingRepository.listGroupsPaidBy(userId)).length)
        throw new BillingError(
            'You pay for a family plan. Hand its billing to another member, or cancel the family plan in its billing portal, then delete your account.',
            409,
        );
    // A family plan they pay for that gives nothing (unpaid, incomplete, paused) is still on their
    // card: a resume or a retried payment would charge it after they're gone. Ended first.
    await endLapsedFamilyPlansFor(userId);
    if (!(await billingRepository.getCustomer(userId))) return;
    try {
        let state: models.CustomerState | null = null;
        try {
            state = await polar().customers.getStateExternal(userId);
        } catch (error) {
            if (statusOf(error) !== 404) throw error;
        }
        // Every plan that can still charge: the customer's state lists only active and trialing
        // ones, so Polar's own list of their subscriptions and the mirror are read too, for one
        // past due (in dunning), unpaid, incomplete or paused (which resumes on its date).
        const ids = new Set((state?.active_subscriptions ?? []).map((s) => s.id));
        if (state) {
            for await (const subscription of polar().subscriptions.iterList({
                external_customer_id: userId,
                limit: 100,
            }))
                if (!subscription.ended_at && !ENDED_STATUSES.has(subscription.status))
                    ids.add(subscription.id);
        }
        for (const id of await billingRepository.listUnendedSubscriptionIds(userId)) ids.add(id);
        for (const id of ids) {
            try {
                await polar().subscriptions.revoke(id);
            } catch (error) {
                if (statusOf(error) === 404) continue;
                if (
                    statusOf(error) === 403 &&
                    polarErrorName(error) === 'AlreadyCanceledSubscription'
                )
                    continue;
                throw error;
            }
        }
        if (state) await polar().customers.deleteExternal(userId);
    } catch (error) {
        throw new BillingError(
            'Your subscription could not be cancelled, so the account was not deleted. Please try again.',
            503,
            { cause: error },
        );
    }
}

/*
 * Before a payer goes (their account deleted): every lapsed plan of a family they pay for
 * is revoked (endLapsedPlansPaidBy), with its ending first, so a payment taken afterwards
 * is refunded whole. A plan that can't be ended stops the deletion with words.
 */
async function endLapsedFamilyPlansFor(userId: string) {
    for (const groupId of await billingRepository.listGroupsBilledTo(userId)) {
        try {
            await endLapsedPlansPaidBy(groupId, userId);
        } catch (error) {
            if (!(error instanceof LapsedFamilyPlanError)) throw error;
            throw new BillingError(
                `${lapsedPlanStaysRefusal(error, 'payer')} Your account was not deleted.`,
                409,
                { cause: error },
            );
        }
    }
}

/* The subscription a delivery is about: a subscription's own id, or an order's subscription. */
function subscriptionOf(event: webhooks.WebhookPayload) {
    const data = event.data as { id?: unknown; subscription_id?: unknown };
    const id = event.type.startsWith('subscription.')
        ? data.id
        : event.type.startsWith('order.')
          ? data.subscription_id
          : null;
    return typeof id === 'string' && id.length > 0 && id.length <= 100 ? id : undefined;
}

/* Whom a delivery concerns: a person (their user id) or a group (`group:<groupId>`). */
function ownerOf(event: webhooks.WebhookPayload) {
    const data = event.data as {
        external_id?: string | null;
        customer?: { external_id?: string | null } | null;
    };
    const id = data.external_id ?? data.customer?.external_id ?? null;
    if (!id) return null;
    if (USER_ID_PATTERN.test(id)) return { kind: 'user' as const, id };
    const groupId = id.startsWith(GROUP_CUSTOMER_PREFIX) ? groupIdOf(id) : null;
    return groupId ? { kind: 'group' as const, id: groupId } : null;
}

/*
 * Every delivery is verified, recorded once, and answered by refreshing the
 * customer it concerns. A failure after verification is a 503 so Polar retries.
 */
export async function handleWebhook(request: Request): Promise<Response> {
    if (!billingEnabled() || !billingEnv.POLAR_WEBHOOK_SECRET)
        return Response.json({ message: 'Billing is not enabled.' }, { status: 404 });
    if (Number(request.headers.get('content-length') ?? 0) > WEBHOOK_MAX_BYTES)
        return Response.json({ message: 'Request is too large.' }, { status: 413 });
    const body = await request.text();
    if (body.length > WEBHOOK_MAX_BYTES)
        return Response.json({ message: 'Request is too large.' }, { status: 413 });
    const id = request.headers.get('webhook-id') ?? '';
    let event: webhooks.WebhookPayload;
    try {
        event = await webhooks.validateEvent(
            body,
            {
                'webhook-id': id,
                'webhook-timestamp': request.headers.get('webhook-timestamp') ?? '',
                'webhook-signature': request.headers.get('webhook-signature') ?? '',
            },
            billingEnv.POLAR_WEBHOOK_SECRET,
        );
    } catch (error) {
        if (error instanceof webhooks.PolarWebhookUnknownTypeError)
            return Response.json({ received: true, ignored: true });
        return Response.json({ message: 'Invalid signature.' }, { status: 403 });
    }
    if (!id || id.length > 200) return Response.json({ message: 'Missing id.' }, { status: 400 });
    const { pending } = await billingRepository.recordWebhookEvent({
        id,
        provider: PROVIDER,
        type: event.type,
    });
    if (pending) {
        const owner = ownerOf(event);
        const userId = owner?.kind === 'user' ? owner.id : null;
        if (userId) await reconcileCustomer(userId);
        // A family's delivery names the subscription it is about (`data.id` for subscription.*,
        // `data.subscription_id` for order.*): read even when Polar's state doesn't list it, so
        // a deleted family's plan reinstated into past due is found by its own delivery.
        if (owner?.kind === 'group')
            await reconcileGroup(owner.id, {
                subscriptionId: subscriptionOf(event),
                fromDelivery: true,
            });
        // A refund HushOS made that failed after it succeeded: its plan's refunds are placed again.
        if (event.type === 'refund.updated')
            await noteRefundUpdated(event.data as Parameters<typeof noteRefundUpdated>[0]);
        if (event.type === 'order.paid') {
            // A payment for a lapsed plan HushOS revoked is refunded whole, so it earns no
            // commission and no referral reward. (A pooled member's renewal refunded by the
            // plan-ending job below still does: an existing gap.)
            const refunded = await notePaidAfterRevoke(
                event.data as Parameters<typeof notePaidAfterRevoke>[0],
            );
            if (!refunded) {
                const order = event.data as Parameters<typeof recordAffiliateEarning>[0];
                if (owner?.kind === 'group') await grantFamilyOrderRewards(owner.id, order);
                else {
                    await recordAffiliateEarning(order);
                    if (userId) await rewardPaidReferral(userId);
                }
            }
            // A personal order paid while its owner's files draw from a family's pool (a
            // renewal that slipped past the revoke, a checkout that raced the admission):
            // the plan is ended and the order refunded by the same job (5.1).
            if (userId && (await billingRepository.getPooledFamily(userId))) {
                log.error({
                    message: 'A personal order was paid while its owner is in a family’s pool',
                    billing: { user: userId, order: (event.data as { id?: string }).id },
                });
                await queuePlanEnding(userId, { force: true });
            }
        }
        await billingRepository.markWebhookProcessed(id);
    }
    return Response.json({ received: true });
}

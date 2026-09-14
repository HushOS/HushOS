import { billingRepository, growthRepository } from '@hushos/db';
import { appEnv } from '@hushos/env/app';
import { billingEnv } from '@hushos/env/billing';
import { log } from '@hushos/logging';
import { createPolar, webhooks, type Polar, type models } from '@polar-sh/sdk/2026-04';
import { PolarClientError } from '@polar-sh/sdk';
import type { BillingSummary, Catalogue, DiscountTerms, Plan } from './api';
import {
    PLAN_METADATA_KEY,
    QUOTA_METADATA_KEY,
    DEFAULT_CURRENCY,
    RECOMMENDED_METADATA_KEY,
    type CancellationReason,
} from './protocol';

const PROVIDER = 'polar';
const CATALOGUE_TTL_MS = 60_000;
const WEBHOOK_MAX_BYTES = 256 * 1024;
const USER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type BillingUser = { id: string; name: string; email: string };

export class BillingError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503 = 400,
        options?: { cause?: unknown },
    ) {
        super(message, options);
        this.name = 'BillingError';
    }
}

export function billingEnabled() {
    return billingEnv.BILLING_PROVIDER === 'polar';
}

let client: Polar | undefined;
function polar() {
    if (!billingEnabled() || !billingEnv.POLAR_ACCESS_TOKEN)
        throw new BillingError('Billing is not available on this server.', 404);
    client ??= createPolar({
        accessToken: billingEnv.POLAR_ACCESS_TOKEN,
        environment: billingEnv.POLAR_ENVIRONMENT,
        timeout: 15,
    });
    return client;
}

function unavailable(error: unknown) {
    if (error instanceof PolarClientError && error.statusCode === 403)
        return new BillingError(
            'Polar does not allow that change on this subscription right now. Manage it in the billing portal, or contact support.',
            409,
            { cause: error },
        );
    if (error instanceof PolarClientError && error.statusCode === 422)
        return new BillingError(
            'Polar could not accept these details. Check your account name and email, then try again.',
            400,
            { cause: error },
        );
    return new BillingError('Billing is temporarily unavailable. Please try again.', 503, {
        cause: error,
    });
}

function statusOf(error: unknown) {
    return error instanceof PolarClientError ? error.statusCode : null;
}

/* The catalogue: every recurring product marked as a HushOS plan, archived ones included. */
type CatalogueProduct = Plan & { archived: boolean };
let catalogue: { at: number; products: CatalogueProduct[] } | undefined;
let loading: Promise<CatalogueProduct[]> | undefined;

function readProduct(product: models.Product): CatalogueProduct | null {
    const metadata = product.metadata as Record<string, unknown>;
    if (!metadata[PLAN_METADATA_KEY]) return null;
    const interval = product.recurring_interval;
    if (interval !== 'month' && interval !== 'year') return null;
    let quotaBytes: bigint;
    try {
        quotaBytes = BigInt(String(metadata[QUOTA_METADATA_KEY]));
    } catch {
        return null;
    }
    if (quotaBytes <= 0n) return null;
    // One fixed price per currency; the default currency's is the one every plan has.
    const prices: Record<string, number> = {};
    for (const candidate of product.prices)
        if (
            'amount_type' in candidate &&
            candidate.amount_type === 'fixed' &&
            !candidate.is_archived &&
            !(candidate.price_currency in prices)
        )
            prices[candidate.price_currency] = candidate.price_amount;
    const amount = prices[DEFAULT_CURRENCY];
    if (amount === undefined) return null;
    return {
        id: product.id,
        name: product.name,
        description: product.description,
        interval,
        amount,
        currency: DEFAULT_CURRENCY,
        prices,
        quotaBytes: quotaBytes.toString(),
        recommended: [true, 'true', 1, '1'].includes(metadata[RECOMMENDED_METADATA_KEY] as never),
        archived: product.is_archived,
    };
}

async function loadCatalogue() {
    const products: CatalogueProduct[] = [];
    for await (const product of polar().products.iterList({ is_recurring: true, limit: 100 })) {
        const plan = readProduct(product);
        if (plan) products.push(plan);
    }
    products.sort(
        (a, b) =>
            Number(BigInt(a.quotaBytes) - BigInt(b.quotaBytes)) ||
            a.interval.localeCompare(b.interval) ||
            a.amount - b.amount,
    );
    return products;
}

async function getCatalogue() {
    if (catalogue && Date.now() - catalogue.at < CATALOGUE_TTL_MS) return catalogue.products;
    loading ??= loadCatalogue()
        .then((products) => {
            catalogue = { at: Date.now(), products };
            return products;
        })
        .finally(() => {
            loading = undefined;
        });
    try {
        return await loading;
    } catch (error) {
        if (catalogue) return catalogue.products;
        throw unavailable(error);
    }
}

export async function listCatalogue(): Promise<Catalogue> {
    const freeQuotaBytes = appEnv.INITIAL_STORAGE_QUOTA_BYTES.toString();
    if (!billingEnabled()) return { enabled: false, freeQuotaBytes, plans: [] };
    const products = await getCatalogue();
    return {
        enabled: true,
        freeQuotaBytes,
        plans: products
            .filter((product) => !product.archived)
            .map(({ archived: _archived, ...plan }) => plan),
    };
}

export async function getSummary(user: BillingUser): Promise<BillingSummary> {
    if (!billingEnabled())
        return { enabled: false, hasCustomer: false, subscription: null, intendedPlan: null };
    const [summary, intent, plans] = await Promise.all([
        billingRepository.getBillingSummary(user.id),
        billingRepository.getPendingIntent(user.id),
        listCatalogue().then((catalogue) => catalogue.plans),
    ]);
    const live = summary.subscription && !summary.subscription.endedAt;
    const intendedPlan =
        !live && intent?.planProductId && plans.some((plan) => plan.id === intent.planProductId)
            ? intent.planProductId
            : null;
    return { enabled: true, ...summary, intendedPlan };
}

async function currentSubscription(user: BillingUser) {
    const summary = await billingRepository.getBillingSummary(user.id);
    return summary.subscription && !summary.subscription.endedAt ? summary.subscription : null;
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
    const plan = (await listCatalogue()).plans.find((candidate) => candidate.id === productId);
    if (!plan) throw new BillingError('That plan is not available.', 404);
    // The currency the person saw on the pricing page; Polar would otherwise pick one
    // from the address, which can differ from what they were shown.
    if (currency !== undefined && !(currency in plan.prices))
        throw new BillingError('That plan is not priced in that currency.', 400);
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
 * The provider discount a checkout carries: the affiliate this person arrived
 * through while it is live, else the code they were given, whether a creator's
 * or one the operator made at Polar and shared as a page.
 */
async function discountFor(userId: string) {
    const affiliate = await growthRepository.findAffiliateForCustomer(userId);
    if (affiliate?.active && affiliate.providerDiscountId) return affiliate.providerDiscountId;
    const code = await growthRepository.pendingReferralCode(userId);
    if (!code) return null;
    const resolved = await growthRepository.resolveCode(code);
    if (resolved?.kind === 'affiliate') return resolved.affiliate.providerDiscountId ?? null;
    if (resolved?.kind === 'user') return null;
    return (await findProviderDiscount(code))?.id ?? null;
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

export function resume(user: BillingUser) {
    return updateCurrent(user, { cancel_at_period_end: false });
}

export async function sync(user: BillingUser) {
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
 * what is true now. Subscriptions that left the state (past due, ended) are read
 * individually so a retry window is honoured and an ending is recorded as such.
 */
export async function reconcileCustomer(userId: string) {
    if (!billingEnabled() || !USER_ID_PATTERN.test(userId)) return;
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
    for (const id of await billingRepository.listLiveSubscriptionIds(userId)) {
        if (seen.has(id)) continue;
        try {
            const entry = snapshot(await polar().subscriptions.get(id), products);
            if (entry) subscriptions.push(entry);
        } catch (error) {
            if (statusOf(error) !== 404) throw unavailable(error);
        }
    }
    await billingRepository.applyCustomerState({
        userId,
        provider: PROVIDER,
        customerId: state?.id ?? null,
        subscriptions,
        graceMs: billingEnv.BILLING_GRACE_DAYS * 24 * 60 * 60 * 1000,
    });
}

/* Before an account is deleted: stop billing now, then forget the customer at the provider. */
export async function revokeForDeletion(userId: string) {
    if (!billingEnabled()) return;
    if (!(await billingRepository.getCustomer(userId))) return;
    try {
        let state: models.CustomerState | null = null;
        try {
            state = await polar().customers.getStateExternal(userId);
        } catch (error) {
            if (statusOf(error) !== 404) throw error;
        }
        for (const subscription of state?.active_subscriptions ?? []) {
            try {
                await polar().subscriptions.revoke(subscription.id);
            } catch (error) {
                if (statusOf(error) !== 404 && statusOf(error) !== 403) throw error;
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

function externalIdOf(event: webhooks.WebhookPayload) {
    const data = event.data as {
        external_id?: string | null;
        customer?: { external_id?: string | null } | null;
    };
    const id = data.external_id ?? data.customer?.external_id ?? null;
    return id && USER_ID_PATTERN.test(id) ? id : null;
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
        const userId = externalIdOf(event);
        if (userId) await reconcileCustomer(userId);
        if (event.type === 'order.paid') {
            await recordAffiliateEarning(
                event.data as Parameters<typeof recordAffiliateEarning>[0],
            );
            if (userId) await rewardPaidReferral(userId);
        }
        await billingRepository.markWebhookProcessed(id);
    }
    return Response.json({ received: true });
}

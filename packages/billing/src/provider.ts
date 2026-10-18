import { billingEnv } from '@hushos/env/billing';
import { log } from '@hushos/logging';
import { createPolar, type Polar, type models } from '@polar-sh/sdk/2026-10';
import { PolarClientError } from '@polar-sh/sdk';
import type { FamilyPlan, Plan } from './api';
import {
    DEFAULT_CURRENCY,
    FAMILY_MAX_MEMBERS,
    FAMILY_TIERS,
    GROUP_KIND_METADATA_KEY,
    INCLUDED_MEMBERS_METADATA_KEY,
    PLAN_METADATA_KEY,
    QUOTA_METADATA_KEY,
    QUOTA_PER_MEMBER_METADATA_KEY,
    RECOMMENDED_METADATA_KEY,
    TIER_METADATA_KEY,
    type FamilyTier,
} from './protocol';

/*
 * What the personal and group billing code share: the provider client, its
 * errors, and the catalogue, read once for both kinds of plan.
 */

export const PROVIDER = 'polar';

export type BillingUser = { id: string; name: string; email: string };
const CATALOGUE_TTL_MS = 60_000;

export class BillingError extends Error {
    constructor(
        message: string,
        readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 429 | 503 = 400,
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
export function polar() {
    if (!billingEnabled() || !billingEnv.POLAR_ACCESS_TOKEN)
        throw new BillingError('Billing is not available on this server.', 404);
    client ??= createPolar({
        accessToken: billingEnv.POLAR_ACCESS_TOKEN,
        environment: billingEnv.POLAR_ENVIRONMENT,
        timeout: 15,
    });
    return client;
}

export function unavailable(error: unknown) {
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

export function statusOf(error: unknown) {
    return error instanceof PolarClientError ? error.statusCode : null;
}

/* ------------------------------------------------------------------------- */
/* The catalogue                                                              */
/* ------------------------------------------------------------------------- */

/* Every recurring product marked as a HushOS plan, archived ones included. */
export type CatalogueProduct = Plan & { archived: boolean };
export type FamilyCatalogueProduct = FamilyPlan & { archived: boolean };
type Catalogues = { plans: CatalogueProduct[]; families: FamilyCatalogueProduct[] };

let catalogue: { at: number; value: Catalogues } | undefined;
let loading: Promise<Catalogues> | undefined;

function quotaOf(metadata: Record<string, unknown>) {
    try {
        const quota = BigInt(String(metadata[QUOTA_METADATA_KEY]));
        return quota > 0n ? quota : null;
    } catch {
        return null;
    }
}

const recommendedOf = (metadata: Record<string, unknown>) =>
    [true, 'true', 1, '1'].includes(metadata[RECOMMENDED_METADATA_KEY] as never);

function readProduct(product: models.Product): CatalogueProduct | null {
    const metadata = product.metadata as Record<string, unknown>;
    if (!metadata[PLAN_METADATA_KEY]) return null;
    // Group plans carry `hushos_plan` and fixed prices too; they are never a person's plan.
    if (metadata[GROUP_KIND_METADATA_KEY] !== undefined) return null;
    const interval = product.recurring_interval;
    if (interval !== 'month' && interval !== 'year') return null;
    const quotaBytes = quotaOf(metadata);
    if (quotaBytes === null) return null;
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
        recommended: recommendedOf(metadata),
        archived: product.is_archived,
    };
}

/*
 * A tier's unit amount in whole minor units. Polar returns it as a decimal
 * string (spike E2: "0", "200"); a fraction of a minor unit is refused, since
 * HushOS quotes and floors in whole minor units.
 */
export function parseMinorUnits(value: unknown): number | null {
    const text = typeof value === 'number' ? String(value) : value;
    if (typeof text !== 'string') return null;
    const match = /^(\d{1,15})(?:\.(\d{1,20}))?$/.exec(text);
    if (!match || (match[2] && !/^0+$/.test(match[2]))) return null;
    return Number(match[1]);
}

function integerMetadata(value: unknown) {
    const text = typeof value === 'number' ? String(value) : value;
    return typeof text === 'string' && /^\d{1,6}$/.test(text) ? Number(text) : null;
}

/*
 * A family plan as HushOS sells it, or null with the reason logged. Per
 * currency: one fixed base, and one graduated unit price whose first tier is
 * free up to `included_members` and whose second is the per-member rate, with
 * `minimum_units` at the same count. Polar checks only that currencies share
 * a structure, not their bounds (spike E2: a product with 5 included in EUR and
 * 6 in USD sold a smaller family in EUR), so a product whose currencies
 * disagree on the bound or the minimum, or whose bound is not the metadata's
 * count, is dropped whole. `hushos_tier` names the tier (Family Plus, Pro or
 * Max); one without it is the single Family plan from before the tiers, and
 * one with any other value is dropped.
 */
export function readFamilyProduct(product: models.Product): FamilyCatalogueProduct | null {
    const metadata = product.metadata as Record<string, unknown>;
    if (metadata[GROUP_KIND_METADATA_KEY] !== 'family' || !metadata[PLAN_METADATA_KEY]) return null;
    const drop = (reason: string) => {
        log.warn({
            message: 'Family product is not offered',
            billing: { product: product.id, reason },
        });
        return null;
    };
    const interval = product.recurring_interval;
    if (interval !== 'month' && interval !== 'year') return drop('interval');
    const quotaBytes = quotaOf(metadata);
    if (quotaBytes === null) return drop('quota');
    if (metadata[QUOTA_PER_MEMBER_METADATA_KEY] !== undefined) return drop('quota-per-member');
    const tierValue = metadata[TIER_METADATA_KEY];
    if (tierValue !== undefined && !FAMILY_TIERS.includes(tierValue as FamilyTier))
        return drop('tier');
    const tier = (tierValue as FamilyTier | undefined) ?? null;
    const included = integerMetadata(metadata[INCLUDED_MEMBERS_METADATA_KEY]);
    if (included === null || included < 1 || included > FAMILY_MAX_MEMBERS)
        return drop('included-members');
    const fixed = new Map<string, number>();
    const units = new Map<string, models.ProductPriceUnitBased>();
    for (const candidate of product.prices) {
        if (!('amount_type' in candidate) || candidate.is_archived) continue;
        if (candidate.amount_type === 'fixed' && !fixed.has(candidate.price_currency))
            fixed.set(candidate.price_currency, candidate.price_amount);
        else if (candidate.amount_type === 'unit_based' && !units.has(candidate.price_currency))
            units.set(candidate.price_currency, candidate);
        else return drop('price-shape');
    }
    const currencies = new Set([...fixed.keys(), ...units.keys()]);
    if (!currencies.has(DEFAULT_CURRENCY)) return drop('default-currency');
    const prices: FamilyPlan['prices'] = {};
    for (const currency of currencies) {
        const base = fixed.get(currency);
        const unit = units.get(currency);
        if (base === undefined || !unit) return drop('price-shape');
        const [free, paid, ...rest] = unit.tiers.tiers;
        if (unit.tiers.type !== 'graduated' || !free || !paid || rest.length) return drop('tiers');
        const perMember = parseMinorUnits(paid.unit_amount);
        if (
            free.bound !== included ||
            parseMinorUnits(free.unit_amount) !== 0 ||
            (paid.bound ?? null) !== null ||
            perMember === null ||
            unit.minimum_units !== included
        )
            return drop(`bounds-${currency}`);
        prices[currency] = { base, perMember };
    }
    return {
        id: product.id,
        name: product.name,
        description: product.description,
        interval,
        tier,
        recommended: recommendedOf(metadata),
        prices,
        includedMembers: included,
        maxMembers: FAMILY_MAX_MEMBERS,
        quotaBytes: quotaBytes.toString(),
        archived: product.is_archived,
    };
}

async function loadCatalogue(): Promise<Catalogues> {
    const plans: CatalogueProduct[] = [];
    const families: FamilyCatalogueProduct[] = [];
    for await (const product of polar().products.iterList({ is_recurring: true, limit: 100 })) {
        const plan = readProduct(product);
        if (plan) plans.push(plan);
        const family = readFamilyProduct(product);
        if (family) families.push(family);
    }
    plans.sort(
        (a, b) =>
            Number(BigInt(a.quotaBytes) - BigInt(b.quotaBytes)) ||
            a.interval.localeCompare(b.interval) ||
            a.amount - b.amount,
    );
    families.sort(
        (a, b) =>
            Number(BigInt(a.quotaBytes) - BigInt(b.quotaBytes)) ||
            a.interval.localeCompare(b.interval),
    );
    return { plans, families };
}

async function getCatalogues() {
    if (catalogue && Date.now() - catalogue.at < CATALOGUE_TTL_MS) return catalogue.value;
    loading ??= loadCatalogue()
        .then((value) => {
            catalogue = { at: Date.now(), value };
            return value;
        })
        .finally(() => {
            loading = undefined;
        });
    try {
        return await loading;
    } catch (error) {
        if (catalogue) return catalogue.value;
        throw unavailable(error);
    }
}

/* Personal plans, archived ones included. */
export async function getCatalogue() {
    return (await getCatalogues()).plans;
}

/* Family plans, archived ones included (an archived plan still has subscribers). */
export async function getFamilyCatalogue() {
    return (await getCatalogues()).families;
}

/*
 * The family plans a page offers: not archived, and once any tier is on sale,
 * only the tiers. The single Family plan from before them is then never shown
 * beside them, whether or not the operator has archived it yet; anyone on it
 * keeps it, read from the full catalogue.
 */
export function offeredFamilies<T extends FamilyCatalogueProduct>(families: readonly T[]) {
    const live = families.filter((family) => !family.archived);
    return live.some((family) => family.tier !== null)
        ? live.filter((family) => family.tier !== null)
        : live;
}

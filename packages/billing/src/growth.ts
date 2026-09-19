import { growthRepository } from '@hushos/db';
import { appEnv } from '@hushos/env/app';
import type {
    AffiliateInput,
    AffiliateView,
    OfferLanding,
    ReferralLanding,
    ReferralSummary,
} from './api';
import {
    BillingError,
    billingEnabled,
    createProviderDiscount,
    deleteProviderDiscount,
    findProviderDiscount,
    listCatalogue,
    updateProviderDiscount,
} from './server';

/*
 * Referrals and affiliates, above the repository: what a new account triggers,
 * what a person's Referrals page shows, what a landing page shows, and what an
 * operator does with an affiliate. Money never moves here: referrals pay in
 * storage, and affiliate commissions are recorded for an operator to settle.
 */

export function referralSettings() {
    return {
        bonusBytes: appEnv.REFERRAL_BONUS_BYTES,
        signupCapBytes: appEnv.REFERRAL_SIGNUP_CAP_BYTES,
        paidBonusBytes: appEnv.REFERRAL_PAID_BONUS_BYTES,
        paidCapBytes: appEnv.REFERRAL_PAID_CAP_BYTES,
    };
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
const CODE = /^[A-Z0-9]{3,32}$/;

/*
 * A new account arrived with a code: attribute it, and for an invite between
 * people, grant both sides their storage. Never throws into registration; an
 * attribution that fails is an attribution that did not happen.
 */
export async function attributeNewAccount(userId: string, code: string | undefined) {
    if (!code) return;
    const referral = await growthRepository.attributeSignup({ userId, code });
    if (!referral || referral.kind !== 'user') return;
    const settings = referralSettings();
    if (settings.bonusBytes <= 0n) return;
    await growthRepository.grantReferralRewards({
        referralId: referral.id,
        bonusBytes: settings.bonusBytes,
        signupCapBytes: settings.signupCapBytes,
    });
}

/* Someone paid for a plan: if a person invited them, that person earns the paid bonus, once. */
export async function rewardPaidReferral(userId: string) {
    const settings = referralSettings();
    if (settings.paidBonusBytes <= 0n) return false;
    return growthRepository.grantPaidReferralReward({
        referredUserId: userId,
        bonusBytes: settings.paidBonusBytes,
        paidCapBytes: settings.paidCapBytes,
    });
}

function affiliateUrl(slug: string) {
    return `${appEnv.APP_ORIGIN}/go/${slug}`;
}

async function view(row: Awaited<ReturnType<typeof growthRepository.getAffiliate>>) {
    if (!row) throw new BillingError('That affiliate does not exist.', 404);
    const stats = await growthRepository.affiliateStats(row.id);
    return {
        id: row.id,
        name: row.name,
        slug: row.slug,
        code: row.code,
        url: affiliateUrl(row.slug),
        percentOff: row.percentOff,
        duration: row.duration,
        durationMonths: row.durationMonths,
        commissionBps: row.commissionBps,
        active: row.active,
        userId: row.userId,
        notes: row.notes,
        providerDiscountId: row.providerDiscountId,
        createdAt: row.createdAt.toISOString(),
        stats,
    } satisfies AffiliateView;
}

export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
    const settings = referralSettings();
    const summary = await growthRepository.getReferralSummary(userId);
    const affiliate = await growthRepository.getAffiliateForUser(userId);
    return {
        code: summary.code,
        url: `${appEnv.APP_ORIGIN}/r/${summary.code}`,
        joined: summary.joined,
        signup: {
            count: summary.signup.count,
            bytes: summary.signup.bytes.toString(),
            bonusBytes: settings.bonusBytes.toString(),
            capBytes: settings.signupCapBytes.toString(),
        },
        paid: {
            count: summary.paid.count,
            bytes: summary.paid.bytes.toString(),
            bonusBytes: settings.paidBonusBytes.toString(),
            capBytes: settings.paidCapBytes.toString(),
        },
        affiliate: affiliate ? await view(affiliate) : null,
    };
}

/* The invite page: who is inviting, and what both sides get. Nothing else about the inviter. */
export async function getReferralLanding(code: string): Promise<ReferralLanding | null> {
    const resolved = await growthRepository.resolveCode(code);
    if (resolved?.kind !== 'user') return null;
    return {
        inviter: resolved.name,
        bonusBytes: referralSettings().bonusBytes.toString(),
        paidBonusBytes: referralSettings().paidBonusBytes.toString(),
        freeBytes: appEnv.INITIAL_STORAGE_QUOTA_BYTES.toString(),
    };
}

/* The affiliate's page: the offer and the catalogue, priced before the discount. */
/*
 * The page behind /go/<slug>: a creator's, by their slug or their code, or a
 * discount the operator made at Polar and shared by its code. A person's own
 * invite code is not an offer and has its own page.
 */
const OFFER = /^[A-Za-z0-9_-]{1,64}$/;
export async function getOfferLanding(slug: string): Promise<OfferLanding | null> {
    if (!OFFER.test(slug)) return null;
    const bySlug = SLUG.test(slug) ? await growthRepository.getAffiliateBySlug(slug) : null;
    const resolved = bySlug ? null : await growthRepository.resolveCode(slug);
    const affiliate = bySlug ?? (resolved?.kind === 'affiliate' ? resolved.affiliate : null);
    if (affiliate && affiliate.active)
        return {
            kind: 'affiliate',
            name: affiliate.name,
            code: affiliate.code,
            terms: {
                type: 'percentage',
                percentOff: affiliate.percentOff,
                duration: affiliate.duration,
                durationMonths: affiliate.durationMonths,
            },
            endsAt: null,
            productIds: [],
            catalogue: await listCatalogue(),
        };
    if (affiliate || resolved) return null;
    // A paused creator's slug and code are theirs still: no page, not the provider's code either.
    if (await growthRepository.findAffiliateByHandle(slug)) return null;
    const discount = await findProviderDiscount(slug);
    if (!discount) return null;
    return {
        kind: 'code',
        name: discount.name,
        code: discount.code,
        terms: discount.terms,
        endsAt: discount.endsAt,
        productIds: discount.productIds,
        catalogue: await listCatalogue(),
    };
}

/* A signed-in visitor on an offer page: the code is kept for their next checkout. */
export async function rememberCoupon(userId: string, code: string) {
    const resolved = await growthRepository.resolveCode(code);
    if (resolved?.kind === 'affiliate' && resolved.affiliate.providerDiscountId) {
        await growthRepository.rememberCoupon(userId, resolved.affiliate.code);
        return { code: resolved.affiliate.code };
    }
    // A creator's code stays theirs while paused: it is not valid, and not the provider's either.
    const discount =
        resolved || (await growthRepository.findAffiliateByHandle(code))
            ? null
            : await findProviderDiscount(code);
    if (!discount) throw new BillingError('That code is not valid.', 404);
    await growthRepository.rememberCoupon(userId, discount.code);
    return { code: discount.code };
}

export async function listAffiliates() {
    const rows = await growthRepository.listAffiliates();
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        code: row.code,
        url: affiliateUrl(row.slug),
        percentOff: row.percentOff,
        duration: row.duration,
        durationMonths: row.durationMonths,
        commissionBps: row.commissionBps,
        active: row.active,
        userId: row.userId,
        notes: row.notes,
        providerDiscountId: row.providerDiscountId,
        createdAt: row.createdAt.toISOString(),
        stats: row.stats,
    })) satisfies AffiliateView[];
}

async function userIdForEmail(email: string | null | undefined) {
    if (!email) return null;
    const userId = await growthRepository.findUserIdByEmail(email.trim().toLowerCase());
    if (!userId) throw new BillingError('No account has that email address.', 404);
    return userId;
}

function validate(input: AffiliateInput) {
    const slug = growthRepository.normalizeSlug(input.slug);
    const code = growthRepository.normalizeAffiliateCode(input.code);
    const name = input.name.trim();
    if (!name || name.length > 100) throw new BillingError('Give the affiliate a name.');
    if (!SLUG.test(slug))
        throw new BillingError('A slug is lower-case letters, digits and dashes, up to 40.');
    if (!CODE.test(code)) throw new BillingError('A code is 3 to 32 letters and digits.');
    if (!Number.isInteger(input.percentOff) || input.percentOff < 1 || input.percentOff > 100)
        throw new BillingError('The discount is a whole percentage from 1 to 100.');
    if (
        !Number.isInteger(input.commissionBps) ||
        input.commissionBps < 0 ||
        input.commissionBps > 10_000
    )
        throw new BillingError('The commission is a whole number of basis points, up to 10000.');
    const durationMonths = input.duration === 'repeating' ? (input.durationMonths ?? null) : null;
    if (
        input.duration === 'repeating' &&
        (!durationMonths ||
            !Number.isInteger(durationMonths) ||
            durationMonths < 1 ||
            durationMonths > 36)
    )
        throw new BillingError('A repeating discount lasts 1 to 36 months.');
    return { name, slug, code, durationMonths };
}

/*
 * An operator enrols a creator. The discount is created at the provider first,
 * so a code that the provider refuses (already taken there) never becomes an
 * affiliate that cannot be applied at checkout.
 */
export async function createAffiliate(input: AffiliateInput) {
    const { name, slug, code, durationMonths } = validate(input);
    const userId = await userIdForEmail(input.userEmail);
    const providerDiscountId = await createProviderDiscount({
        name: `${name} (${code})`,
        code,
        percentOff: input.percentOff,
        duration: input.duration,
        durationMonths,
    });
    const row = await growthRepository.createAffiliate({
        name,
        slug,
        code,
        percentOff: input.percentOff,
        duration: input.duration,
        durationMonths,
        commissionBps: input.commissionBps,
        userId,
        notes: input.notes?.trim() || null,
        providerDiscountId,
    });
    return view(row);
}

/* A slug or code is one handle: the offer page resolves either, so neither may be another affiliate's. */
async function assertHandleFree(handle: string, id: string, what: 'slug' | 'code') {
    const taken = await growthRepository.findAffiliateByHandle(handle);
    if (taken && taken.id !== id)
        throw new BillingError(`That ${what} belongs to another affiliate.`);
}

/*
 * Edits an affiliate. Everything the enrolment form set can change; the code
 * and the discount's terms change at the provider first, so the row never
 * promises what a checkout will not apply. The slug is this site's alone.
 */
export async function updateAffiliate(
    id: string,
    patch: Partial<AffiliateInput> & { active?: boolean },
) {
    const row = await growthRepository.getAffiliate(id);
    if (!row) throw new BillingError('That affiliate does not exist.', 404);
    const merged: AffiliateInput = {
        name: patch.name ?? row.name,
        slug: patch.slug ?? row.slug,
        code: patch.code ?? row.code,
        percentOff: patch.percentOff ?? row.percentOff,
        duration: patch.duration ?? row.duration,
        durationMonths:
            patch.durationMonths !== undefined
                ? patch.durationMonths
                : (patch.duration ?? row.duration) === 'repeating'
                  ? row.durationMonths
                  : null,
        commissionBps: patch.commissionBps ?? row.commissionBps,
    };
    const { name, slug, code, durationMonths } = validate(merged);
    if (slug !== row.slug) await assertHandleFree(slug, id, 'slug');
    if (code !== row.code) await assertHandleFree(code, id, 'code');
    const changes: Parameters<typeof growthRepository.updateAffiliate>[1] = {
        name,
        slug,
        code,
        percentOff: merged.percentOff,
        duration: merged.duration,
        durationMonths,
        commissionBps: merged.commissionBps,
    };
    if (patch.notes !== undefined) changes.notes = patch.notes?.trim() || null;
    if (patch.userEmail !== undefined) changes.userId = await userIdForEmail(patch.userEmail);
    if (patch.active !== undefined) changes.active = patch.active;
    const termsChanged =
        name !== row.name ||
        code !== row.code ||
        merged.percentOff !== row.percentOff ||
        merged.duration !== row.duration ||
        durationMonths !== row.durationMonths;
    if (termsChanged && row.providerDiscountId)
        await updateProviderDiscount(row.providerDiscountId, {
            name: `${name} (${code})`,
            code,
            percentOff: merged.percentOff,
            duration: merged.duration,
            durationMonths,
        });
    return view(await growthRepository.updateAffiliate(id, changes));
}

/*
 * Removes an affiliate: the discount at the provider first, so the code stops
 * applying at checkout even if the row outlives it, then the row, with the
 * attributions and the ledger of what was paid. Commission still owed blocks it.
 */
export async function deleteAffiliate(id: string) {
    const row = await growthRepository.getAffiliate(id);
    if (!row) throw new BillingError('That affiliate does not exist.', 404);
    const stats = await growthRepository.affiliateStats(id);
    if (Object.values(stats.earnings).some((total) => total.unpaid > 0))
        throw new BillingError(
            'This affiliate is still owed commission. Mark it paid first, or pause them instead.',
            409,
        );
    if (row.providerDiscountId) await deleteProviderDiscount(row.providerDiscountId);
    await growthRepository.deleteAffiliate(id);
    return { deleted: true as const };
}

export async function markAffiliatePaid(id: string) {
    if (!(await growthRepository.getAffiliate(id)))
        throw new BillingError('That affiliate does not exist.', 404);
    return { paid: await growthRepository.markEarningsPaid(id) };
}

export { billingEnabled };

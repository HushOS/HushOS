import { growthRepository } from '@hushos/db';
import { appEnv } from '@hushos/env/app';
import type {
    AffiliateEarningView,
    AffiliateInput,
    AffiliateLedgerStatus,
    AffiliateView,
    ClawbackSettlement,
    ExpectedPayouts,
    LedgerTotals,
    OfferLanding,
    OwnAffiliateView,
    ReferralLanding,
    ReferralSummary,
} from './api';
import { affiliateV2, ensureCutover } from './commission';
import {
    BillingError,
    billingEnabled,
    createProviderDiscount,
    deleteProviderDiscount,
    endProviderDiscount,
    findProviderDiscount,
    listCatalogue,
    reopenProviderDiscount,
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

type AffiliateRow = NonNullable<Awaited<ReturnType<typeof growthRepository.getAffiliate>>>;

/* The whole number a total is, for the figures older clients read; the ledger's strings are exact. */
const asNumber = (value: bigint) => Number(value);

/* A currency's totals as the API carries them, with what the next payout comes to. */
function ledgerView(ledger: Record<string, growthRepository.LedgerTotals>) {
    const view: Record<string, LedgerTotals> = {};
    for (const [currency, totals] of Object.entries(ledger)) {
        const { netted, payout } = growthRepository.payoutOf(totals);
        view[currency] = {
            earned: totals.earned.toString(),
            payable: totals.payable.toString(),
            held: totals.held.toString(),
            flagged: totals.flagged.toString(),
            paidOut: totals.paidOut.toString(),
            voided: totals.voided.toString(),
            lowered: totals.lowered.toString(),
            clawbackOpen: totals.clawbackOpen.toString(),
            clawbackUnconfirmed: totals.clawbackUnconfirmed.toString(),
            netted: netted.toString(),
            payout: payout.toString(),
        };
    }
    return view;
}

/*
 * Sign-ups, orders and money. With commission safety on the money comes from the ledger: unpaid
 * is everything recorded and not yet paid (payable, held and flagged; never a voided earning),
 * and paid is what was paid out.
 */
async function statsFor(
    row: AffiliateRow,
    known?: Awaited<ReturnType<typeof growthRepository.affiliateStats>>,
) {
    const stats = known ?? (await growthRepository.affiliateStats(row.id));
    if (!affiliateV2()) return { stats, ledger: null, recordKeptUntil: null };
    const now = new Date();
    const state = await growthRepository.getLedgerState();
    const rows = await growthRepository.listLedgerRows(row.id);
    const ledger = growthRepository.ledgerOf(rows, now, state?.cutoverAt ?? null);
    const earnings: typeof stats.earnings = {};
    for (const [currency, totals] of Object.entries(ledger))
        earnings[currency] = {
            unpaid: asNumber(totals.payable + totals.held + totals.flagged),
            paid: asNumber(totals.paidOut),
        };
    // Until when the record must stay: a refund or a lost dispute after a payout still needs its row.
    const lastPaid = rows.reduce(
        (latest, earning) => Math.max(latest, earning.paidAt?.getTime() ?? 0),
        0,
    );
    const keptUntil = lastPaid + growthRepository.AFFILIATE_RECORD_KEEP_DAYS * 24 * 60 * 60 * 1000;
    return {
        stats: { ...stats, earnings },
        ledger,
        recordKeptUntil: lastPaid && keptUntil > now.getTime() ? new Date(keptUntil) : null,
    };
}

async function view(
    row: Awaited<ReturnType<typeof growthRepository.getAffiliate>>,
    known?: Awaited<ReturnType<typeof growthRepository.affiliateStats>>,
) {
    if (!row) throw new BillingError('That affiliate does not exist.', 404);
    const { stats, ledger, recordKeptUntil } = await statsFor(row, known);
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
        pendingEmail: row.pendingEmail,
        notes: row.notes,
        providerDiscountId: row.providerDiscountId,
        createdAt: row.createdAt.toISOString(),
        stats,
        ...(ledger
            ? {
                  pausedAt: row.pausedAt?.toISOString() ?? null,
                  removedAt: row.removedAt?.toISOString() ?? null,
                  recordKeptUntil: recordKeptUntil?.toISOString() ?? null,
                  ledger: ledgerView(ledger),
              }
            : {}),
    } satisfies AffiliateView;
}

/*
 * The affiliate's own view, with commission safety on: built field by field, so nothing an
 * operator keeps about them (notes, the discount's id at Polar, a pending email) can reach it,
 * and in totals only, so no order, customer, flag or reason does either. A cut-over clawback no
 * operator has confirmed is not theirs to see yet.
 */
async function ownView(row: AffiliateRow) {
    const { stats, ledger } = await statsFor(row);
    const totals: NonNullable<OwnAffiliateView['totals']> = {};
    for (const [currency, of] of Object.entries(ledger ?? {}))
        totals[currency] = {
            earned: of.earned.toString(),
            paidOut: of.paidOut.toString(),
            payable: of.payable.toString(),
            held: of.held.toString(),
            underReview: of.flagged.toString(),
            reversed: (of.lowered + of.voided).toString(),
            toReturn: of.clawbackOpen.toString(),
        };
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
        createdAt: row.createdAt.toISOString(),
        stats,
        totals,
    } satisfies OwnAffiliateView;
}

export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
    const settings = referralSettings();
    const summary = await growthRepository.getReferralSummary(userId);
    // A creator enrolled under this account's email before it existed becomes its own here.
    await growthRepository.linkPendingAffiliates(userId);
    const all = await growthRepository.listAffiliatesForUser(userId);
    // A removed creator has no page or code left to show: their ledger is the operators'.
    const affiliates = affiliateV2() ? all.filter((row) => !row.removedAt) : all;
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
        affiliates: await Promise.all(
            affiliates.map((row) => (affiliateV2() ? ownView(row) : view(row))),
        ),
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

/*
 * A live creator's offer, by their slug or code, from the database alone: what
 * the offer's social card shows. It never asks Polar, so a crawler or anyone
 * guessing codes at /og/go-<code>.jpg cannot spend the organisation's Polar quota.
 */
export async function getAffiliateOffer(
    slug: string,
): Promise<Pick<OfferLanding, 'name' | 'code' | 'terms'> | null> {
    if (!OFFER.test(slug)) return null;
    const bySlug = SLUG.test(slug) ? await growthRepository.getAffiliateBySlug(slug) : null;
    const resolved = bySlug ? null : await growthRepository.resolveCode(slug);
    const affiliate = bySlug ?? (resolved?.kind === 'affiliate' ? resolved.affiliate : null);
    if (!affiliate?.active) return null;
    return { name: affiliate.name, code: affiliate.code, terms: affiliateTerms(affiliate) };
}

function affiliateTerms(affiliate: {
    percentOff: number;
    duration: 'once' | 'forever' | 'repeating';
    durationMonths: number | null;
}): OfferLanding['terms'] {
    return {
        type: 'percentage',
        percentOff: affiliate.percentOff,
        duration: affiliate.duration,
        durationMonths: affiliate.durationMonths,
    };
}

/*
 * The public offer page. `caller` names who is asking (their address) for the limit on looking up
 * unknown codes at Polar; past it the page is simply missing, as for a code that doesn't exist.
 */
export async function getOfferLanding(slug: string, caller: string): Promise<OfferLanding | null> {
    if (!OFFER.test(slug)) return null;
    const bySlug = SLUG.test(slug) ? await growthRepository.getAffiliateBySlug(slug) : null;
    const resolved = bySlug ? null : await growthRepository.resolveCode(slug);
    const affiliate = bySlug ?? (resolved?.kind === 'affiliate' ? resolved.affiliate : null);
    if (affiliate && affiliate.active)
        return {
            kind: 'affiliate',
            name: affiliate.name,
            code: affiliate.code,
            terms: affiliateTerms(affiliate),
            endsAt: null,
            productIds: [],
            catalogue: await listCatalogue(),
        };
    if (affiliate || resolved) return null;
    // A paused creator's slug and code are theirs still: no page, not the provider's code either.
    if (await growthRepository.findAffiliateByHandle(slug)) return null;
    const discount = await findProviderDiscount(slug, `address:${caller}`).catch(
        (error: unknown) => {
            if (error instanceof BillingError && error.status === 429) return null;
            throw error;
        },
    );
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
            : await findProviderDiscount(code, `user:${userId}`);
    if (!discount) throw new BillingError('That code is not valid.', 404);
    await growthRepository.rememberCoupon(userId, discount.code);
    return { code: discount.code };
}

export async function listAffiliates() {
    // The first thing an operator does with commission safety on is the cut-over, if nothing was yet.
    if (affiliateV2()) await ensureCutover();
    // Pending emails whose accounts now exist are linked before the operator sees them.
    await growthRepository.linkAllPendingAffiliates();
    const rows = await growthRepository.listAffiliates();
    return Promise.all(rows.map((row) => view(row, row.stats))) satisfies Promise<AffiliateView[]>;
}

/*
 * The creator's account, from the email an operator gave: linked now when an
 * account has it, else kept as pending and linked when that account signs up.
 * The caller has checked the address's form (the API uses the auth rule).
 */
async function accountForEmail(
    email: string | null | undefined,
    executor?: growthRepository.Executor,
) {
    const normalized = email?.trim().toLowerCase();
    if (!normalized) return { userId: null, pendingEmail: null };
    const userId = await growthRepository.findUserIdByEmail(normalized, executor);
    return userId ? { userId, pendingEmail: null } : { userId: null, pendingEmail: normalized };
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
    // Before the provider: a refused handle must not leave a discount behind at Polar.
    await assertHandleFree(slug, undefined, 'slug');
    await assertHandleFree(code, undefined, 'code');
    const account = await accountForEmail(input.userEmail);
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
        ...account,
        notes: input.notes?.trim() || null,
        providerDiscountId,
    });
    return view(row);
}

/*
 * A slug or code is one handle: the offer page resolves either, so neither may
 * be another affiliate's slug or code. `except` is the affiliate being edited,
 * whose own handles are free to it. The admin form asks this as the operator
 * types; saving asks again, and that answer is the one that counts.
 */
export async function isHandleFree(handle: string, except?: string) {
    return handleFree(handle, except);
}

/* The same rule, inside the affiliate's lock: through its transaction. */
async function handleFree(
    handle: string,
    except: string | undefined,
    executor?: growthRepository.Executor,
) {
    return !(await growthRepository.findAffiliateByHandle(handle, except, executor));
}

async function assertHandleFree(
    handle: string,
    except: string | undefined,
    what: 'slug' | 'code',
    executor?: growthRepository.Executor,
) {
    if (!(await handleFree(handle, except, executor)))
        throw new BillingError(`That ${what} belongs to another affiliate.`);
}

/* What the enrolment form sets about the offer; a patch naming none of them leaves them alone. */
const TERMS = [
    'name',
    'slug',
    'code',
    'percentOff',
    'duration',
    'durationMonths',
    'commissionBps',
] as const satisfies readonly (keyof AffiliateInput)[];

/*
 * Edits an affiliate. Everything the enrolment form set can change; the code
 * and the discount's terms change at the provider first, so the row never
 * promises what a checkout will not apply. The slug is this site's alone.
 */
export async function updateAffiliate(
    id: string,
    patch: Partial<AffiliateInput> & { active?: boolean },
): Promise<AffiliateView> {
    // Pause, unlink and notes name no term: they write their own columns only, outside
    // the lock, and cannot put back terms a save changed while they ran.
    if (!TERMS.some((key) => patch[key] !== undefined)) {
        const current = await growthRepository.getAffiliate(id);
        if (!current) throw new BillingError('That affiliate does not exist.', 404);
        refuseRemoved(current);
        const row = await growthRepository.updateAffiliate(id, await otherChanges(patch, current));
        return withDiscountNotice(await view(row), current, patch);
    }
    // A change of terms holds the affiliate's lock from its read to its write, so the
    // provider and the row end on the same terms whichever of two saves came first.
    let before: AffiliateRow | null = null;
    const row = await underAffiliateLock(id, async (tx) => {
        const row = await growthRepository.getAffiliate(id, tx);
        if (!row) throw new BillingError('That affiliate does not exist.', 404);
        refuseRemoved(row);
        before = row;
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
        if (slug !== row.slug) await assertHandleFree(slug, id, 'slug', tx);
        if (code !== row.code) await assertHandleFree(code, id, 'code', tx);
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
        // The whole term set, as the provider was just sent it.
        return growthRepository.updateAffiliate(
            id,
            {
                name,
                slug,
                code,
                percentOff: merged.percentOff,
                duration: merged.duration,
                durationMonths,
                commissionBps: merged.commissionBps,
                ...(await otherChanges(patch, row, tx)),
            },
            tx,
        );
    });
    return withDiscountNotice(await view(row), before, patch);
}

/* With commission safety on a removed affiliate's record is kept, and is not to be changed or resumed. */
function refuseRemoved(row: AffiliateRow) {
    if (affiliateV2() && row.removedAt)
        throw new BillingError('That affiliate was removed. Their record can’t be changed.', 409);
}

/*
 * After a pause or a resume with commission safety on: Polar is asked to end the discount now, or
 * to take that end off again, and the answer says when it would not. The pause itself has
 * already been written and stands either way: it is what stops the earning.
 */
async function withDiscountNotice(
    answer: AffiliateView,
    before: AffiliateRow | null,
    patch: { active?: boolean },
): Promise<AffiliateView> {
    if (!affiliateV2() || patch.active === undefined || !before) return answer;
    if (before.active === patch.active || !before.providerDiscountId) return answer;
    if (patch.active)
        return (await reopenProviderDiscount(before.providerDiscountId))
            ? answer
            : { ...answer, discountNotice: 'still-ended' };
    return (await endProviderDiscount(before.providerDiscountId))
        ? answer
        : { ...answer, discountNotice: 'still-live' };
}

/*
 * The affiliate's lock, for a change of terms or a removal. Every read inside
 * goes through `tx`. A lock already held is a plain refusal, at once, to retry.
 */
async function underAffiliateLock<T>(
    id: string,
    run: Parameters<typeof growthRepository.withAffiliateLock<T>>[1],
) {
    try {
        return await growthRepository.withAffiliateLock(id, run);
    } catch (error) {
        if (error instanceof growthRepository.AffiliateBusyError)
            throw new BillingError('This affiliate is being changed. Try again in a moment.', 409, {
                cause: error,
            });
        throw error;
    }
}

/*
 * The columns a patch sets besides the terms: notes, the account, and whether it is live. With
 * commission safety on a pause is written with its time, and a resume clears it; pausing someone
 * already paused keeps the time they were first paused.
 */
async function otherChanges(
    patch: Partial<AffiliateInput> & { active?: boolean },
    current: AffiliateRow,
    executor?: growthRepository.Executor,
) {
    const changes: Parameters<typeof growthRepository.updateAffiliate>[1] = {};
    if (patch.notes !== undefined) changes.notes = patch.notes?.trim() || null;
    if (patch.userEmail !== undefined)
        Object.assign(changes, await accountForEmail(patch.userEmail, executor));
    if (patch.active !== undefined) {
        changes.active = patch.active;
        if (affiliateV2())
            changes.pausedAt = patch.active ? null : (current.pausedAt ?? new Date());
    }
    return changes;
}

/*
 * Removes an affiliate: the discount at the provider first, so the code stops
 * applying at checkout even if the row outlives it, then the row, with the
 * attributions and the ledger of what was paid. Commission still owed blocks it.
 *
 * With commission safety on the record and its ledger are kept instead (`removeAffiliate`).
 */
export async function deleteAffiliate(id: string) {
    if (affiliateV2()) return removeAffiliate(id);
    // Commission safety was on here once and is off now: removing as before would delete a
    // ledger that holds dispute records and clawbacks. Nothing to ask where it never was on.
    if (await growthRepository.getLedgerState())
        throw new BillingError(
            'Commission safety was turned on for this server and is off now. Turn it on again to remove an affiliate: with it off, removing one deletes their ledger.',
            409,
        );
    // Under the affiliate's lock: a removal never interleaves with a change of terms.
    return underAffiliateLock(id, async (tx) => {
        // Locked before anything owed is counted: an earning recorded while Polar deletes the
        // discount waits for this removal, then fails where the webhook sees it, rather than
        // being deleted with the affiliate after the count found nothing owed.
        const row = await growthRepository.getAffiliate(id, tx, { forUpdate: true });
        if (!row) throw new BillingError('That affiliate does not exist.', 404);
        const stats = await growthRepository.affiliateStats(id, tx);
        if (Object.values(stats.earnings).some((total) => total.unpaid > 0))
            throw new BillingError(
                'This affiliate is still owed commission. Mark it paid first, or pause them instead.',
                409,
            );
        if (row.providerDiscountId) await deleteProviderDiscount(row.providerDiscountId);
        await growthRepository.deleteAffiliate(id, tx);
        return { deleted: true as const };
    });
}

const LEDGER_OPEN =
    'This affiliate still has commission that is owed, held or flagged, or a clawback that is not settled. Pay, void or settle each one first, or pause them instead.';

/*
 * Removes an affiliate with commission safety on: their page and code go, the discount is ended
 * at Polar as a pause ends it (never deleted), nothing ties or earns from then on, and the row
 * and its ledger stay, with its dispute records and settled clawbacks. Refused while anything is
 * owed, held or flagged, or a clawback is not settled.
 */
async function removeAffiliate(id: string) {
    return underAffiliateLock(id, async (tx) => {
        // Locked first, as above: an earning recorded meanwhile waits, then finds them removed.
        const row = await growthRepository.getAffiliate(id, tx, { forUpdate: true });
        if (!row) throw new BillingError('That affiliate does not exist.', 404);
        if (row.removedAt) throw new BillingError('That affiliate was already removed.', 409);
        const now = new Date();
        if (
            growthRepository.ledgerBlocksRemoval(
                await growthRepository.affiliateLedger(id, now, tx),
            )
        )
            throw new BillingError(LEDGER_OPEN, 409);
        await growthRepository.updateAffiliate(
            id,
            { active: false, pausedAt: row.pausedAt ?? now, removedAt: now },
            tx,
        );
        if (row.providerDiscountId) await endProviderDiscount(row.providerDiscountId);
        return { deleted: true as const };
    });
}

/*
 * Deletes a removed affiliate's record for good, with the attributions and the ledger. Only once
 * they were removed, nothing on the ledger is owed, held, flagged or unsettled, and no earning
 * was paid in the last AFFILIATE_RECORD_KEEP_DAYS: until then a refund or a lost dispute on a
 * paid order must still find its earning, or the money to take back is never recorded. The check
 * holds every earning locked until the delete, so nothing changes between the two. The operators'
 * page downloads the ledger first. The discount at Polar is left ended, never deleted.
 */
export async function deleteAffiliateRecord(id: string) {
    requireV2();
    return underAffiliateLock(id, async (tx) => {
        const row = await growthRepository.getAffiliate(id, tx, { forUpdate: true });
        if (!row) throw new BillingError('That affiliate does not exist.', 404);
        if (!row.removedAt)
            throw new BillingError(
                'Remove this affiliate first. Then their record can be deleted.',
                409,
            );
        const block = await growthRepository.recordDeletionBlock(tx, id);
        if (block?.reason === 'open') throw new BillingError(LEDGER_OPEN, 409);
        if (block?.reason === 'paid')
            throw new BillingError(
                `They were paid in the last ${growthRepository.AFFILIATE_RECORD_KEEP_DAYS} days. Their record can be deleted from ${block.from.toISOString().slice(0, 10)}: until then a refund or a lost dispute on an order they were paid for must still find its earning.`,
                409,
            );
        await growthRepository.deleteAffiliate(id, tx);
        return { deleted: true as const };
    });
}

/*
 * An operator has paid the affiliate. Without commission safety, everything unpaid is marked.
 * With it, only what may be paid (past its hold, not flagged, not voided), and what open
 * clawbacks took of the payout is applied to them by amount. `expected` is what the operator was
 * shown and is required then; if the ledger has moved since, nothing is marked and they are told
 * to look again.
 */
export async function markAffiliatePaid(
    id: string,
    input: { by?: string | null; expected?: ExpectedPayouts } = {},
) {
    if (!(await growthRepository.getAffiliate(id)))
        throw new BillingError('That affiliate does not exist.', 404);
    if (!affiliateV2()) return { paid: await growthRepository.markEarningsPaid(id) };
    // What was sent is what the operator was shown: without those figures nothing is marked.
    if (!input.expected)
        throw new BillingError(
            'Say which amounts you paid: reload the page and mark it paid from the figures it shows.',
        );
    try {
        const result = await growthRepository.settlePayout(id, {
            by: input.by ?? null,
            expected: input.expected,
        });
        return {
            paid: result.paid,
            payouts: Object.fromEntries(
                Object.entries(result.payouts).map(([currency, payout]) => [
                    currency,
                    {
                        owed: payout.owed.toString(),
                        netted: payout.netted.toString(),
                        payout: payout.payout.toString(),
                    },
                ]),
            ),
        };
    } catch (error) {
        if (error instanceof growthRepository.PayoutChangedError)
            throw new BillingError(
                'The amounts changed since this page loaded. Check the figures, then mark it paid again.',
                409,
                { cause: error },
            );
        throw error;
    }
}

/* The routes below exist only with commission safety on. */
function requireV2() {
    if (!affiliateV2()) throw new BillingError('That is not available on this server.', 404);
}

/*
 * Whether commission safety is on, how long a new earning is held, and when the daily run last
 * read Polar's disputes and the refunds, so a run that has stopped working is seen on the page.
 */
export async function affiliateLedgerStatus(): Promise<AffiliateLedgerStatus> {
    if (!affiliateV2()) return { enabled: false };
    const state = await ensureCutover();
    return {
        enabled: true,
        holdDays: growthRepository.AFFILIATE_HOLD_DAYS,
        recordKeepDays: growthRepository.AFFILIATE_RECORD_KEEP_DAYS,
        since: state.cutoverAt.toISOString(),
        disputes: {
            readAt: state.disputesReadAt?.toISOString() ?? null,
            failure: state.disputesFailure,
        },
        refunds: { readAt: state.refundsReadAt?.toISOString() ?? null },
    };
}

/* One affiliate's earnings, newest first, as the operators' ledger and its download show them. */
export async function listAffiliateEarnings(id: string): Promise<AffiliateEarningView[]> {
    requireV2();
    if (!(await growthRepository.getAffiliate(id)))
        throw new BillingError('That affiliate does not exist.', 404);
    const now = new Date();
    const { cutoverAt } = await ensureCutover();
    const rows = await growthRepository.listLedgerRows(id);
    return rows.map((row) => ({
        id: row.id,
        orderId: row.orderId,
        userId: row.userId,
        currency: row.currency,
        recordedAt: row.createdAt.toISOString(),
        net: row.netAmount.toString(),
        pot: (row.potAmount ?? row.commissionAmount).toString(),
        left: row.commissionAmount.toString(),
        state: growthRepository.earningState(row, now, cutoverAt),
        payableAt: row.payableAt?.toISOString() ?? null,
        paidAt: row.paidAt?.toISOString() ?? null,
        paid: row.paidAt ? (row.paidAmount ?? row.commissionAmount).toString() : null,
        refunded: row.refundedAmount.toString(),
        dispute: row.disputeStatus,
        flag:
            row.flag && !row.flagReleasedAt
                ? row.flag
                : growthRepository.disputeOpen(row.disputeStatus)
                  ? 'dispute'
                  : null,
        clawback:
            row.clawbackAmount > 0n || row.clawbackSettledAmount > 0n
                ? {
                      amount: row.clawbackAmount.toString(),
                      open: growthRepository.clawbackOpen(row).toString(),
                      settled: row.clawbackSettledAmount.toString(),
                      writtenOff: row.clawbackWrittenOffAmount.toString(),
                      cutover: row.clawbackOrigin === 'cutover',
                      confirmed:
                          row.clawbackOrigin !== 'cutover' || Boolean(row.clawbackConfirmedAt),
                      settledAt: row.clawbackSettledAt?.toISOString() ?? null,
                      note: row.clawbackNote,
                  }
                : null,
        voidedAt: row.voidedAt?.toISOString() ?? null,
        voidReason: row.voidReason,
    }));
}

const NO_EARNING = 'That earning does not exist.';

/* An operator voids one earning, with a reason: for fraud that neither a refund nor a dispute shows. */
export async function voidAffiliateEarning(
    id: string,
    earningId: string,
    input: { by: string; reason: string },
) {
    requireV2();
    const reason = input.reason.trim();
    if (!reason || reason.length > 500)
        throw new BillingError('Say why this earning is voided, in up to 500 characters.');
    const outcome = await growthRepository.voidEarning(id, earningId, { by: input.by, reason });
    if (outcome === 'missing') throw new BillingError(NO_EARNING, 404);
    if (outcome === 'paid')
        throw new BillingError(
            'This earning was already paid, so it can’t be voided. Money paid out is taken back as a clawback, after a refund or a lost dispute.',
            409,
        );
    return { done: true as const };
}

/* An operator has looked at a flagged earning and lets it be paid. */
export async function releaseAffiliateEarning(id: string, earningId: string, by: string) {
    requireV2();
    const outcome = await growthRepository.releaseEarningFlag(id, earningId, { by });
    if (outcome === 'missing') throw new BillingError(NO_EARNING, 404);
    if (outcome === 'unflagged')
        throw new BillingError(
            'Nothing on this earning is yours to release. One held for a dispute is released when the dispute closes.',
            409,
        );
    return { done: true as const };
}

/* An operator says yes to one clawback the cut-over made. */
export async function confirmAffiliateClawback(id: string, earningId: string, by: string) {
    requireV2();
    const outcome = await growthRepository.confirmClawback(id, earningId, { by });
    if (outcome === 'missing') throw new BillingError(NO_EARNING, 404);
    if (outcome === 'none')
        throw new BillingError('This earning has no clawback waiting to be confirmed.', 409);
    return { done: true as const };
}

/* An operator settles a clawback by hand: an amount repaid, or what is open written off with a note. */
export async function settleAffiliateClawback(
    id: string,
    earningId: string,
    input: ClawbackSettlement & { by: string },
) {
    requireV2();
    const note = input.note?.trim() || null;
    if (note && note.length > 500) throw new BillingError('A note is up to 500 characters.');
    let outcome: Awaited<ReturnType<typeof growthRepository.settleClawback>>;
    if (input.kind === 'written-off') {
        if (!note) throw new BillingError('Say why this is written off.');
        outcome = await growthRepository.settleClawback(id, earningId, {
            kind: 'written-off',
            note,
            by: input.by,
        });
    } else {
        if (!/^[1-9][0-9]{0,17}$/.test(input.amount))
            throw new BillingError('Give the amount repaid, in the currency’s smallest unit.');
        outcome = await growthRepository.settleClawback(id, earningId, {
            kind: 'repaid',
            amount: BigInt(input.amount),
            note,
            by: input.by,
        });
    }
    if (outcome === 'missing') throw new BillingError(NO_EARNING, 404);
    if (outcome === 'none') throw new BillingError('Nothing is open on this clawback.', 409);
    if (outcome === 'amount')
        throw new BillingError('That is more than is open on this clawback.', 409);
    return { done: true as const };
}

export { billingEnabled };

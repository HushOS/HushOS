import type { BillingSummary, Catalogue, FamilyPlan } from '@hushos/billing/api';
import { DEFAULT_CURRENCY } from '@hushos/billing/protocol';
import { checkGroupName, GROUP_NAME_MAX } from '@hushos/groups/protocol';
import { pickCurrency, type LocaleHint } from '@/lib/currency';
import { currenciesOf, familyPrice } from '@/lib/plans';

/*
 * Signing up for a family plan from the pricing page: the tier rides along as the signup's
 * plan, sign-up says what it is, and once the account is set up and unlocked the app opens
 * Create a family with that tier, its name already filled in, one click from checkout.
 */

const SUFFIX = '’s family';

/* `text` cut to at most `max` code points, at a character (grapheme) boundary. */
function cutTo(text: string, max: number) {
    let kept = '';
    let count = 0;
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
        text,
    )) {
        const size = Array.from(segment).length;
        if (count + size > max) break;
        kept += segment;
        count += size;
    }
    return kept;
}

/*
 * The name Create a family suggests: the account's name, "Sam Ortega’s family", else "My
 * family". Only a suggestion: it stays editable in the dialog, and the family can be renamed
 * later. An account's name may hold anything, so it is made into one the server accepts as it
 * is (checkGroupName, the server's own rule): any run of whitespace is one space, characters
 * the server refuses (controls, and invisible marks such as a zero-width non-joiner, bidi
 * marks or an emoji's joiners) are left out, and a long name is cut, at a character, so that
 * "’s family" still fits.
 */
export function defaultFamilyName(accountName: string | null | undefined) {
    const clean = (accountName ?? '')
        .normalize('NFC')
        .replace(/\s+/gu, ' ')
        .replace(/\p{C}/gu, '')
        .replace(/ {2,}/g, ' ')
        .trim()
        .normalize('NFC');
    const name = cutTo(clean, GROUP_NAME_MAX - Array.from(SUFFIX).length).trim();
    const suggested = `${name}${SUFFIX}`;
    return name && checkGroupName(suggested) === suggested ? suggested : 'My family';
}

/*
 * The currency a family tier is shown and charged in after signup: the one Pricing showed it
 * in (`shown`, carried in the signup's intent), else the one the visitor's country or language
 * suggests, out of those every personal plan is priced in (as sign-up
 * shows a personal plan), and the tier's default where it has no price in it. Sign-up and
 * Create a family both use it, so the price said at sign-up is the one checkout asks for.
 */
export function familySignupCurrency(
    catalogue: Pick<Catalogue, 'plans'>,
    plan: FamilyPlan,
    hint: LocaleHint | null | undefined,
    // The currency Pricing showed the tier in, carried through signup: it wins where the tier is
    // priced in it, so the price said on Pricing and at signup is the one checkout asks for.
    shown?: string | null,
) {
    if (shown && Object.hasOwn(plan.prices, shown)) return shown;
    const currencies = currenciesOf(catalogue.plans);
    const currency = pickCurrency({
        hint,
        available: currencies,
        fallback: currencies[0] ?? DEFAULT_CURRENCY,
    });
    return familyPrice(plan, currency)?.currency ?? null;
}

/* A family as the account's list of families gives it (route 2's GroupSummary). */
type Membership = { id: string; name: string; kind: string; state: string };

/*
 * Where an account stands with families: in one (`active`), waiting to join one (`accepted`:
 * they accepted an invitation and aren't let in yet), or in none (a family left or removed
 * from is none). Waiting to join counts as having a family for everything that would offer a
 * new one: they are about to be in one, and a second would be refused once they're let in.
 */
export type FamilyStanding<T extends Membership = Membership> =
    | { kind: 'in'; family: T }
    | { kind: 'waiting'; family: T }
    | { kind: 'none' };

export function familyStanding<T extends Membership>(families: readonly T[]): FamilyStanding<T> {
    const of = (state: string) =>
        families.find((family) => family.kind === 'family' && family.state === state);
    const active = of('active');
    if (active) return { kind: 'in', family: active };
    const accepted = of('accepted');
    return accepted ? { kind: 'waiting', family: accepted } : { kind: 'none' };
}

/*
 * The currency Create a family charges a tier in: the one its address names (Pricing, Plans or
 * the landing after signup) when the tier is priced in it, else the tier's default. An address
 * edited by hand never reaches checkout with a currency the tier isn't sold in.
 */
export function familyCheckoutCurrency(plan: FamilyPlan, requested: string | undefined) {
    if (requested && Object.hasOwn(plan.prices, requested)) return requested;
    return familyPrice(plan, DEFAULT_CURRENCY)?.currency ?? Object.keys(plan.prices)[0]!;
}

export type FamilyLanding =
    | { to: '/app/billing' }
    | { to: '/app/family'; search?: { create: string; currency: string } };

/*
 * Where the first visit after signing up for a family tier goes:
 * - families not served here (any more): Plans, where the personal plans are;
 * - in a family, or waiting to join one: the family page, which shows that family or how to
 *   finish joining, never a second family;
 * - the tier still offered: Create a family with it, priced as sign-up priced it
 *   (familySignupCurrency);
 * - otherwise (no longer offered, or priced in nothing): Plans.
 */
export function familyLanding(input: {
    tier: string;
    /* The currency Pricing showed the tier in, if signup carried one. */
    currency?: string | null;
    groupsEnabled: boolean;
    families: readonly Membership[];
    catalogue: Pick<Catalogue, 'plans' | 'families'>;
    hint: LocaleHint | null | undefined;
}): FamilyLanding {
    if (!input.groupsEnabled) return { to: '/app/billing' };
    if (familyStanding(input.families).kind !== 'none') return { to: '/app/family' };
    const plan = input.catalogue.families.find((candidate) => candidate.id === input.tier);
    const currency =
        plan && familySignupCurrency(input.catalogue, plan, input.hint, input.currency);
    if (!plan || !currency) return { to: '/app/billing' };
    return { to: '/app/family', search: { create: plan.id, currency } };
}

/* What the first landing after setup reads, and how it forgets the tier: injected, for tests. */
export type FirstLandingDeps = {
    summary: () => Promise<Pick<BillingSummary, 'intendedPlan' | 'intendedFamily'>>;
    capabilities: () => Promise<{ groups?: boolean }>;
    catalogue: () => Promise<Pick<Catalogue, 'plans' | 'families'>>;
    hint: () => Promise<LocaleHint | null>;
    families: () => Promise<readonly Membership[]>;
    forget: () => Promise<unknown>;
    /* Whether the person is still where they were when the landing began. */
    stillHere: () => boolean;
    log: (message: string, error: unknown) => void;
};

export type FirstLanding =
    | { kind: 'stay' }
    | { kind: 'checkout'; plan: string }
    | { kind: 'go'; to: FamilyLanding };

/*
 * The first landing once an account is set up and unlocked (the app layout runs it on every
 * visit): a personal plan chosen at signup goes on to its checkout; a family tier goes where
 * familyLanding says, once, the server forgetting it so the next visit goes where the person
 * chooses. Without a summary nothing happens, and the next visit tries again. A place the
 * person went to while it read wins: it never moves them from there.
 */
export async function firstLanding(deps: FirstLandingDeps): Promise<FirstLanding> {
    const summary = await deps.summary().catch(() => null);
    if (summary?.intendedFamily) {
        // Each of these decides where the tier goes. One that can't be read (offline, a server
        // hiccup) would send the person somewhere wrong and lose the tier for good, so nothing
        // moves and nothing is forgotten: the next visit tries again. The locale hint only
        // picks a currency, so without it the plans' default does.
        try {
            const [capabilities, catalogue, hint] = await Promise.all([
                deps.capabilities(),
                deps.catalogue(),
                deps.hint().catch(() => null),
            ]);
            const groupsEnabled = capabilities.groups === true;
            const families = groupsEnabled ? await deps.families() : [];
            const to = familyLanding({
                tier: summary.intendedFamily.plan,
                currency: summary.intendedFamily.currency,
                groupsEnabled,
                families,
                catalogue,
                hint,
            });
            // The person went somewhere meanwhile: that wins. The tier is kept, so they get
            // Create a family on a later visit, when they aren't on their way elsewhere.
            if (!deps.stillHere()) return { kind: 'stay' };
            // A forget that fails only means the next visit lands here again.
            await deps
                .forget()
                .catch((error: unknown) =>
                    deps.log('The family plan chosen at signup could not be forgotten.', error),
                );
            return deps.stillHere() ? { kind: 'go', to } : { kind: 'stay' };
        } catch {
            return { kind: 'stay' };
        }
    }
    return summary?.intendedPlan
        ? { kind: 'checkout', plan: summary.intendedPlan }
        : { kind: 'stay' };
}

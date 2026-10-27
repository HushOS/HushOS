import type { Catalogue, FamilyPlan } from '@hushos/billing/api';
import { DEFAULT_CURRENCY } from '@hushos/billing/protocol';
import { pickCurrency, type LocaleHint } from '@/lib/currency';
import { currenciesOf, familyPrice } from '@/lib/plans';

/*
 * Signing up for a family plan from the pricing page: the tier rides along as the signup's
 * plan, sign-up says what it is, and once the account is set up and unlocked the app opens
 * Create a family with that tier, its name already filled in, one click from checkout.
 */

/* Create a family's name field caps a name at this. */
const NAME_LIMIT = 100;

/*
 * The name Create a family suggests: the account's first name, "Sam’s family", else "My
 * family". Only a suggestion: it stays editable in the dialog, and the family can be
 * renamed later.
 */
export function defaultFamilyName(accountName: string | null | undefined) {
    const first = accountName?.trim().split(/\s+/)[0] ?? '';
    const name = `${first}’s family`;
    return first && name.length <= NAME_LIMIT ? name : 'My family';
}

/*
 * The currency a family tier is shown and charged in after signup: the one the visitor's
 * country or language suggests, out of those every personal plan is priced in (as sign-up
 * shows a personal plan), and the tier's default where it has no price in it. Sign-up and
 * Create a family both use it, so the price said at sign-up is the one checkout asks for.
 */
export function familySignupCurrency(
    catalogue: Pick<Catalogue, 'plans'>,
    plan: FamilyPlan,
    hint: LocaleHint | null | undefined,
) {
    const currencies = currenciesOf(catalogue.plans);
    const currency = pickCurrency({
        hint,
        available: currencies,
        fallback: currencies[0] ?? DEFAULT_CURRENCY,
    });
    return familyPrice(plan, currency)?.currency ?? null;
}

export type FamilyLanding =
    | { to: '/app/billing' }
    | { to: '/app/family'; search?: { create: string; currency: string } };

/*
 * Where the first visit after signing up for a family tier goes:
 * - families not served here (any more): Plans, where the personal plans are;
 * - already in a family (`inFamily`; undefined while unknown): that family's page, never a
 *   second family;
 * - the tier still offered: Create a family with it, priced as sign-up priced it
 *   (familySignupCurrency);
 * - otherwise (no longer offered, or priced in nothing): Plans.
 * With the families unread, the family page decides which is true: it shows the family if
 * there is one, and Create a family only to someone in none.
 */
export function familyLanding(input: {
    tier: string;
    groupsEnabled: boolean;
    inFamily: boolean | undefined;
    catalogue: Pick<Catalogue, 'plans' | 'families'>;
    hint: LocaleHint | null | undefined;
}): FamilyLanding {
    if (!input.groupsEnabled) return { to: '/app/billing' };
    if (input.inFamily) return { to: '/app/family' };
    const plan = input.catalogue.families.find((candidate) => candidate.id === input.tier);
    const currency = plan && familySignupCurrency(input.catalogue, plan, input.hint);
    if (!plan || !currency) return { to: '/app/billing' };
    return { to: '/app/family', search: { create: plan.id, currency } };
}

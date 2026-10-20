/* Product metadata keys read from the provider's catalogue. */
export const PLAN_METADATA_KEY = 'hushos_plan';
export const QUOTA_METADATA_KEY = 'quota_bytes';
export const RECOMMENDED_METADATA_KEY = 'hushos_recommended';

/*
 * Group plans (docs/groups-design.md 3.5). A product carrying
 * `hushos_group_kind` is a group plan and never a personal one. A family plan
 * is a fixed base price plus a graduated unit price per currency, free up to
 * `included_members` and then a per-member rate. Its `quota_bytes` is the
 * whole family's pool, fixed whatever the member count: a family product that
 * also carries `quota_bytes_per_member` (the Business shape, whose pool grows
 * with each paid member) is not offered as a family plan.
 */
export const GROUP_KIND_METADATA_KEY = 'hushos_group_kind';
export const INCLUDED_MEMBERS_METADATA_KEY = 'included_members';
export const QUOTA_PER_MEMBER_METADATA_KEY = 'quota_bytes_per_member';

/*
 * Which family tier a product is (Family Plus, Pro or Max): `hushos_tier` on
 * both its monthly and yearly product. Tiers are ordered by their pool, never
 * by this key; the key names the tier for the seed and the operator. A family
 * product without one is the single Family plan that came before the tiers,
 * kept readable for anyone still on it; one with any other value is dropped.
 */
export const TIER_METADATA_KEY = 'hushos_tier';
export const FAMILY_TIERS = ['plus', 'pro', 'max'] as const;
export type FamilyTier = (typeof FAMILY_TIERS)[number];

/*
 * What a personal plan's Polar status means (docs/self-hosting.md, Billing). Only a
 * live plan gives its storage and is "the current plan" for a switch, a cancel or a
 * resume; `past_due` is Polar still retrying a renewal. `unpaid` (Polar's retries ran
 * out), `incomplete` (a first payment that never went through) and `paused` are not
 * ended, since a payment or a resume can bring them back, but give nothing: the
 * person is on Free meanwhile, and a new checkout revokes such a plan first.
 */
export const LIVE_PLAN_STATUSES = ['active', 'trialing', 'past_due'] as const;
export type PlanStanding = 'live' | 'payment-failed' | 'paused' | 'ended';

export function planStanding(plan: {
    status: string;
    endedAt: string | Date | null;
}): PlanStanding {
    if (plan.endedAt) return 'ended';
    if ((LIVE_PLAN_STATUSES as readonly string[]).includes(plan.status)) return 'live';
    if (plan.status === 'unpaid' || plan.status === 'incomplete') return 'payment-failed';
    if (plan.status === 'paused') return 'paused';
    // `canceled`, `incomplete_expired`, or a status Polar adds later: nothing to offer.
    return 'ended';
}

/* The plan if it is live, else null. */
export function livePlan<T extends { status: string; endedAt: string | Date | null }>(
    plan: T | null | undefined,
): T | null {
    return plan && planStanding(plan) === 'live' ? plan : null;
}

/* The plan if Polar still holds it but it gives nothing (a failed payment, a pause), else null. */
export function lapsedPlan<T extends { status: string; endedAt: string | Date | null }>(
    plan: T | null | undefined,
): T | null {
    const standing = plan ? planStanding(plan) : 'ended';
    return standing === 'payment-failed' || standing === 'paused' ? plan! : null;
}

/* A group's customer at the provider is keyed `group:<groupId>`; a person's by their user id. */
export const GROUP_CUSTOMER_PREFIX = 'group:';

/*
 * Polar enforces no unit cap (docs/polar-group-billing-spike.md, E7), and a
 * raise is charged at once, so HushOS bounds them: a family has at most this
 * many members, and one raise adds at most this many places. A deliberate
 * larger family goes through support.
 */
export const FAMILY_MAX_MEMBERS = 20;
export const MAX_MEMBERS_PER_RAISE = 5;

/*
 * Seats a group has with billing on and no live plan: its organizer alone.
 * Members are admitted only into places a plan has paid for.
 */
export const UNPAID_GROUP_SEATS = 1;

/*
 * A raise whose order still waits for the bank after this many days is cut
 * back, at the period's end, to the places paid for: the payer never
 * confirmed it, so a renewal must not bill it. Seven days leaves a payer a
 * week to answer their bank (a 3-D Secure or e-mandate prompt).
 */
export const STALE_RAISE_DAYS = 7;

/*
 * What Polar charges at once for going from `fromUnits` to `toUnits` places,
 * before tax: the added per-member amount for the part of the period left,
 * prorated by the second and truncated to the minor unit, as Polar does
 * (spike E4: 200 at 0.99994 of a month left was charged 199; 2000 at 0.999994
 * of a year, 1999). Places within the included members cost nothing; a cut
 * costs nothing now and refunds nothing.
 */
export function quoteUnitsChange(input: {
    perMember: number;
    includedMembers: number;
    fromUnits: number;
    toUnits: number;
    periodStart: Date;
    periodEnd: Date;
    now?: Date;
}) {
    const billable = (units: number) => Math.max(0, units - input.includedMembers);
    const added = billable(input.toUnits) - billable(input.fromUnits);
    const total = Math.floor((input.periodEnd.getTime() - input.periodStart.getTime()) / 1000);
    if (added <= 0 || total <= 0) return 0;
    const now = (input.now ?? new Date()).getTime();
    const left = Math.min(total, Math.max(0, Math.floor((input.periodEnd.getTime() - now) / 1000)));
    return Number((BigInt(added) * BigInt(input.perMember) * BigInt(left)) / BigInt(total));
}

/*
 * About what Polar charges at once for moving a family to a bigger tier of the
 * same billing period with `invoice` proration, before tax. The period does
 * not restart (spike 8, T2): Polar charges each price of the new plan (the
 * base, and the members past those included) for the part of the period left
 * and credits each of the old plan's, by the second, every line rounded to the
 * nearest minor unit (a plan change's lines round; a raise's truncate). T2:
 * 3000 against 2000 with 0.98961 of the period left was 990 net. The page
 * still says "about": tax, and Polar's exact second, come on top. A move to a
 * smaller tier waits for the renewal and costs nothing now.
 */
export function quoteTierChange(input: {
    from: { base: number; perMember: number; includedMembers: number };
    to: { base: number; perMember: number; includedMembers: number };
    units: number;
    periodStart: Date;
    periodEnd: Date;
    now?: Date;
}) {
    const total = BigInt(
        Math.floor((input.periodEnd.getTime() - input.periodStart.getTime()) / 1000),
    );
    if (total <= 0n) return 0;
    const now = (input.now ?? new Date()).getTime();
    const left = BigInt(
        Math.min(Number(total), Math.max(0, Math.floor((input.periodEnd.getTime() - now) / 1000))),
    );
    // One line, prorated and rounded half up to the minor unit.
    const line = (amount: number) => (BigInt(amount) * left * 2n + total) / (2n * total);
    const lines = (plan: typeof input.from) =>
        line(plan.base) + line(plan.perMember * Math.max(0, input.units - plan.includedMembers));
    const charge = lines(input.to) - lines(input.from);
    return charge > 0n ? Number(charge) : 0;
}

const GIB = 1024n ** 3n;

/*
 * Space as the app writes it (in 1024s, labelled GB and TB, at most two
 * decimals), either to the nearest hundredth or, for how much to free, rounded
 * up so freeing it is always enough: "1.2 TB", "428.01 GB", "0.01 MB". Shared,
 * so the page and the server's refusal give the same figures.
 */
export function spaceOf(bytes: bigint, round: 'nearest' | 'up' = 'nearest') {
    const unit = bytes >= 1024n * GIB ? 1024n * GIB : bytes >= GIB ? GIB : 1024n * 1024n;
    const label = unit === GIB ? 'GB' : unit === GIB * 1024n ? 'TB' : 'MB';
    const hundredths =
        round === 'up' ? (bytes * 100n + unit - 1n) / unit : (bytes * 100n + unit / 2n) / unit;
    const whole = hundredths / 100n;
    const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''} ${label}`;
}

/* A plan's name without its billing period: "Family Pro (monthly)" is "Family Pro". */
export const planTierName = (plan: { name: string }) =>
    plan.name.replace(/\s*\((monthly|yearly|annual)\)\s*$/i, '');

/* Bytes in whole GiB, rounded up: nothing is 0, and anything up to 1 GiB is 1 GiB. */
const wholeGibUp = (bytes: bigint) => (bytes <= 0n ? 0n : ((bytes + GIB - 1n) / GIB) * GIB);

/*
 * Why a family's first plan (or one bought again) is refused: it would be smaller than what its
 * pool holds the moment it goes live, everyone's own files and the family folders
 * (docs/families-shared-pool.md 3.2, 5.2). Compared exactly, said in whole GiB rounded up. The
 * server refuses the checkout with these words, and Plans says them before a family is made.
 */
export function firstPlanTooSmall(input: {
    usedBytes: bigint;
    plan: { name: string; quotaBytes: string | bigint };
    /* More than one person in the family: what "it" stores is everyone's. */
    family: boolean;
}) {
    const room = BigInt(input.plan.quotaBytes);
    if (input.usedBytes <= room) return null;
    return `${input.family ? 'Your family stores' : 'Your files take'} ${spaceOf(wholeGibUp(input.usedBytes))}, more than ${planTierName(input.plan)}’s ${spaceOf(room)}. Choose a bigger plan or free at least ${spaceOf(wholeGibUp(input.usedBytes - room))}.`;
}

/* The organisation's default payment currency at the provider; every plan has a price in it. */
export const DEFAULT_CURRENCY = 'usd';

/* ISO 4217, lowercase, as the provider reports it. */
export const CURRENCY_PATTERN = /^[a-z]{3}$/;

export const CANCELLATION_REASONS = [
    'too_expensive',
    'missing_features',
    'switched_service',
    'unused',
    'customer_service',
    'low_quality',
    'too_complex',
    'other',
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

export const cancellationReasonLabels: Record<CancellationReason, string> = {
    too_expensive: 'Too expensive',
    missing_features: 'Missing features',
    switched_service: 'Switched to another service',
    unused: 'Not using it enough',
    customer_service: 'Customer service',
    low_quality: 'Quality',
    too_complex: 'Too complex',
    other: 'Other',
};

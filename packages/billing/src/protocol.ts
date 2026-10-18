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
 * About what Polar charges at once for moving a family to a bigger tier with
 * `invoice` proration, before tax: the difference between the two plans at
 * `units` places (the base, and the per-member rate past those included), for
 * the part of the period left, by the second and truncated to the minor unit.
 * Polar credits the old plan's unused time and charges the new plan's on
 * separate lines, each rounded on its own, so the order can differ from this
 * by a minor unit either way: the page says "about". A move to a smaller tier
 * waits for the renewal and costs nothing now.
 */
export function quoteTierChange(input: {
    from: { base: number; perMember: number; includedMembers: number };
    to: { base: number; perMember: number; includedMembers: number };
    units: number;
    periodStart: Date;
    periodEnd: Date;
    now?: Date;
}) {
    const price = (plan: typeof input.from) =>
        BigInt(plan.base) +
        BigInt(plan.perMember) * BigInt(Math.max(0, input.units - plan.includedMembers));
    const difference = price(input.to) - price(input.from);
    const total = Math.floor((input.periodEnd.getTime() - input.periodStart.getTime()) / 1000);
    if (difference <= 0n || total <= 0) return 0;
    const now = (input.now ?? new Date()).getTime();
    const left = Math.min(total, Math.max(0, Math.floor((input.periodEnd.getTime() - now) / 1000)));
    return Number((difference * BigInt(left)) / BigInt(total));
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

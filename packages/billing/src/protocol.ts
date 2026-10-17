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

/* Product metadata keys read from the provider's catalogue. */
export const PLAN_METADATA_KEY = 'hushos_plan';
export const QUOTA_METADATA_KEY = 'quota_bytes';
export const RECOMMENDED_METADATA_KEY = 'hushos_recommended';

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

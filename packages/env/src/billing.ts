import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const billingEnv = createEnv({
    server: {
        BILLING_PROVIDER: z.enum(['none', 'polar']).default('none'),
        POLAR_ACCESS_TOKEN: z.string().min(1).optional(),
        POLAR_WEBHOOK_SECRET: z.string().min(1).optional(),
        POLAR_ENVIRONMENT: z.enum(['sandbox', 'production']).default('production'),
        BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(3),
        /*
         * Commission safety (docs/company-billing-design.md 8.4, 8.5): refunds and disputes lower
         * an affiliate's earning, new earnings are held before they can be paid, money paid on an
         * order that was later refunded is taken back by amount, and removing an affiliate keeps
         * their ledger. Off, affiliates work exactly as before it existed. Turning it on changes
         * what affiliates already enrolled are owed (docs/self-hosting.md, Affiliates).
         */
        AFFILIATE_V2_ENABLED: z
            .enum(['true', 'false'])
            .default('false')
            .transform((value) => value === 'true'),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});

export function validateBillingProvider() {
    if (billingEnv.BILLING_PROVIDER !== 'polar') return;
    if (!billingEnv.POLAR_ACCESS_TOKEN)
        throw new Error('Set POLAR_ACCESS_TOKEN for the polar billing provider.');
    if (!billingEnv.POLAR_WEBHOOK_SECRET)
        throw new Error('Set POLAR_WEBHOOK_SECRET for the polar billing provider.');
}

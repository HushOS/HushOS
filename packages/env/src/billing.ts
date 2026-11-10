import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

export const billingEnv = createEnv({
    server: {
        BILLING_PROVIDER: z.enum(['none', 'polar']).default('none'),
        POLAR_ACCESS_TOKEN: z.string().min(1).optional(),
        POLAR_WEBHOOK_SECRET: z.string().min(1).optional(),
        POLAR_ENVIRONMENT: z.enum(['sandbox', 'production']).default('production'),
        BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(30).default(3),
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

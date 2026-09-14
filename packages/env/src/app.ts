import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const bytes = (fallback: string) =>
    z
        .string()
        .regex(/^[0-9]{1,16}$/)
        .default(fallback)
        .transform(BigInt);

/* Settings every server process shares: the web app, the worker, the migration job. */
export const appEnv = createEnv({
    server: {
        INITIAL_STORAGE_QUOTA_BYTES: z
            .string()
            .regex(/^[0-9]{1,16}$/)
            .default('1073741824')
            .transform(BigInt),
        APP_ORIGIN: z
            .url()
            .refine((value) => {
                const url = new URL(value);
                return (
                    url.pathname === '/' &&
                    !url.search &&
                    !url.hash &&
                    !url.username &&
                    !url.password &&
                    (url.protocol === 'https:' ||
                        (url.protocol === 'http:' &&
                            ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
                );
            }, 'Use an HTTPS origin or HTTP localhost without a path, query, or credentials.')
            .transform((value) => new URL(value).origin),
        // The legal name of whoever runs this instance, shown in the terms and privacy
        // policy. Unset, those pages speak of "the organisation or person who hosts it".
        OPERATOR_NAME: z.string().trim().min(1).max(200).optional(),
        OPERATOR_JURISDICTION: z.string().trim().min(1).max(200).optional(),
        // An email address for privacy and legal requests, shown on the legal pages.
        OPERATOR_CONTACT: z.string().trim().email().max(200).optional(),
        // Referrals, paid in storage and never money: what each side of an invite earns
        // when the invited account is set up, the most an inviter can earn that way in
        // total, what an inviter earns when someone they invited first pays for a plan,
        // and the most they can earn that way. Zero turns a reward off.
        REFERRAL_BONUS_BYTES: bytes('1073741824'),
        REFERRAL_SIGNUP_CAP_BYTES: bytes('5368709120'),
        REFERRAL_PAID_BONUS_BYTES: bytes('5368709120'),
        REFERRAL_PAID_CAP_BYTES: bytes('53687091200'),
        // Behind a proxy that geolocates, the header carrying the visitor's country as an
        // ISO 3166 code (`cf-ipcountry` on Cloudflare). Unset: the browser's language
        // decides which currency the pricing page shows first.
        TRUSTED_COUNTRY_HEADER: z
            .string()
            .regex(/^[a-z0-9-]{1,64}$/)
            .optional(),
        // Origins the browser may talk to besides the app and the object store, for the
        // page's Content Security Policy: the evidence bucket, for one. Space or comma separated.
        CSP_CONNECT_SRC: z.string().max(2000).optional(),
        // A self-hosted Umami, loaded on the public pages only, never inside the app or on
        // sign-in, sign-up, recovery or shared-link pages. Both, or no analytics at all.
        ANALYTICS_SCRIPT_URL: z.string().url().max(500).optional(),
        ANALYTICS_WEBSITE_ID: z
            .string()
            .regex(/^[A-Za-z0-9-]{8,64}$/)
            .optional(),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});

import { appEnv } from '@hushos/env/app';
import { storageEnv } from '@hushos/env/storage';
import { definePlugin } from 'nitro';
import { analyticsAllowed } from '../../src/lib/analytics-paths';
import { buildCsp, parseOrigins, storeOrigin } from '../csp';

/*
 * Every response leaves with the security headers, and every page with a
 * Content Security Policy under a nonce minted here per request. The router
 * reads the nonce from the request context to stamp the inline script it
 * emits; nothing else inline is allowed. The store's origin is derived from
 * the same settings the presigned URLs come from, so the policy and the
 * uploads cannot drift apart.
 */

const dev = process.env.NODE_ENV !== 'production';
const storeOrigins = [
    storeOrigin(
        storageEnv.STORAGE_ENDPOINT,
        storageEnv.STORAGE_BUCKET,
        storageEnv.STORAGE_FORCE_PATH_STYLE,
    ),
];
const extraConnect = parseOrigins(appEnv.CSP_CONNECT_SRC);
const analyticsOrigins =
    appEnv.ANALYTICS_SCRIPT_URL && appEnv.ANALYTICS_WEBSITE_ID
        ? parseOrigins(appEnv.ANALYTICS_SCRIPT_URL)
        : [];
const secure = appEnv.APP_ORIGIN.startsWith('https:');

export default definePlugin((nitroApp) => {
    nitroApp.hooks.hook('request', (event) => {
        event.req.context ??= {};
        event.req.context.cspNonce = crypto.randomUUID().replaceAll('-', '');
    });
    nitroApp.hooks.hook('response', (response, event) => {
        const nonce = event.req.context?.cspNonce;
        response.headers.set(
            'Content-Security-Policy',
            buildCsp({
                nonce: typeof nonce === 'string' ? nonce : null,
                dev,
                storeOrigins,
                extraConnect,
                // A private page never lets the analytics script in, even one left in the head.
                analyticsOrigins: analyticsAllowed(new URL(event.req.url).pathname)
                    ? analyticsOrigins
                    : [],
            }),
        );
        response.headers.set('X-Content-Type-Options', 'nosniff');
        response.headers.set('X-Frame-Options', 'DENY');
        // The origin alone, even to this server: a path or query sent along in Referer
        // (a search, a tag, a folder) would reach the server and any proxy in front of it.
        // Not no-referrer, which can turn the Origin the auth routes check into null.
        response.headers.set('Referrer-Policy', 'strict-origin');
        response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
        response.headers.set(
            'Permissions-Policy',
            'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
        );
        if (secure)
            response.headers.set(
                'Strict-Transport-Security',
                'max-age=31536000; includeSubDomains',
            );
    });
});

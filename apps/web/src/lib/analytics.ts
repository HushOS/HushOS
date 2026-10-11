import { appEnv } from '@hushos/env/app';
import { createServerFn } from '@tanstack/react-start';
import type { JSX } from 'react';
import { analyticsAllowed } from './analytics-paths';

/*
 * Page analytics for the public pages, through a self-hosted Umami: no cookies,
 * no identifiers, and never loaded where a person is signed in, signing in, or
 * looking at something shared with them. The script is only put on a page whose
 * path is allowed. In-app navigation keeps the page's JavaScript, so a step from
 * a page that loaded the script into a private one is a full page load instead
 * (`leaveAnalytics`), where the CSP no longer lets the script in; and every
 * beacon is filtered before it leaves, its referrer included.
 */

export { analyticsAllowed };

export type Analytics = { scriptUrl: string; websiteId: string };

export const getAnalyticsServerFn = createServerFn().handler((): Analytics | null =>
    appEnv.ANALYTICS_SCRIPT_URL && appEnv.ANALYTICS_WEBSITE_ID
        ? { scriptUrl: appEnv.ANALYTICS_SCRIPT_URL, websiteId: appEnv.ANALYTICS_WEBSITE_ID }
        : null,
);

/* The script tag as the document head wants it: deferred, with Umami's attributes. */
export function analyticsScript(analytics: Analytics): JSX.IntrinsicElements['script'] {
    return {
        src: analytics.scriptUrl,
        defer: true,
        ...({
            'data-website-id': analytics.websiteId,
            'data-before-send': BEFORE_SEND,
        } as Record<string, string>),
    };
}

/*
 * Umami's `data-before-send` hook: a payload for a private page is dropped, and
 * a private page it came from is cut from the referrer, which Umami fills with
 * the previous in-app URL.
 */
export const BEFORE_SEND = 'hushosAnalyticsBeforeSend';
export function installAnalyticsFilter() {
    if (typeof window === 'undefined') return;
    const w = window as unknown as Record<string, unknown>;
    w[BEFORE_SEND] = (_type: string, payload: { url?: string; referrer?: string }) => {
        try {
            const url = new URL(payload.url ?? '/', window.location.origin);
            if (!analyticsAllowed(url.pathname)) return false;
            if (payload.referrer) {
                const referrer = new URL(payload.referrer, window.location.origin);
                if (
                    referrer.origin === window.location.origin &&
                    !analyticsAllowed(referrer.pathname)
                )
                    return { ...payload, referrer: '' };
            }
            return payload;
        } catch {
            return false;
        }
    };
}

/*
 * Whether this page's JavaScript has the analytics script in it: it came with
 * the first page loaded, and in-app navigation never unloads it.
 */
function analyticsLoaded() {
    return (
        typeof window !== 'undefined' &&
        ('umami' in window || document.querySelector(`script[data-before-send="${BEFORE_SEND}"]`))
    );
}

/* True when going to `pathname` must be a full page load, so the script is left behind. */
export function leaveAnalytics(pathname: string) {
    return Boolean(analyticsLoaded()) && !analyticsAllowed(pathname);
}

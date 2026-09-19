import { appEnv } from '@hushos/env/app';
import { createServerFn } from '@tanstack/react-start';
import type { JSX } from 'react';

/*
 * Page analytics for the public pages, through a self-hosted Umami: no cookies,
 * no identifiers, and never loaded where a person is signed in, signing in, or
 * looking at something shared with them. The script is only put on a page whose
 * path is allowed, and a navigation from such a page into a private one is
 * filtered before the beacon leaves, so the private page's URL is never sent.
 */

export type Analytics = { scriptUrl: string; websiteId: string };

/* Under these paths nothing is measured: the app, every way in or back in, and shared links. */
const PRIVATE = ['/app', '/login', '/register', '/recover', '/s', '/account-deleted', '/api'];

export function analyticsAllowed(pathname: string) {
    return !PRIVATE.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

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

/* Umami's `data-before-send` hook: a payload for a private page is dropped. */
export const BEFORE_SEND = 'hushosAnalyticsBeforeSend';
export function installAnalyticsFilter() {
    if (typeof window === 'undefined') return;
    const w = window as unknown as Record<string, unknown>;
    w[BEFORE_SEND] = (_type: string, payload: { url?: string }) => {
        try {
            const url = new URL(payload.url ?? '/', window.location.origin);
            return analyticsAllowed(url.pathname) ? payload : false;
        } catch {
            return false;
        }
    };
}

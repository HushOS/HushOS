import { createServerFn } from '@tanstack/react-start';
import { useSyncExternalStore } from 'react';

/*
 * Which release rendered this page, and whether the server has moved on. The
 * page asks `/api/ready` for the server's release now and then (on a timer
 * while visible, when the tab comes back into view, and on navigation); a
 * different answer means a deploy happened under this tab, and the page
 * reloads itself at the next quiet moment rather than failing oddly against
 * a server it no longer matches.
 */

const RELEASE = /^[a-f0-9]{40}$/;
const CHECK_EVERY_MS = 60_000;

export const getReleaseServerFn = createServerFn().handler((): string | null => {
    const release = process.env.HUSHOS_RELEASE_SHA;
    return release && RELEASE.test(release) ? release : null;
});

let served: string | null = null;
let stale = false;
const listeners = new Set<() => void>();

/* The release the page was rendered by; set once, from its own loader. */
export function setServedRelease(release: string | null) {
    if (release && served === null) served = release;
}

/* A release the server reported since; a different one marks the page stale. */
export function noteRelease(release: string | null) {
    if (!release || served === null || release === served || stale) return;
    stale = true;
    for (const listener of listeners) listener();
}

export function releaseStale() {
    return stale;
}

export function useReleaseStale() {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        releaseStale,
        () => false,
    );
}

/* Reloads now when the page is stale and nothing would be lost; says whether it did. */
export function reloadIfStale(busy: boolean) {
    if (!stale || busy || typeof window === 'undefined') return false;
    window.location.reload();
    return true;
}

/* One HEAD to the readiness endpoint, no body, nothing cached. */
export async function checkRelease() {
    if (typeof window === 'undefined' || served === null || stale) return;
    try {
        const response = await fetch('/api/ready', { method: 'HEAD', cache: 'no-store' });
        noteRelease(response.headers.get('x-hushos-release'));
    } catch {
        /* Offline or mid-deploy: nothing to learn this time. */
    }
}

/* Checks on a timer while the tab is visible, and the moment it becomes visible again. */
let started = false;
export function startReleaseChecks() {
    if (started || typeof window === 'undefined') return;
    started = true;
    setInterval(() => {
        if (document.visibilityState === 'visible') void checkRelease();
    }, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkRelease();
    });
}

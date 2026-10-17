/*
 * Where to go after signing in or signing up. Two carriers:
 *
 * - `?redirect=` on /login, for app pages and the few public pages worth
 *   coming back to (signInReturn). Only a same-site path is accepted
 *   (one leading slash, no scheme, no host, no backslash, no control
 *   characters), so the parameter can never send anyone off-site.
 * - A saved return in local storage, for a shared link. A link's key lives
 *   after the `#`, which must never reach the server in a query string; local
 *   storage survives the confirmation email opening in a new tab. It is used
 *   once, and ignored after an hour.
 */

import { routePath } from '@/lib/analytics-paths';

const STORAGE = 'hushos.return';
const MAX_AGE_MS = 60 * 60 * 1000;
/* Pages a return must not point back at, with everything under them: they would loop. */
const LOOPS = ['/login', '/register', '/recover', '/setup'];
/* Exactly these are where a sign-in lands anyway; a folder under them is a real return. */
const DEFAULTS = ['/app', '/app/drive'];

/* A same-site path (with its query and, when `hash` is true, its fragment), or null. */
export function safeReturnPath(value: unknown, options: { hash?: boolean } = {}): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return null;
    if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return null;
    // Control characters (a newline, a tab) can make a browser read a path as something else.
    for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code < 0x20 || code === 0x7f) return null;
    }
    let url: URL;
    try {
        url = new URL(value, 'https://hushos.invalid');
    } catch {
        return null;
    }
    if (url.origin !== 'https://hushos.invalid') return null;
    const path = url.pathname;
    if (LOOPS.some((page) => path === page || path.startsWith(`${page}/`))) return null;
    if (DEFAULTS.includes(path) && !url.search) return null;
    return path + url.search + (options.hash ? url.hash : '');
}

/* Saves where to come back to, fragment and all, for the next sign-in or sign-up in this browser. */
export function rememberReturn(path: string, now = Date.now()) {
    const safe = safeReturnPath(path, { hash: true });
    if (!safe) return;
    try {
        window.localStorage.setItem(STORAGE, JSON.stringify({ path: safe, at: now }));
    } catch {
        /* No storage: the person lands on Home instead. */
    }
}

/* The saved return, removed as it is read; null when none, stale, or unreadable. */
export function takeReturn(now = Date.now()): string | null {
    try {
        const raw = window.localStorage.getItem(STORAGE);
        if (raw === null) return null;
        window.localStorage.removeItem(STORAGE);
        const saved = JSON.parse(raw) as { path?: unknown; at?: unknown };
        if (typeof saved.at !== 'number' || now - saved.at > MAX_AGE_MS || now < saved.at)
            return null;
        return safeReturnPath(saved.path, { hash: true });
    } catch {
        return null;
    }
}

/* Drops a saved return without using it: at sign-out, and on start-up once it has gone stale. */
export function forgetReturn(now?: number) {
    try {
        const raw = window.localStorage.getItem(STORAGE);
        if (raw === null) return;
        if (now !== undefined) {
            const saved = JSON.parse(raw) as { at?: unknown };
            if (typeof saved.at === 'number' && now - saved.at <= MAX_AGE_MS && now >= saved.at)
                return;
        }
        window.localStorage.removeItem(STORAGE);
    } catch {
        /* No storage, nothing kept. */
    }
}

/* Where a finished sign-in or sign-up goes: a saved return first, then `?redirect=`, then Home. */
export function returnTarget(redirect?: string | null) {
    return takeReturn() ?? safeReturnPath(redirect) ?? '/app';
}

/*
 * Public pages whose Sign in comes back to them, with everything under them; every other public
 * page signs in to /app, so a new page goes there too until it is added here.
 *
 * Remembered in this browser, never put in a query string (a 404 or error page under either
 * still shows the site header):
 * - a shared link (/s/), remembered key and all, since its key rides after the `#`;
 * - a family invitation (/join). That page moves its token out of the address into this tab's
 *   sessionStorage, so the header remembers plain `/join`, without the token: coming back in
 *   the same tab finds the token kept there, and a new tab finds none. The invitation's own
 *   Sign in remembers the token with it.
 *
 * The others come back through `?redirect=`: /pricing, whose buttons start checkout straight
 * away once signed in, so a buyer who signs in there has to land back on it; an offer page
 * (/go/), whose signed-in view checks out with its discount; and the app itself, should its
 * error page be what is showing.
 *
 * Left out on purpose: an invite link (/r/), which tells someone already signed in that it is
 * for someone else, so coming back to it is a dead end.
 */
const KEYED = ['/s', '/join'];
const RETURNS = ['/pricing', '/go', '/app'];

/* What Sign in in the site header does from a page: nothing (to /app), a `?redirect=`, or a remembered return. */
export function signInReturn(
    pathname: string,
    search = '',
): { redirect?: string; remember: boolean } {
    // As the router matches it: `/S/…` or `/%73/…` is a shared link too, with a key in its fragment.
    const path = routePath(pathname);
    if (path === null) return { remember: false };
    const under = (pages: string[]) =>
        pages.some((page) => path === page || path.startsWith(`${page}/`));
    if (under(KEYED)) return { remember: true };
    if (under(RETURNS))
        return { redirect: safeReturnPath(pathname + search) ?? undefined, remember: false };
    return { remember: false };
}

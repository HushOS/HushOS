/*
 * Where page analytics may run, apart from the rest of lib/analytics so the
 * server's CSP can ask the same question without the server-function import.
 */

/* Under these paths nothing is measured: the app, every way in or back in, set-up, and shared links. */
const PRIVATE = [
    '/app',
    '/setup',
    '/login',
    '/register',
    '/recover',
    '/s',
    '/account-deleted',
    '/hushos-download',
    '/api',
];

/*
 * A path as the router matches it: percent-decoded, lowercased, slashes
 * collapsed. `/S/x`, `/%73/x` and `//s/x` all serve a shared link, so a check on
 * the raw path would wave them through. Null when it does not decode.
 */
export function routePath(pathname: string) {
    try {
        return decodeURIComponent(pathname)
            .toLowerCase()
            .replace(/\/{2,}/g, '/');
    } catch {
        return null;
    }
}

export function analyticsAllowed(pathname: string) {
    const path = routePath(pathname);
    if (path === null) return false;
    return !PRIVATE.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

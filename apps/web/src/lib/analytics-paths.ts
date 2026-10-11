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

export function analyticsAllowed(pathname: string) {
    return !PRIVATE.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

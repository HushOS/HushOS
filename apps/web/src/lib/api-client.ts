import { treaty } from '@elysia/eden';
import { CLIENT_HEADER } from '@hushos/drive/protocol';
import type { Api } from '@/lib/api.server';
import { HUSHOS_VERSION } from '@/lib/version';

function createClient(credentials: RequestCredentials) {
    return treaty<Api>(window.location.origin, {
        // The client the Drive API is asked to serve, by product version; a stale tab
        // after a deploy that raised the minimum is told to reload rather than fail oddly.
        headers: { [CLIENT_HEADER]: `web/${HUSHOS_VERSION}` },
        fetch: { credentials, cache: 'no-store' },
        onRequest: () => ({ signal: AbortSignal.timeout(30_000) }),
    });
}
let client: ReturnType<typeof createClient> | undefined;
export function apiClient() {
    client ??= createClient('same-origin');
    return client.api;
}
/*
 * For routes that take no session (a link's visitor routes): sent without the
 * cookie, so these API requests do not tie the link to an account. That does
 * not make the visit anonymous: the link page's own request (/s/<token>, a
 * top-level navigation) still carries the session cookie beside the token in
 * its path, as every page load does, so whoever runs the server can tie the
 * two from that request alone. The page itself never asks who is signed in
 * until the visitor presses Sign in or Save a copy.
 */
let anonymous: ReturnType<typeof createClient> | undefined;
export function anonymousApiClient() {
    anonymous ??= createClient('omit');
    return anonymous.api;
}

export async function unwrap<R extends { data: unknown; error: unknown }>(pending: Promise<R>) {
    const { data, error } = await pending;
    if (error) {
        const value = (error as { value?: unknown }).value;
        const message =
            value &&
            typeof value === 'object' &&
            typeof (value as { message?: unknown }).message === 'string'
                ? (value as { message: string }).message
                : 'Please try again.';
        // A refusal's code, when the server gave one (`current`, `registered`): for callers that act on it.
        const code =
            value &&
            typeof value === 'object' &&
            typeof (value as { code?: unknown }).code === 'string'
                ? (value as { code: string }).code
                : undefined;
        throw Object.assign(new Error(message), code ? { code } : {});
    }
    return data as NonNullable<R['data']>;
}

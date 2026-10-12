import { treaty } from '@elysia/eden';
import { CLIENT_HEADER, DRIVE_PROTOCOL_VERSION } from '@hushos/drive/protocol';
import type { Api } from '@/lib/api.server';

function createClient(credentials: RequestCredentials) {
    return treaty<Api>(window.location.origin, {
        // The client the Drive API is asked to serve; a stale tab after a deploy
        // that raised the minimum is told to reload rather than fail oddly.
        headers: { [CLIENT_HEADER]: `web/${DRIVE_PROTOCOL_VERSION}` },
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
 * For routes that take no session (a link's visitor routes): without the
 * cookie, so the server cannot tie the link someone opened to their account.
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
        throw new Error(message);
    }
    return data as NonNullable<R['data']>;
}

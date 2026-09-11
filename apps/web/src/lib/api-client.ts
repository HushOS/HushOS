import { treaty } from '@elysia/eden';
import type { Api } from '@/lib/api.server';

let client: ReturnType<typeof treaty<Api>> | undefined;
export function apiClient() {
    client ??= treaty<Api>(window.location.origin, {
        fetch: { credentials: 'same-origin', cache: 'no-store' },
        onRequest: () => ({ signal: AbortSignal.timeout(30_000) }),
    });
    return client.api;
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

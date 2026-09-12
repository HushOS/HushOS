import { hasSessionCookie, readSessionToken } from '@hushos/auth/http';
import { getSessionUser } from '@hushos/auth/server';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { createIsomorphicFn } from '@tanstack/react-start';
import { useRequest } from 'nitro/context';
import { authClient } from '@/lib/auth-client';

/*
 * The session lives in the query cache, the way TanStack's auth guide keeps auth
 * state in router context rather than refetching it per navigation: the server
 * answers once per document, the SSR query integration hands that answer to the
 * browser, and guards read the cache until it goes stale or an auth event clears it.
 */
export const sessionKeys = {
    user: ['session', 'user'] as const,
    hint: ['session', 'hint'] as const,
};

const readSessionUser = createIsomorphicFn()
    .server(() => getSessionUser(readSessionToken(useRequest())))
    .client(async () => (await authClient.session()).user);

export const sessionQueryOptions = queryOptions({
    queryKey: sessionKeys.user,
    queryFn: () => readSessionUser(),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    retry: 1,
});

/* On the server the cookie's presence is enough for a header; the browser cannot see it. */
const readSessionHint = createIsomorphicFn()
    .server((): boolean | undefined => hasSessionCookie(useRequest()))
    .client((): boolean | undefined => undefined);

/*
 * Whether to draw the signed-in header on a public page. Never a database lookup:
 * a stale cookie shows "Open app" and the protected layout sorts it out on the click.
 */
export function sessionHint(queryClient: QueryClient) {
    const user = queryClient.getQueryData(sessionKeys.user);
    if (user !== undefined) return user !== null;
    const known = queryClient.getQueryData<boolean>(sessionKeys.hint);
    if (known !== undefined) return known;
    const value = readSessionHint() ?? false;
    queryClient.setQueryData(sessionKeys.hint, value);
    return value;
}

/* The real check, cached for the stale window. Throws when the lookup itself fails. */
export async function ensureSessionUser(queryClient: QueryClient) {
    const user = await queryClient.ensureQueryData(sessionQueryOptions);
    queryClient.setQueryData(sessionKeys.hint, user !== null);
    return user;
}

export function fetchSessionUser(queryClient: QueryClient) {
    return queryClient.fetchQuery({ ...sessionQueryOptions, staleTime: 0 });
}

/* After an auth event: forget what was known so the next guard asks again. */
export function forgetSession(queryClient: QueryClient, hint?: boolean) {
    queryClient.removeQueries({ queryKey: sessionKeys.user });
    if (hint === undefined) queryClient.removeQueries({ queryKey: sessionKeys.hint });
    else queryClient.setQueryData(sessionKeys.hint, hint);
}

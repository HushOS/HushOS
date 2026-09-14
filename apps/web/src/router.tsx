import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { createIsomorphicFn } from '@tanstack/react-start';

import { routeTree } from '@/routeTree.gen';

/*
 * The nonce the security-headers plugin minted for this request: TanStack
 * stamps it on the one inline script it writes, the router's dehydrated
 * state, which the page's Content Security Policy otherwise refuses.
 */
const cspNonce = createIsomorphicFn()
    .server(async () => {
        const { useRequest } = await import('nitro/context');
        const nonce = useRequest().context?.cspNonce;
        return typeof nonce === 'string' ? nonce : undefined;
    })
    .client(() => undefined);

export async function getRouter() {
    // Each SSR request gets its own cache; the browser keeps its router instance.
    const queryClient = new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
    });
    const nonce = await cspNonce();
    const router = createRouter({
        routeTree,
        context: { queryClient },
        scrollRestoration: true,
        defaultPreload: 'intent',
        defaultPreloadStaleTime: 0,
        ...(nonce ? { ssr: { nonce } } : {}),
    });

    setupRouterSsrQueryIntegration({ router, queryClient });
    return router;
}

declare module '@tanstack/react-router' {
    interface Register {
        router: Awaited<ReturnType<typeof getRouter>>;
    }
}
declare module 'nitro' {
    interface ServerRequestContext {
        cspNonce?: string;
    }
}

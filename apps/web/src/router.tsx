import { QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';

import { routeTree } from '@/routeTree.gen';

export function getRouter() {
    // Each SSR request gets its own cache; the browser keeps its router instance.
    const queryClient = new QueryClient({
        defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
    });
    const router = createRouter({
        routeTree,
        context: { queryClient },
        scrollRestoration: true,
        defaultPreload: 'intent',
        defaultPreloadStaleTime: 0,
    });

    setupRouterSsrQueryIntegration({ router, queryClient });
    return router;
}

declare module '@tanstack/react-router' {
    interface Register {
        router: ReturnType<typeof getRouter>;
    }
}

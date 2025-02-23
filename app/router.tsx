import { routeTree } from '@/routeTree.gen';
import { createRouter as createTanStackRouter } from '@tanstack/react-router';

export function createRouter() {
    const router = createTanStackRouter({
        routeTree,
        scrollRestoration: true,
        defaultPreload: 'intent',
    });

    return router;
}

declare module '@tanstack/react-router' {
    interface Register {
        router: ReturnType<typeof createRouter>;
    }
}

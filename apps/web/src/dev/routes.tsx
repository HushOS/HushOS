import { createRoute, lazyRouteComponent, redirect, type AnyRoute } from '@tanstack/react-router';

/*
 * The playground's routes, added to the generated tree in development only (router.tsx
 * imports this module behind import.meta.env.DEV). They live outside src/routes so the
 * route generator never sees them and routeTree.gen.ts stays the same in every mode.
 * Client-rendered: DialKit and the measuring overlay need the DOM.
 */
export function addPlayground(root: AnyRoute) {
    // getRouter runs once per request on the server, and again after a hot update of this
    // file: the dev branch replaces the one already there rather than adding another.
    const all: AnyRoute[] = Array.isArray(root.children) ? root.children : [];
    const children = all.filter(
        (route) => !('path' in route.options && route.options.path === 'dev'),
    );

    const dev = createRoute({
        getParentRoute: () => root,
        path: 'dev',
        ssr: false,
        head: () => ({ meta: [{ title: 'Playground · HushOS' }] }),
        component: lazyRouteComponent(() => import('./shell'), 'PlaygroundShell'),
    });
    const index = createRoute({
        getParentRoute: () => dev,
        path: '/',
        beforeLoad: () => {
            throw redirect({ href: '/dev/components' });
        },
    });
    const components = createRoute({
        getParentRoute: () => dev,
        path: 'components',
        component: lazyRouteComponent(() => import('./components-page'), 'ComponentsPage'),
    });
    const layers = createRoute({
        getParentRoute: () => dev,
        path: 'layers',
        component: lazyRouteComponent(() => import('./layers-page'), 'LayersPage'),
    });

    root.addChildren([...children, dev.addChildren([index, components, layers])]);
}

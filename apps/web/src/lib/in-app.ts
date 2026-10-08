import { useRouterState } from '@tanstack/react-router';

/*
 * The phone apps open the policy pages with ?app=1. Opened that way, a page
 * shows the logo and nothing that leads to plans or the web app: the stores
 * refuse apps that reach a purchase page from inside them. Links between
 * these pages keep the flag; links anywhere else become plain text.
 */
export const IN_APP_PAGES = ['/privacy', '/terms', '/support', '/security'] as const;

export type InAppPage = (typeof IN_APP_PAGES)[number];

export function isInAppPage(path: string): path is InAppPage {
    return (IN_APP_PAGES as readonly string[]).includes(path);
}

export function useInApp(): boolean {
    return useRouterState({
        select: (state) => new URLSearchParams(state.location.searchStr).get('app') === '1',
    });
}

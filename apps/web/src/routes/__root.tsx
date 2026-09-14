import geistLatin from '@fontsource-variable/geist/files/geist-latin-wght-normal.woff2?url';
import geistMonoLatin from '@fontsource-variable/geist-mono/files/geist-mono-latin-wght-normal.woff2?url';
import { evlogErrorHandler } from '@hushos/logging/nitro';
import type { QueryClient } from '@tanstack/react-query';
import {
    createRootRouteWithContext,
    HeadContent,
    Link,
    Outlet,
    Scripts,
    useLocation,
} from '@tanstack/react-router';
import { createMiddleware } from '@tanstack/react-start';
import { useEffect, useRef, type ReactNode } from 'react';

import { MotionProvider } from '@/components/motion';
import {
    analyticsAllowed,
    analyticsScript,
    getAnalyticsServerFn,
    installAnalyticsFilter,
} from '@/lib/analytics';
import {
    checkRelease,
    getReleaseServerFn,
    reloadIfStale,
    setServedRelease,
    startReleaseChecks,
    useReleaseStale,
} from '@/lib/release';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { ThemeProvider, useTheme } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { billingHint } from '@/lib/billing';
import { sessionHint } from '@/lib/session';
import { initSounds } from '@/lib/sounds';
import { getThemeServerFn } from '@/lib/theme';
import styles from '@/styles.css?url';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    server: {
        middleware: [createMiddleware().server(evlogErrorHandler)],
    },
    // Public pages only need to know whether a session cookie exists; no lookup here.
    // The protected layout validates for real when the user goes in.
    beforeLoad: async ({ context }) => ({
        hasSession: sessionHint(context.queryClient),
        billingEnabled: await billingHint(context.queryClient),
    }),
    // Then the loader, so `head` knows its shape: the theme, and whether analytics may load here.
    loader: async ({ location }) => ({
        theme: await getThemeServerFn(),
        analytics: analyticsAllowed(location.pathname) ? await getAnalyticsServerFn() : null,
        release: await getReleaseServerFn(),
    }),
    head: ({ loaderData }) => ({
        meta: [
            { charSet: 'utf-8' },
            {
                name: 'viewport',
                content: 'width=device-width, initial-scale=1, viewport-fit=cover',
            },
            { title: 'HushOS' },
            {
                name: 'description',
                content: 'An open-source, self-hostable productivity suite.',
            },
            { name: 'application-name', content: 'HushOS' },
            // Installable as an app on every platform; there is no offline mode yet.
            { name: 'mobile-web-app-capable', content: 'yes' },
            { name: 'apple-mobile-web-app-capable', content: 'yes' },
            { name: 'apple-mobile-web-app-title', content: 'HushOS' },
            { name: 'apple-mobile-web-app-status-bar-style', content: 'default' },
            { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#f4f3ee' },
            { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#000000' },
            { name: 'msapplication-TileColor', content: '#3b6acc' },
            { name: 'msapplication-config', content: '/browserconfig.xml' },
        ],
        links: [
            {
                rel: 'preload',
                href: geistLatin,
                as: 'font',
                type: 'font/woff2',
                crossOrigin: 'anonymous',
            },
            {
                rel: 'preload',
                href: geistMonoLatin,
                as: 'font',
                type: 'font/woff2',
                crossOrigin: 'anonymous',
            },
            { rel: 'stylesheet', href: styles },
            { rel: 'icon', href: '/favicon.ico', sizes: 'any' },
            { rel: 'icon', href: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
            { rel: 'icon', href: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
            { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
            { rel: 'mask-icon', href: '/safari-pinned-tab.svg', color: '#3b6acc' },
            { rel: 'manifest', href: '/manifest.json' },
        ],
        // Umami on the public pages only; a private page's loader hands back no script.
        scripts: loaderData?.analytics ? [analyticsScript(loaderData.analytics)] : [],
    }),
    headers: () => ({ 'Cache-Control': 'private, no-store', Vary: 'Cookie' }),
    shellComponent: RootDocument,
    component: Outlet,
    notFoundComponent: () => (
        <StatusPage
            code="404 · Not found"
            title="This page doesn’t exist."
            description="The link may be out of date, or the page may have moved."
        />
    ),
    errorComponent: ({ reset }) => (
        <StatusPage
            code="Error"
            title="Something went wrong."
            description="Nothing about your account changed. Try again, and if it keeps happening, reload the page."
            action={
                <Button onClick={reset} variant="outline">
                    Try again
                </Button>
            }
        />
    ),
});

function StatusPage({
    code,
    title,
    description,
    action,
}: {
    code: string;
    title: string;
    description: string;
    action?: ReactNode;
}) {
    return (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-5 py-16">
                <div className="border bg-card">
                    <p className="eyebrow border-b px-5 py-3 text-muted-foreground">{code}</p>
                    <div className="px-5 py-6">
                        <h1 className="text-2xl font-medium tracking-tight text-balance">
                            {title}
                        </h1>
                        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                            {description}
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2 border-t bg-muted/40 px-5 py-4">
                        {action}
                        <Button render={<Link to="/" />} nativeButton={false}>
                            Return home
                        </Button>
                    </div>
                </div>
            </main>
            <SiteFooter />
        </div>
    );
}

function RootDocument({ children }: { children: ReactNode }) {
    const data = Route.useLoaderData();
    return (
        <ThemeProvider theme={data?.theme ?? 'system'}>
            <Document release={data?.release ?? null}>{children}</Document>
        </ThemeProvider>
    );
}

function Document({ children, release }: { children: ReactNode; release: string | null }) {
    const { theme } = useTheme();
    const { pathname } = useLocation();
    useEffect(() => {
        setServedRelease(release);
        startReleaseChecks();
        initSounds();
        installAnalyticsFilter();
    }, [release]);
    // A public page has nothing in flight, so a stale one reloads as soon as it knows;
    // a sign-in, sign-up or recovery form waits for the next navigation rather than
    // losing what was typed, and the app decides for itself, since an upload may be running.
    const stale = useReleaseStale();
    const lastPath = useRef(pathname);
    useEffect(() => {
        const moved = lastPath.current !== pathname;
        lastPath.current = pathname;
        if (pathname.startsWith('/app')) return;
        const form = ['/login', '/register', '/recover'].some((p) => pathname.startsWith(p));
        if (!form || moved) reloadIfStale(false);
        if (moved) void checkRelease();
    }, [pathname, stale]);
    return (
        <html lang="en" className={theme}>
            <head>
                <HeadContent />
            </head>
            <body>
                <MotionProvider>
                    <TooltipProvider delay={0} closeDelay={0}>
                        <Toaster>{children}</Toaster>
                    </TooltipProvider>
                </MotionProvider>
                <Scripts />
            </body>
        </html>
    );
}

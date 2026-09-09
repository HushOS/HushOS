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
} from '@tanstack/react-router';
import { createMiddleware } from '@tanstack/react-start';
import { useEffect, type ReactNode } from 'react';

import { MotionProvider } from '@/components/motion';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { ThemeProvider } from '@/components/theme-provider';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/toast';
import { TooltipProvider } from '@/components/ui/tooltip';
import { sessionHint } from '@/lib/session';
import { initSounds } from '@/lib/sounds';
import { getThemeServerFn } from '@/lib/theme';
import styles from '@/styles.css?url';

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
    server: {
        middleware: [createMiddleware().server(evlogErrorHandler)],
    },
    head: () => ({
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
    }),
    // Public pages only need to know whether a session cookie exists; no lookup here.
    // The protected layout validates for real when the user goes in.
    beforeLoad: ({ context }) => ({ hasSession: sessionHint(context.queryClient) }),
    shellComponent: RootDocument,
    loader: () => getThemeServerFn(),
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
    const theme = Route.useLoaderData() ?? 'system';
    useEffect(() => {
        initSounds();
    }, []);
    return (
        <html lang="en" className={theme}>
            <head>
                <HeadContent />
            </head>
            <body>
                <ThemeProvider theme={theme}>
                    <MotionProvider>
                        <TooltipProvider delay={0} closeDelay={0}>
                            <Toaster>{children}</Toaster>
                        </TooltipProvider>
                    </MotionProvider>
                </ThemeProvider>
                <Scripts />
            </body>
        </html>
    );
}

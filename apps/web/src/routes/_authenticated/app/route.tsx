import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { authClient } from '@/lib/auth-client';
import { createFileRoute, Outlet, useLocation, useRouter } from '@tanstack/react-router';
import { AppSidebar } from '@/components/app-sidebar';
import { DeviceControl } from '@/components/device-control';
import { NavigationBar } from '@/components/navigation-bar';
import { ReleaseNotice } from '@/components/release-notice';
import { CollisionDialog } from '@/components/drive/collision-dialog';
import { DriveRuntime } from '@/components/drive/drive-shell';
import { CommandCenter } from '@/components/drive/command-palette';
import { StorageFullDialog } from '@/components/drive/storage-full-dialog';
import { TransfersPanel } from '@/components/drive/transfers-panel';
import { Spinner, TextSwap } from '@/components/motion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { billingApi } from '@/lib/billing-api';
import { usePageRestored } from '@/lib/page-restore';
import { setPaletteOpen } from '@/lib/palette';
import { billingQueryOptions, storageQueryOptions } from '@/lib/queries';
import { sessionQueryOptions } from '@/lib/session';
import { getSidebarStateServerFn } from '@/lib/theme';
import { bindContactsToQueries } from '@/lib/contacts';
import { bindTransfersToQueries, guardUnloadWhileUploading } from '@/lib/transfers';

export const Route = createFileRoute('/_authenticated/app')({
    loader: () => getSidebarStateServerFn(),
    headers: () => ({
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    }),
    head: () => ({ meta: [{ name: 'robots', content: 'noindex' }] }),
    // The sidebar cookie is read once, for the first render. Never stale, so a click on
    // the page already open does not go back to the server for it; gcTime 0 still drops
    // it on leaving /app, so the next sign-in reads it afresh.
    staleTime: Infinity,
    gcTime: 0,
    component: AppLayout,
});

/*
 * The header names the section the person is in, in the words the sidebar and
 * the account menu use for it. A longer prefix comes before the shorter one it
 * sits under, since the first match wins; only what is not listed is Drive.
 */
const sections: [string, string][] = [
    ['/app/search', 'Search'],
    ['/app/tags', 'Tags'],
    ['/app/shared', 'Shared'],
    ['/app/contacts', 'Contacts'],
    ['/app/trash', 'Trash'],
    ['/app/referrals', 'Invite friends'],
    ['/app/admin/reports', 'Reports'],
    ['/app/admin/affiliates', 'Affiliates'],
    ['/app/admin', 'Management'],
    ['/app/account', 'Settings'],
    ['/app/billing', 'Billing'],
    ['/app/recovery-key', 'Recovery phrase'],
];
function sectionTitle(pathname: string) {
    const match = sections.find(
        ([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    );
    return match ? match[1] : 'Drive';
}

function AppLayout() {
    const router = useRouter();
    const pathname = useLocation({ select: (location) => location.pathname });
    const { user } = Route.useRouteContext();
    const sidebarOpen = Route.useLoaderData();
    const queryClient = router.options.context.queryClient;
    const lockRevision = useStore(authClient.store, (state) => state.lockRevision);
    const rememberError = useStore(authClient.store, (state) => state.rememberError);
    const [setupError, setSetupError] = useState('');
    const [checkingOut, setCheckingOut] = useState(false);
    // Back from Polar's checkout: show the app, not "Taking you to checkout…".
    usePageRestored(() => setCheckingOut(false));
    // The session, re-read on focus and once a minute, so a lock or an account
    // change in another tab is noticed here. The reading is a query; acting on it
    // is the effect below. A first empty answer is looked at once more after a
    // moment, since another tab may be between revoking sessions and signing in.
    const session = useQuery({
        ...sessionQueryOptions,
        staleTime: 0,
        refetchInterval: 60_000,
        refetchOnWindowFocus: true,
    });
    const secondLook = useRef(false);
    useEffect(() => {
        if (session.data === undefined || authClient.isAuthenticating()) return;
        const current = session.data;
        if (!current && !secondLook.current) {
            secondLook.current = true;
            const timer = window.setTimeout(() => void session.refetch(), 1_500);
            return () => window.clearTimeout(timer);
        }
        secondLook.current = false;
        if (
            !current ||
            current.id !== user.id ||
            current.credentialVersion !== user.credentialVersion
        ) {
            authClient.resync();
            queryClient.clear();
            void router.invalidate();
        } else void authClient.restore(current, { validated: true }).catch(() => {});
        // Every fresh reading is acted on, even one equal to the last.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session.data, session.dataUpdatedAt, router, queryClient, user.id, user.credentialVersion]);
    const seenLockRevision = useRef(lockRevision);
    const latestUser = useRef(user);
    useEffect(() => {
        latestUser.current = user;
    }, [user]);
    useEffect(() => {
        const validated = seenLockRevision.current === lockRevision;
        seenLockRevision.current = lockRevision;
        void authClient.restore(latestUser.current, { validated }).catch(() => {});
    }, [user.id, user.credentialVersion, lockRevision]);
    // First landing: finish account setup, send a new account to save its recovery
    // phrase, and a signup from the pricing page straight on to checkout.
    useEffect(() => {
        let active = true;
        const current = latestUser.current;
        void authClient
            .restore(current, { validated: true })
            .then(() => authClient.initializeAccount(current))
            .then(async (needsBackup) => {
                if (!active) return;
                if (needsBackup)
                    await router.navigate({ to: '/setup/recovery-key', replace: true });
                await queryClient.invalidateQueries(storageQueryOptions);
                const billing = await queryClient.fetchQuery(billingQueryOptions).catch(() => null);
                if (!active || !billing?.intendedPlan) return;
                setCheckingOut(true);
                try {
                    const { url } = await billingApi.checkout(billing.intendedPlan);
                    if (url) {
                        window.location.assign(url);
                        return;
                    }
                } catch {
                    /* Fall through to the billing page, which retries and shows the error. */
                }
                if (active)
                    await router.navigate({
                        to: '/app/billing',
                        search: { plan: billing.intendedPlan },
                        replace: true,
                    });
            })
            .catch(() => {
                if (active)
                    setSetupError('Account setup could not finish. Please refresh to try again.');
            });
        return () => {
            active = false;
        };
    }, [user.id, user.credentialVersion, router, queryClient]);
    // Uploads outlive any page under /app; the panel and the unload guard live here.
    useEffect(() => {
        bindTransfersToQueries(queryClient);
        bindContactsToQueries(queryClient);
        guardUnloadWhileUploading();
    }, [queryClient]);
    return (
        <SidebarProvider
            defaultOpen={sidebarOpen}
            style={{ '--sidebar-width': '14rem' } as CSSProperties}
        >
            <NavigationBar />
            <AppSidebar user={user} onSearch={() => setPaletteOpen(true)} />
            {/*
             * The one sheet every page lies on. On a desk-sized screen it keeps its place, a margin
             * of desk on every side, and the page scrolls inside it; on a phone it is full-bleed
             * and the window scrolls as usual.
             */}
            <SidebarInset className="min-w-0 bg-card md:my-3 md:mr-3 md:h-[calc(100svh-1.5rem)] md:overflow-hidden md:rounded-xs md:shadow-sheet">
                <header className="sticky top-0 z-30 flex h-12 shrink-0 items-center gap-2 border-b border-rule bg-card px-2.5 sm:px-4">
                    <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
                    <div className="text-sm font-semibold text-foreground">
                        <TextSwap>{sectionTitle(pathname)}</TextSwap>
                    </div>
                    <div className="flex-1" />
                    {/* On a phone the sidebar is a sheet, so search stays reachable up here. */}
                    <button
                        type="button"
                        onClick={() => setPaletteOpen(true)}
                        aria-label="Search"
                        className="flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:text-foreground md:hidden"
                    >
                        <SearchIcon aria-hidden="true" className="size-4" />
                    </button>
                    <DeviceControl
                        user={user}
                        onUnlocked={() => queryClient.invalidateQueries(storageQueryOptions)}
                    />
                </header>
                <div
                    data-scroll-restoration-id="app-sheet"
                    className="flex min-h-0 min-w-0 flex-1 flex-col md:overflow-x-hidden md:overflow-y-auto"
                >
                    <ReleaseNotice />
                    {(rememberError || setupError) && (
                        <div className="flex flex-col gap-3 border-b border-rule px-5 py-4 sm:px-6">
                            {rememberError && (
                                <Alert variant="warning">
                                    <AlertTitle>Saved device access needs attention</AlertTitle>
                                    <AlertDescription>{rememberError}</AlertDescription>
                                </Alert>
                            )}
                            {setupError && (
                                <Alert variant="destructive">
                                    <AlertDescription>{setupError}</AlertDescription>
                                </Alert>
                            )}
                        </div>
                    )}
                    {checkingOut ? (
                        <div className="flex flex-1 items-center justify-center px-5 py-16">
                            <div className="flex flex-col items-center gap-4 text-center">
                                <Spinner className="size-4 text-muted-foreground" />
                                <p className="text-sm text-muted-foreground">
                                    Your account is ready. Taking you to checkout for the plan you
                                    chose…
                                </p>
                            </div>
                        </div>
                    ) : (
                        <Outlet />
                    )}
                </div>
            </SidebarInset>
            <DriveRuntime user={user} />
            <TransfersPanel />
            <StorageFullDialog />
            <CollisionDialog />
            <CommandCenter user={user} />
        </SidebarProvider>
    );
}

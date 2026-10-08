import { useQuery } from '@tanstack/react-query';
import { SearchIcon } from 'lucide-react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { authClient } from '@/lib/auth-client';
import { createFileRoute, Outlet, useRouter } from '@tanstack/react-router';
import { AppSidebar } from '@/components/app-sidebar';
import { UserMenu } from '@/components/user-menu';
import { DeviceControl, openDeviceDialog } from '@/components/device-control';
import { NavigationBar } from '@/components/navigation-bar';
import { ReleaseNotice } from '@/components/release-notice';
import { CollisionDialog } from '@/components/drive/collision-dialog';
import { DriveRuntime } from '@/components/drive/drive-shell';
import { CommandCenter } from '@/components/drive/command-palette';
import { StorageFullDialog } from '@/components/drive/storage-full-dialog';
import { TransfersPanel } from '@/components/drive/transfers-panel';
import { Spinner } from '@/components/motion';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
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

function AppLayout() {
    const router = useRouter();
    const { user } = Route.useRouteContext();
    const sidebarOpen = Route.useLoaderData();
    const queryClient = router.options.context.queryClient;
    const lockRevision = useStore(authClient.store, (state) => state.lockRevision);
    const rememberError = useStore(authClient.store, (state) => state.rememberError);
    const unlocked = useStore(authClient.store, (state) => state.unlockedUserId === user.id);
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
                if (active) setSetupError('Reload the page to try again.');
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
            style={{ '--sidebar-width': '15rem' } as CSSProperties}
        >
            <NavigationBar />
            <AppSidebar user={user} />
            {/*
             * The panel every page sits in. On a desk-sized screen it keeps its place, a margin
             * of ground on three sides, and the page scrolls inside it; on a phone it is
             * full-bleed and the window scrolls as usual.
             */}
            <SidebarInset className="min-w-0 bg-card md:my-2.5 md:mr-2.5 md:h-[calc(100svh-1.25rem)] md:overflow-hidden md:rounded-xl md:border md:border-rule">
                <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 bg-card px-3 sm:px-5 md:px-8">
                    <SidebarTrigger
                        aria-label="Menu"
                        className="text-muted-foreground hover:text-foreground md:hidden"
                    />
                    {/* Search opens the command palette; it reads as a box so people know where to look. */}
                    <button
                        type="button"
                        onClick={() => setPaletteOpen(true)}
                        aria-label="Search"
                        aria-keyshortcuts="/ Meta+K Control+K"
                        className="flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-md bg-muted px-3.5 text-left text-sm text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-ring md:max-w-110"
                    >
                        <SearchIcon aria-hidden="true" className="size-4 shrink-0" />
                        <span className="flex-1 truncate">
                            Search<span className="max-sm:hidden"> your files</span>
                        </span>
                        <kbd className="text-xs max-md:hidden">/</kbd>
                    </button>
                    <div className="flex-1 max-md:hidden" />
                    <UserMenu user={user} />
                    <DeviceControl
                        user={user}
                        onUnlocked={() => queryClient.invalidateQueries(storageQueryOptions)}
                    />
                </header>
                <div
                    data-scroll-restoration-id="app-sheet"
                    className="flex min-h-0 min-w-0 flex-1 flex-col scroll-pb-[var(--selection-room,0px)] md:overflow-x-hidden md:overflow-y-auto"
                >
                    <ReleaseNotice />
                    {(rememberError || setupError) && (
                        <div className="flex flex-col gap-3 border-b border-rule px-5 py-4 sm:px-6">
                            {/*
                             * Unlocked, remembering failed: nothing to do now. Locked, the saved
                             * sign-in didn't open: say so and offer Unlock where it is read.
                             */}
                            {rememberError && unlocked && (
                                <Alert variant="warning">
                                    <AlertTitle>
                                        HushOS couldn’t stay unlocked on this browser
                                    </AlertTitle>
                                    <AlertDescription>
                                        You’ll be asked for your password next time you open it
                                        here.
                                    </AlertDescription>
                                </Alert>
                            )}
                            {rememberError && !unlocked && (
                                <Alert variant="warning">
                                    <AlertTitle>
                                        HushOS didn’t open on its own on this browser
                                    </AlertTitle>
                                    <AlertDescription>
                                        Enter your password to open your files here again.
                                    </AlertDescription>
                                    <AlertAction>
                                        <Button size="sm" onClick={openDeviceDialog}>
                                            Unlock
                                        </Button>
                                    </AlertAction>
                                </Alert>
                            )}
                            {setupError && (
                                <Alert variant="destructive">
                                    <AlertTitle>Your account didn’t finish setting up</AlertTitle>
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

import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { authClient } from '@/lib/auth-client';
import { createFileRoute, Outlet, useLocation, useRouter } from '@tanstack/react-router';
import { AppSidebar } from '@/components/app-sidebar';
import { DeviceControl } from '@/components/device-control';
import { ReleaseNotice } from '@/components/release-notice';
import { CollisionDialog } from '@/components/drive/collision-dialog';
import { CommandCenter } from '@/components/drive/command-palette';
import { StorageFullDialog } from '@/components/drive/storage-full-dialog';
import { TransfersPanel } from '@/components/drive/transfers-panel';
import { Spinner, TextSwap } from '@/components/motion';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { billingApi } from '@/lib/billing-api';
import { usePageRestored } from '@/lib/page-restore';
import { billingQueryOptions, storageQueryOptions } from '@/lib/queries';
import { fetchSessionUser } from '@/lib/session';
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
    staleTime: 0,
    gcTime: 0,
    component: AppLayout,
});

/* The header names the section the person is in; the sidebar carries the same words. */
const sections: [string, string][] = [
    ['/app/trash', 'Trash'],
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
    // A lock from another tab means the session may have moved on: validate again.
    // A plain navigation was just validated by the guard, so restore can trust `user`.
    const seenLockRevision = useRef(lockRevision);
    useEffect(() => {
        let active = true;
        // The guard just validated the session on the way in; this re-validates on
        // focus and on an interval, and after another tab locks or changes the account.
        async function checkSession() {
            if (authClient.isAuthenticating()) return;
            try {
                let current = await fetchSessionUser(queryClient);
                if (!active || authClient.isAuthenticating()) return;
                if (!current) {
                    // Another tab may be between revoking sessions and signing in again
                    // after a security change. Look once more before acting on it.
                    await new Promise((resolve) => setTimeout(resolve, 1_500));
                    if (!active || authClient.isAuthenticating()) return;
                    current = await fetchSessionUser(queryClient);
                    if (!active || authClient.isAuthenticating()) return;
                }
                if (
                    !current ||
                    current.id !== user.id ||
                    current.credentialVersion !== user.credentialVersion
                ) {
                    authClient.resync();
                    queryClient.clear();
                    await router.invalidate();
                } else await authClient.restore(current, { validated: true }).catch(() => {});
            } catch {
                /* Retry at the next focus or interval after a network interruption. */
            }
        }
        const onFocus = () => {
            void checkSession();
        };
        window.addEventListener('focus', onFocus);
        const timer = window.setInterval(onFocus, 60_000);
        return () => {
            active = false;
            window.removeEventListener('focus', onFocus);
            window.clearInterval(timer);
        };
    }, [lockRevision, router, queryClient, user.id, user.credentialVersion]);
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
        <SidebarProvider defaultOpen={sidebarOpen}>
            <AppSidebar user={user} />
            <SidebarInset>
                <header className="sticky top-0 z-30 flex h-11 items-stretch border-b bg-background">
                    <SidebarTrigger
                        className="h-auto w-11 self-stretch border-r text-foreground hover:bg-muted"
                        data-cuelume-press="press"
                    />
                    <div className="eyebrow flex items-center pr-4 text-muted-foreground">
                        <TextSwap>{sectionTitle(pathname)}</TextSwap>
                    </div>
                    <div className="flex-1" />
                    <DeviceControl
                        user={user}
                        onUnlocked={() => queryClient.invalidateQueries(storageQueryOptions)}
                    />
                </header>
                <ReleaseNotice />
                {(rememberError || setupError) && (
                    <div className="flex flex-col gap-3 border-b px-5 py-4 sm:px-8">
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
                            <p className="font-mono text-xs text-muted-foreground">
                                Your account is ready. Taking you to checkout for the plan you
                                chose…
                            </p>
                        </div>
                    </div>
                ) : (
                    <Outlet />
                )}
            </SidebarInset>
            <TransfersPanel />
            <StorageFullDialog />
            <CollisionDialog />
            <CommandCenter user={user} />
        </SidebarProvider>
    );
}

import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { authClient } from '@/lib/auth-client';
import { createFileRoute, Outlet, useRouter } from '@tanstack/react-router';
import { AppSidebar } from '@/components/app-sidebar';
import { TextSwap } from '@/components/motion';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { fetchSessionUser } from '@/lib/session';
import { getSidebarStateServerFn } from '@/lib/theme';

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

function DeviceStatus({ userId }: { userId: string }) {
    const unlockedUser = useStore(authClient.store, (state) => state.unlockedUserId);
    const restoring = useStore(authClient.store, (state) => state.restoring);
    const unlocked = unlockedUser === userId;
    return (
        <div className="eyebrow flex items-center gap-2.5 border-l px-4 text-muted-foreground">
            <span
                aria-hidden="true"
                className={`size-2.5 transition-colors duration-300 ${unlocked ? 'bg-success' : restoring ? 'bg-warning' : 'bg-ink'}`}
            />
            <TextSwap>
                {unlocked ? 'Device unlocked' : restoring ? 'Opening' : 'Device locked'}
            </TextSwap>
        </div>
    );
}

function AppLayout() {
    const router = useRouter();
    const { user } = Route.useRouteContext();
    const sidebarOpen = Route.useLoaderData();
    const lockRevision = useStore(authClient.store, (state) => state.lockRevision);
    // A lock from another tab means the session may have moved on: validate again.
    // A plain navigation was just validated by the guard, so restore can trust `user`.
    const seenLockRevision = useRef(lockRevision);
    useEffect(() => {
        let active = true;
        const queryClient = router.options.context.queryClient;
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
    }, [lockRevision, router, user.id, user.credentialVersion]);
    useEffect(() => {
        const validated = seenLockRevision.current === lockRevision;
        seenLockRevision.current = lockRevision;
        void authClient.restore(user, { validated }).catch(() => {});
    }, [user, lockRevision]);
    return (
        <SidebarProvider defaultOpen={sidebarOpen}>
            <AppSidebar user={user} />
            <SidebarInset>
                <header className="sticky top-0 z-30 flex h-11 items-stretch border-b bg-background">
                    <SidebarTrigger
                        className="h-auto w-11 self-stretch border-r text-foreground hover:bg-muted"
                        data-cuelume-press="press"
                    />
                    <div className="eyebrow flex items-center px-4 text-muted-foreground">
                        Workspace
                    </div>
                    <div className="flex-1" />
                    <DeviceStatus userId={user.id} />
                </header>
                <Outlet />
            </SidebarInset>
        </SidebarProvider>
    );
}

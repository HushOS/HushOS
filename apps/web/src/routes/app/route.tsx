import { useEffect } from 'react';
import { useStore } from 'zustand';
import { authClient } from '@/lib/auth-client';
import { createFileRoute, Outlet, redirect, useRouter } from '@tanstack/react-router';
import { AppSidebar } from '@/components/app-sidebar';
import { TextSwap } from '@/components/motion';
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar';
import { getSidebarStateServerFn } from '@/lib/theme';

export const Route = createFileRoute('/app')({
    beforeLoad: ({ context }) => {
        if (!context.user) throw redirect({ to: '/login' });
        return { user: context.user };
    },
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
    useEffect(() => {
        let active = true;
        async function checkSession() {
            try {
                const { user: current } = await authClient.session();
                if (!active) return;
                if (
                    !current ||
                    current.id !== user.id ||
                    current.credentialVersion !== user.credentialVersion
                ) {
                    await authClient.expireSession();
                    router.options.context.queryClient.clear();
                    await router.invalidate();
                }
            } catch {
                /* Retry at the next focus or interval after a network interruption. */
            }
        }
        void checkSession();
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
    return (
        <SidebarProvider defaultOpen={sidebarOpen}>
            <AppSidebar user={user} />
            <SidebarInset>
                <header className="sticky top-0 z-30 flex h-11 items-stretch border-b bg-background">
                    <SidebarTrigger
                        className="h-auto w-11 self-stretch border-r text-muted-foreground hover:bg-muted hover:text-foreground"
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

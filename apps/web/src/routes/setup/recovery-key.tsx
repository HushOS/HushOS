import { createFileRoute, redirect } from '@tanstack/react-router';
import { RecoveryPhrase } from '@/components/recovery-phrase';
import { SiteFooter, SiteHeader } from '@/components/site-header';

export const Route = createFileRoute('/setup/recovery-key')({
    beforeLoad: ({ context }) => {
        if (!context.user) throw redirect({ to: '/login' });
        return { user: context.user };
    },
    headers: () => ({
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    }),
    head: () => ({
        meta: [
            { title: 'Save your recovery phrase · HushOS' },
            { name: 'referrer', content: 'no-referrer' },
            { name: 'robots', content: 'noindex' },
        ],
    }),
    staleTime: 0,
    gcTime: 0,
    component: RecoverySetupPage,
});

function RecoverySetupPage() {
    const { user } = Route.useRouteContext();
    return (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <main className="flex flex-1 items-center px-5 py-10 sm:px-8 sm:py-16">
                <RecoveryPhrase user={user} setup />
            </main>
            <SiteFooter />
        </div>
    );
}

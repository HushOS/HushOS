import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { RecoveryPhrase } from '@/components/recovery-phrase';
import { SiteFooter, SiteHeader } from '@/components/site-header';

export const Route = createFileRoute('/setup/recovery-key')({
    /* A rotation from account settings says why the user is here; signup leaves it empty. */
    validateSearch: z.object({
        reason: z.enum(['master-key', 'recovery-key']).optional().catch(undefined),
    }),
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
    const { reason } = Route.useSearch();
    return (
        <div className="flex min-h-svh flex-col">
            <SiteHeader />
            <main className="flex flex-1 items-center px-5 py-10 sm:px-8 sm:py-16">
                <RecoveryPhrase user={user} setup reason={reason} />
            </main>
            <SiteFooter />
        </div>
    );
}

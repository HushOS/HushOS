import { createFileRoute, type SearchSchemaInput } from '@tanstack/react-router';
import { RecoveryPhrase } from '@/components/recovery-phrase';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { oneOf } from '@/lib/search';

const reason = oneOf(['master-key', 'recovery-key']);

export const Route = createFileRoute('/_authenticated/setup/recovery-key')({
    /* A rotation from account settings says why the user is here; signup leaves it empty. */
    validateSearch: (search: { reason?: unknown } & SearchSchemaInput) => ({
        reason: reason(search.reason),
    }),
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
                {/* This page stands outside the app shell, so it lays its own sheet on the desk. */}
                <div className="sheet mx-auto w-full max-w-3xl px-5 py-8 sm:px-10 sm:py-10">
                    <RecoveryPhrase user={user} setup reason={reason} />
                </div>
            </main>
            <SiteFooter />
        </div>
    );
}

import { createFileRoute, type SearchSchemaInput } from '@tanstack/react-router';
import { RecoveryPhrase } from '@/components/recovery-phrase';
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
            { title: 'Save your recovery kit · HushOS' },
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
    return <RecoveryPhrase user={user} setup reason={reason} />;
}

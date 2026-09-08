import { createFileRoute } from '@tanstack/react-router';
import { RecoveryPhrase } from '@/components/recovery-phrase';

export const Route = createFileRoute('/app/recovery-key')({
    head: () => ({
        meta: [
            { title: 'Your recovery phrase · HushOS' },
            { name: 'referrer', content: 'no-referrer' },
        ],
    }),
    component: RecoveryKeyPage,
});

function RecoveryKeyPage() {
    const { user } = Route.useRouteContext();
    return (
        <div className="px-5 py-8 sm:px-8 sm:py-12">
            <RecoveryPhrase user={user} />
        </div>
    );
}

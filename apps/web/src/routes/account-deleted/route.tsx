import { createFileRoute, Link } from '@tanstack/react-router';
import { AuthLayout } from '@/components/auth-layout';
export const Route = createFileRoute('/account-deleted')({
    head: () => ({
        meta: [{ title: 'Account deleted · HushOS' }, { name: 'robots', content: 'noindex' }],
    }),
    component: () => (
        <AuthLayout
            notes={false}
            title="Your account is deleted"
            stamp="Closed"
            description="Your profile, personal workspace, encryption-key bundles, and sessions have been removed. There is nothing left to recover."
        >
            <Link to="/" className="text-link">
                Return to HushOS
            </Link>
        </AuthLayout>
    ),
});

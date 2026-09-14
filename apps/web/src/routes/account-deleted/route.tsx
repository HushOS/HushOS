import { createFileRoute, Link } from '@tanstack/react-router';
import { AuthLayout } from '@/components/auth-layout';
import { Button } from '@/components/ui/button';
export const Route = createFileRoute('/account-deleted')({
    head: () => ({
        meta: [{ title: 'Account deleted · HushOS' }, { name: 'robots', content: 'noindex' }],
    }),
    component: () => (
        <AuthLayout
            title="Your account is deleted"
            stamp="Closed"
            description="Your profile, personal workspace, encryption-key bundles, and sessions have been removed. There is nothing left to recover."
        >
            <Button render={<Link to="/" />} nativeButton={false} variant="outline" size="lg">
                Return to HushOS
            </Button>
        </AuthLayout>
    ),
});

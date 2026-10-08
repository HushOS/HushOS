import { createFileRoute, Link } from '@tanstack/react-router';
import { AuthActions, AuthLayout } from '@/components/auth-layout';
import { buttonVariants } from '@/components/ui/button';
export const Route = createFileRoute('/account-deleted')({
    head: () => ({
        meta: [{ title: 'Account deleted · HushOS' }, { name: 'robots', content: 'noindex' }],
    }),
    component: () => (
        <AuthLayout
            title="Your account is deleted"
            description="Your files, shares, links and account are gone from HushOS. This can’t be undone."
        >
            <AuthActions
                action={
                    <Link to="/" className={buttonVariants({ variant: 'outline', size: 'lg' })}>
                        Go to the HushOS home page
                    </Link>
                }
            />
        </AuthLayout>
    ),
});

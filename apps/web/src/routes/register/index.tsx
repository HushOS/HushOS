import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { EmailStep } from '@/components/email-step';

const layout = getRouteApi('/register');

export const Route = createFileRoute('/register/')({
    component: RegisterEmail,
});

/* A plan picked on the pricing page rides along with the email request. */
function RegisterEmail() {
    const { plan } = layout.useSearch();
    return <EmailStep purpose="register" intent={plan ? { plan, source: 'pricing' } : undefined} />;
}

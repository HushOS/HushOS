import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { EmailStep } from '@/components/email-step';

const layout = getRouteApi('/register');

export const Route = createFileRoute('/register/')({
    component: RegisterEmail,
});

/* A plan picked on the pricing page, or a code from an invite, rides along with the email request. */
function RegisterEmail() {
    const { plan, ref, currency } = layout.useSearch();
    const intent =
        plan || ref
            ? {
                  ...(plan ? { plan } : {}),
                  ...(plan && currency ? { currency } : {}),
                  ...(ref ? { referral: ref } : {}),
                  source: ref ? 'referral' : 'pricing',
              }
            : undefined;
    return <EmailStep purpose="register" intent={intent} />;
}

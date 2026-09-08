import { createFileRoute } from '@tanstack/react-router';
import { EmailStep } from '@/components/email-step';
export const Route = createFileRoute('/recover/')({
    component: () => <EmailStep purpose="recover" />,
});

import { createFileRoute } from '@tanstack/react-router';
import { EmailStep } from '@/components/email-step';
export const Route = createFileRoute('/register/')({
    component: () => <EmailStep purpose="register" />,
});

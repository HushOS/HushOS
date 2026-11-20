import { createFileRoute } from '@tanstack/react-router';
import { CheckEmailStep } from '@/components/auth/email-step';
export const Route = createFileRoute('/recover/check-email')({
    component: () => <CheckEmailStep purpose="recover" />,
});

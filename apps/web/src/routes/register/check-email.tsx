import { createFileRoute } from '@tanstack/react-router';
import { CheckEmailStep } from '@/components/email-step';
export const Route = createFileRoute('/register/check-email')({
    component: () => <CheckEmailStep purpose="register" />,
});

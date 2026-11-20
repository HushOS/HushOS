import { createFileRoute } from '@tanstack/react-router';
import { CheckEmailStep } from '@/components/auth/email-step';
export const Route = createFileRoute('/register/check-email')({
    component: () => <CheckEmailStep purpose="register" />,
});

import { createFileRoute, Link, redirect, useRouter } from '@tanstack/react-router';
import { revalidateLogic, useForm } from '@tanstack/react-form';
import { ArrowRightIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { AuthLayout, Stamp } from '@/components/auth-layout';
import { FormActions, FormNote, FormTable } from '@/components/form-rows';
import { PendingLabel } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authError, emailValue } from '@/lib/form';
import { cue } from '@/lib/sounds';

const loginFields = z.object({
    email: emailValue,
    password: z.string().min(1, 'Enter your password.').max(128),
});

export const Route = createFileRoute('/login')({
    beforeLoad: ({ context }) => {
        if (context.user) throw redirect({ to: '/app' });
    },
    headers: () => ({
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    }),
    head: () => ({
        meta: [
            { title: 'Sign in · HushOS' },
            {
                name: 'description',
                content: 'Sign in to unlock your HushOS account on this device.',
            },
            { name: 'robots', content: 'noindex' },
            { name: 'referrer', content: 'no-referrer' },
        ],
    }),
    component: LoginPage,
});
function LoginPage() {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const form = useForm({
        defaultValues: { email: '', password: '' },
        validationLogic: revalidateLogic(),
        validators: { onDynamic: loginFields },
        onSubmit: async ({ value }) => {
            setError('');
            setPending(true);
            try {
                await authClient.login(value.email, value.password);
                form.reset();
                cue('success');
                router.options.context.queryClient.clear();
                await router.invalidate();
                await router.navigate({ to: '/app' });
            } catch (error) {
                cue('error');
                setError(authError(error));
            } finally {
                setPending(false);
            }
        },
    });
    return (
        <AuthLayout
            title="Welcome back"
            stamp="Existing account"
            description="Sign in to unlock your account on this device."
            footer={
                <>
                    <Stamp tone="warning">Password stays on this device</Stamp>
                    <Stamp>Keys wrapped in your browser</Stamp>
                </>
            }
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void form.handleSubmit();
                }}
                aria-busy={pending}
                noValidate
            >
                <FormTable>
                    <form.Field name="email">
                        {(field) => (
                            <AuthInput
                                label="Email"
                                id="email"
                                name={field.name}
                                type="email"
                                autoComplete="username"
                                placeholder="you@example.com"
                                value={field.state.value}
                                onChange={(event) => field.handleChange(event.target.value)}
                                onBlur={field.handleBlur}
                                errors={field.state.meta.errors}
                                disabled={pending}
                                required
                                maxLength={254}
                            />
                        )}
                    </form.Field>
                    <form.Field name="password">
                        {(field) => (
                            <AuthInput
                                label="Password"
                                id="password"
                                name={field.name}
                                type="password"
                                autoComplete="current-password"
                                value={field.state.value}
                                onChange={(event) => field.handleChange(event.target.value)}
                                onBlur={field.handleBlur}
                                errors={field.state.meta.errors}
                                disabled={pending}
                                required
                                maxLength={128}
                            />
                        )}
                    </form.Field>
                    {error && <FormNote tone="destructive">{error}</FormNote>}
                    <FormActions
                        action={
                            <Button
                                type="submit"
                                size="lg"
                                disabled={pending}
                                data-cuelume-press="pulse"
                            >
                                <PendingLabel pending={pending} idle="Sign in" busy="Unlocking…" />
                                <ArrowRightIcon aria-hidden="true" />
                            </Button>
                        }
                    >
                        <Link to="/recover" className="text-link">
                            Forgot your password?
                        </Link>
                        <span>
                            New here?{' '}
                            <Link to="/register" className="text-link">
                                Create an account
                            </Link>
                        </span>
                    </FormActions>
                </FormTable>
            </form>
        </AuthLayout>
    );
}

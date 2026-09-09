import { createFileRoute, useRouter } from '@tanstack/react-router';
import { revalidateLogic, useForm } from '@tanstack/react-form';
import { ArrowRightIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { AuthLayout } from '@/components/auth-layout';
import { FormActions, FormNote, FormTable } from '@/components/form-rows';
import { PendingLabel } from '@/components/motion';
import { VerifiedEmailStep } from '@/components/verified-email-step';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { getCurrentEnrollment } from '@/lib/auth';
import { authClient } from '@/lib/auth-client';
import { authError, newPasswordValue } from '@/lib/form';
import { cue } from '@/lib/sounds';

const signupFields = z
    .object({
        name: z.string().trim().min(1, 'Enter your name.').max(100),
        password: newPasswordValue,
        confirmPassword: z.string(),
    })
    .refine((value) => value.password === value.confirmPassword, {
        message: 'Your passwords don’t match.',
        path: ['confirmPassword'],
    });

export const Route = createFileRoute('/register/complete')({
    loader: () => getCurrentEnrollment(),
    staleTime: 0,
    gcTime: 0,
    component: () => (
        <VerifiedEmailStep initialEnrollment={Route.useLoaderData()} purpose="register">
            {(enrollment) => <CompleteForm enrollment={enrollment} />}
        </VerifiedEmailStep>
    ),
});
function CompleteForm({ enrollment }: { enrollment: { email: string } }) {
    const router = useRouter();
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const form = useForm({
        defaultValues: { name: '', password: '', confirmPassword: '' },
        validationLogic: revalidateLogic(),
        validators: { onDynamic: signupFields },
        onSubmit: async ({ value }) => {
            setPending(true);
            setError('');
            try {
                await authClient.register(enrollment.email, value.name, value.password);
                form.reset();
                cue('success');
                router.options.context.queryClient.clear();
                await router.navigate({ to: '/setup/recovery-key', replace: true });
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
            purpose="register"
            eyebrow={<Badge variant="success">Verified · {enrollment.email}</Badge>}
            title="Set up your account"
            stamp="Step 2 of 2"
            description="Choose your name and a password. The password is used on this device to protect your account key and is never sent to the server."
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void form.handleSubmit();
                }}
                noValidate
                aria-busy={pending}
            >
                <FormTable>
                    <form.Field name="name">
                        {(field) => (
                            <AuthInput
                                label="Name"
                                id="name"
                                name={field.name}
                                type="text"
                                autoComplete="name"
                                value={field.state.value}
                                onChange={(event) => field.handleChange(event.target.value)}
                                onBlur={field.handleBlur}
                                errors={field.state.meta.errors}
                                disabled={pending}
                                required
                            />
                        )}
                    </form.Field>
                    <form.Field name="password">
                        {(field) => (
                            <AuthInput
                                label="Password"
                                hint="12–128 characters. A long, unique passphrase works best."
                                id="password"
                                name={field.name}
                                type="password"
                                autoComplete="new-password"
                                value={field.state.value}
                                onChange={(event) => field.handleChange(event.target.value)}
                                onBlur={field.handleBlur}
                                errors={field.state.meta.errors}
                                disabled={pending}
                                required
                            />
                        )}
                    </form.Field>
                    <form.Field name="confirmPassword">
                        {(field) => (
                            <AuthInput
                                label="Confirm"
                                id="confirmPassword"
                                name={field.name}
                                type="password"
                                autoComplete="new-password"
                                value={field.state.value}
                                onChange={(event) => field.handleChange(event.target.value)}
                                onBlur={field.handleBlur}
                                errors={field.state.meta.errors}
                                disabled={pending}
                                required
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
                                <PendingLabel
                                    pending={pending}
                                    idle="Create account"
                                    busy="Securing…"
                                />
                                <ArrowRightIcon aria-hidden="true" />
                            </Button>
                        }
                    >
                        Next: a 24-word recovery phrase, your only way back in if you forget this
                        password.
                    </FormActions>
                </FormTable>
            </form>
        </AuthLayout>
    );
}

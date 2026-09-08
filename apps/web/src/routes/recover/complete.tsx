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
import { getRecoveryEnrollment } from '@/lib/auth';
import { authClient } from '@/lib/auth-client';
import { authError, newPasswordValue } from '@/lib/form';
import { cue } from '@/lib/sounds';

const recoveryFields = z
    .object({
        phrase: z
            .string()
            .trim()
            .refine(
                (value) => value.split(/\s+/).length === 24,
                'Enter all 24 words of your recovery phrase.',
            ),
        password: newPasswordValue,
        confirmPassword: z.string(),
    })
    .refine((value) => value.password === value.confirmPassword, {
        message: 'Your passwords don’t match.',
        path: ['confirmPassword'],
    });

export const Route = createFileRoute('/recover/complete')({
    loader: () => getRecoveryEnrollment(),
    staleTime: 0,
    gcTime: 0,
    component: () => (
        <VerifiedEmailStep initialEnrollment={Route.useLoaderData()} purpose="recover">
            {(enrollment) => <CompleteForm enrollment={enrollment} />}
        </VerifiedEmailStep>
    ),
});
function CompleteForm({ enrollment }: { enrollment: { email: string } }) {
    const router = useRouter();
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const form = useForm({
        defaultValues: { phrase: '', password: '', confirmPassword: '' },
        validationLogic: revalidateLogic(),
        validators: { onDynamic: recoveryFields },
        onSubmit: async ({ value }) => {
            setPending(true);
            setError('');
            try {
                await authClient.recover(enrollment.email, value.password, value.phrase);
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
            eyebrow={<Badge variant="success">Verified · {enrollment.email}</Badge>}
            title="Choose a new password"
            stamp="Step 2 of 2"
            description="Enter your 24-word recovery phrase to unlock your account key, then set a new password. Other sessions will be signed out."
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
                    <form.Field name="phrase">
                        {(field) => (
                            <AuthInput
                                label="Phrase"
                                hint="All 24 words, separated by spaces."
                                id="phrase"
                                name={field.name}
                                type="text"
                                autoComplete="off"
                                autoCapitalize="none"
                                spellCheck={false}
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
                                label="New password"
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
                                    idle="Reset password"
                                    busy="Securing…"
                                />
                                <ArrowRightIcon aria-hidden="true" />
                            </Button>
                        }
                    >
                        A reset issues a new recovery phrase. You’ll be asked to save it next.
                    </FormActions>
                </FormTable>
            </form>
        </AuthLayout>
    );
}

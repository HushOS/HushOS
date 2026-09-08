import { revalidateLogic, useForm } from '@tanstack/react-form';
import { Link, useRouter } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { AuthLayout, Stamp } from '@/components/auth-layout';
import { ConsentField } from '@/components/consent-field';
import { FormActions, FormNote, FormTable } from '@/components/form-rows';
import { PendingLabel } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { agreeValue, authError, emailValue } from '@/lib/form';
import { cue } from '@/lib/sounds';

export function EmailStep({ purpose }: { purpose: 'register' | 'recover' }) {
    const router = useRouter();
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const form = useForm({
        defaultValues: { email: '', agree: false },
        validationLogic: revalidateLogic(),
        validators: {
            onDynamic:
                purpose === 'register'
                    ? z.object({ email: emailValue, agree: agreeValue })
                    : z.object({ email: emailValue, agree: z.boolean() }),
        },
        onSubmit: async ({ value }) => {
            setError('');
            setPending(true);
            try {
                await authClient.requestEmail(value.email.trim(), purpose);
                form.reset();
                cue('success');
                await router.navigate({
                    to: purpose === 'register' ? '/register/check-email' : '/recover/check-email',
                });
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
            title={purpose === 'register' ? 'Create your account' : 'Recover your account'}
            stamp={purpose === 'register' ? 'Step 1 of 2' : 'Step 1 of 2'}
            description={
                purpose === 'register'
                    ? 'Start with your email. We’ll send a link to confirm it’s yours before anything else is set up.'
                    : 'Confirm your email first. Then use your 24-word recovery phrase to choose a new password.'
            }
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
                                autoComplete="email"
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
                    {purpose === 'register' && (
                        <form.Field name="agree">
                            {(field) => (
                                <ConsentField
                                    checked={field.state.value}
                                    onChange={field.handleChange}
                                    onBlur={field.handleBlur}
                                    errors={field.state.meta.errors}
                                    disabled={pending}
                                />
                            )}
                        </form.Field>
                    )}
                    {error && <FormNote tone="destructive">{error}</FormNote>}
                    <FormActions
                        action={
                            <Button
                                size="lg"
                                type="submit"
                                disabled={pending}
                                data-cuelume-press="pulse"
                            >
                                <PendingLabel pending={pending} idle="Send link" busy="Sending…" />
                                <ArrowRightIcon aria-hidden="true" />
                            </Button>
                        }
                    >
                        {purpose === 'register' ? (
                            <span>
                                Already have an account?{' '}
                                <Link to="/login" className="text-link">
                                    Sign in
                                </Link>
                            </span>
                        ) : (
                            <span>
                                Remembered it?{' '}
                                <Link to="/login" className="text-link">
                                    Back to sign in
                                </Link>
                            </span>
                        )}
                    </FormActions>
                </FormTable>
            </form>
        </AuthLayout>
    );
}

export function CheckEmailStep({ purpose }: { purpose: 'register' | 'recover' }) {
    const steps = [
        'Open the email from HushOS. Check your spam folder if it isn’t there.',
        purpose === 'register'
            ? 'Follow the link to choose your name and password.'
            : 'Follow the link to continue with your recovery phrase.',
        'You can close this tab. The link opens a fresh page.',
    ];
    return (
        <AuthLayout
            title="Check your inbox"
            stamp="Link sent"
            description="We’ve sent a verification link. It’s valid for 30 minutes and only works once."
            footer={
                <Link to={purpose === 'register' ? '/register' : '/recover'} className="text-link">
                    Use another email or request a new link
                </Link>
            }
        >
            <ol className="border bg-card *:border-b *:last:border-b-0">
                {steps.map((step, index) => (
                    <li
                        key={step}
                        className="grid grid-cols-[3.5rem_1fr] text-sm leading-relaxed text-muted-foreground"
                    >
                        <span className="eyebrow flex items-center justify-center border-r text-foreground">
                            0{index + 1}
                        </span>
                        <span className="px-4 py-3.5">{step}</span>
                    </li>
                ))}
            </ol>
        </AuthLayout>
    );
}

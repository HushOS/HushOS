import type { SignupIntent } from '@hushos/auth/protocol';
import { revalidateLogic, useForm } from '@tanstack/react-form';
import { Link, useRouter } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { AuthActions, AuthFields, AuthLayout, AuthNote, Stamp } from '@/components/auth-layout';
import { ConsentField } from '@/components/consent-field';
import { PendingLabel } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { agreeValue, authError, emailValue } from '@/lib/form';
import { getOfferLandingServerFn, getReferralLandingServerFn } from '@/lib/growth';
import { cue } from '@/lib/sounds';

export function EmailStep({
    purpose,
    intent,
}: {
    purpose: 'register' | 'recover';
    intent?: SignupIntent;
}) {
    const router = useRouter();
    const [error, setError] = useState('');
    const [pending, setPending] = useState(false);
    const codeValue = z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{0,64}$/, 'A code is letters, digits, dashes and underscores.');
    const form = useForm({
        // A code from an invite link or a creator's page is filled in; anyone can type one.
        defaultValues: { email: '', agree: false, code: intent?.referral ?? '' },
        validationLogic: revalidateLogic(),
        validators: {
            onDynamic:
                purpose === 'register'
                    ? z.object({ email: emailValue, agree: agreeValue, code: codeValue })
                    : z.object({ email: emailValue, agree: z.boolean(), code: codeValue }),
        },
        onSubmit: async ({ value }) => {
            setError('');
            setPending(true);
            try {
                const code = value.code.trim();
                let signup = intent;
                if (purpose === 'register' && code) {
                    // Checked before the email goes out, so a typo is caught here and not
                    // discovered as missing space after the account exists.
                    const [referral, offer] = await Promise.all([
                        getReferralLandingServerFn({ data: { code } }),
                        getOfferLandingServerFn({ data: { slug: code } }),
                    ]);
                    if (!referral && !offer) {
                        setError(
                            'That code is not one we know. Check it with whoever gave it to you, or leave it out.',
                        );
                        return;
                    }
                    signup = { ...intent, referral: code, source: 'referral' };
                }
                await authClient.requestEmail(value.email.trim(), purpose, signup);
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
            purpose={purpose}
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
                <AuthFields>
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
                        <form.Field name="code">
                            {(field) => (
                                <AuthInput
                                    label="Code"
                                    hint="Optional. An invite from a friend, or an offer from a creator’s page."
                                    id="code"
                                    name={field.name}
                                    type="text"
                                    autoComplete="off"
                                    autoCapitalize="none"
                                    spellCheck={false}
                                    placeholder="e.g. k7m2p4qz"
                                    value={field.state.value}
                                    onChange={(event) => field.handleChange(event.target.value)}
                                    onBlur={field.handleBlur}
                                    errors={field.state.meta.errors}
                                    disabled={pending}
                                    maxLength={64}
                                    data-1p-ignore
                                    data-lpignore="true"
                                />
                            )}
                        </form.Field>
                    )}
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
                    {error && <AuthNote tone="destructive">{error}</AuthNote>}
                    <AuthActions
                        action={
                            <Button size="lg" type="submit" disabled={pending}>
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
                    </AuthActions>
                </AuthFields>
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
            purpose={purpose}
            title="Check your inbox"
            stamp="Link sent"
            description="We’ve sent a verification link. It’s valid for 30 minutes and only works once."
            footer={
                <Link to={purpose === 'register' ? '/register' : '/recover'} className="text-link">
                    Use another email or request a new link
                </Link>
            }
        >
            <ol className="flex flex-col">
                {steps.map((step, index) => (
                    <li
                        key={step}
                        className="grid grid-cols-[1.75rem_minmax(0,1fr)] border-b border-rule py-3 text-sm leading-relaxed last:border-b-0"
                    >
                        <span className="text-muted-foreground tabular-nums">{index + 1}</span>
                        <span>{step}</span>
                    </li>
                ))}
            </ol>
        </AuthLayout>
    );
}

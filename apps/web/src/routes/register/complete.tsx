import type { SessionUser } from '@hushos/auth/protocol';
import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { revalidateLogic, useForm } from '@tanstack/react-form';
import { useState } from 'react';
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@hushos/auth/protocol';
import { AuthInput, StrengthHint } from '@/components/auth-input';
import { AuthActions, AuthFields, AuthLayout, AuthNote } from '@/components/auth-layout';
import { VerifiedEmailStep } from '@/components/verified-email-step';
import { Button, buttonVariants } from '@/components/ui/button';
import { getCurrentEnrollment } from '@/lib/auth';
import { authClient } from '@/lib/auth-client';
import { authError, newPasswordValue } from '@/lib/form';
import { forgetSession } from '@/lib/session';
import { cue } from '@/lib/sounds';

const signupFields = z
    .object({
        name: z.string().trim().min(1, 'Enter your name.').max(100),
        password: newPasswordValue,
        confirmPassword: z.string(),
    })
    .refine((value) => value.password === value.confirmPassword, {
        message: 'The passwords don’t match.',
        path: ['confirmPassword'],
    });

export const Route = createFileRoute('/register/complete')({
    loader: () => getCurrentEnrollment(),
    staleTime: 0,
    gcTime: 0,
    component: CompletePage,
});

function CompletePage() {
    const { user } = Route.useRouteContext();
    const initialEnrollment = Route.useLoaderData();
    const [signedOut, setSignedOut] = useState(false);
    if (user && !signedOut)
        return <SignOutFirst user={user} onSignedOut={() => setSignedOut(true)} />;
    return (
        <VerifiedEmailStep initialEnrollment={initialEnrollment} purpose="register">
            {(enrollment) => <CompleteForm enrollment={enrollment} />}
        </VerifiedEmailStep>
    );
}

function SignOutFirst({ user, onSignedOut }: { user: SessionUser; onSignedOut: () => void }) {
    const router = useRouter();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function signOut() {
        setPending(true);
        setError('');
        try {
            await authClient.logout();
            forgetSession(router.options.context.queryClient, false);
            onSignedOut();
        } catch {
            cue('error');
            setError('Signing out didn’t finish. Check your connection and try again.');
            setPending(false);
        }
    }
    return (
        <AuthLayout
            title="You’re already signed in"
            description={
                <>
                    You’re signed in as{' '}
                    <span className="font-semibold text-foreground">{user.name}</span> ({user.email}
                    ).
                </>
            }
        >
            {error && <AuthNote tone="danger">{error}</AuthNote>}
            <div className="flex flex-col gap-2 *:h-11 *:w-full *:text-[15px]">
                <Link to="/app" className={buttonVariants({ size: 'lg' })}>
                    Open HushOS
                </Link>
                <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    disabled={pending}
                    onClick={() => void signOut()}
                >
                    {pending ? 'Signing out…' : 'Sign out and create another account'}
                </Button>
            </div>
        </AuthLayout>
    );
}

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
            } catch (cause) {
                cue('error');
                setError(authError(cause));
            } finally {
                setPending(false);
            }
        },
    });
    return (
        <AuthLayout
            title="Set up your account"
            description={
                <>
                    Your email is confirmed:{' '}
                    <span className="font-semibold text-foreground">{enrollment.email}</span>
                </>
            }
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void form.handleSubmit();
                }}
                noValidate
                aria-busy={pending}
            >
                <AuthFields>
                    {error && <AuthNote tone="danger">{error}</AuthNote>}
                    <form.Field name="name">
                        {(field) => (
                            <AuthInput
                                label="Name"
                                hint="Shown to people you share with."
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
                                maxLength={100}
                            />
                        )}
                    </form.Field>
                    <form.Field name="password">
                        {(field) => (
                            <>
                                <AuthInput
                                    label="Password"
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
                                    maxLength={PASSWORD_MAX_LENGTH}
                                />
                                {field.state.meta.errors.length === 0 && (
                                    <StrengthHint
                                        password={field.state.value}
                                        min={PASSWORD_MIN_LENGTH}
                                    />
                                )}
                            </>
                        )}
                    </form.Field>
                    <form.Field name="confirmPassword">
                        {(field) => (
                            <AuthInput
                                label="Confirm password"
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
                                maxLength={PASSWORD_MAX_LENGTH}
                            />
                        )}
                    </form.Field>
                    <AuthActions
                        action={
                            <Button type="submit" size="lg" disabled={pending}>
                                {pending ? 'Creating your account…' : 'Create account'}
                            </Button>
                        }
                    />
                </AuthFields>
            </form>
        </AuthLayout>
    );
}

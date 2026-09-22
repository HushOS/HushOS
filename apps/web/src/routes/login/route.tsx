import {
    createFileRoute,
    Link,
    redirect,
    useRouter,
    type SearchSchemaInput,
} from '@tanstack/react-router';
import { revalidateLogic, useForm } from '@tanstack/react-form';
import { ArrowRightIcon } from 'lucide-react';
import { useState } from 'react';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { AuthActions, AuthFields, AuthLayout, AuthNote, Stamp } from '@/components/auth-layout';
import { PendingLabel } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { rememberReturn, returnTarget, safeReturnPath } from '@/lib/return-to';
import { ensureSessionUser, sessionQueryOptions } from '@/lib/session';
import { authError, emailValue } from '@/lib/form';
import { oneOf } from '@/lib/search';
import { cue } from '@/lib/sounds';

const securityChanged = oneOf(['password', 'master-key', 'recovery-key', 'uncertain']);

const loginFields = z.object({
    email: emailValue,
    password: z.string().min(1, 'Enter your password.').max(128),
});

export const Route = createFileRoute('/login')({
    validateSearch: (
        search: { securityChanged?: unknown; redirect?: unknown } & SearchSchemaInput,
    ) => ({
        securityChanged: securityChanged(search.securityChanged),
        // Only ever a same-site path: anything else is dropped here, before any page reads it.
        redirect: safeReturnPath(search.redirect) ?? undefined,
    }),
    beforeLoad: async ({ context, search, preload }) => {
        if (preload) return;
        const user = await ensureSessionUser(context.queryClient).catch(() => null);
        if (!user) return;
        const rotated =
            search.securityChanged === 'master-key' || search.securityChanged === 'recovery-key'
                ? search.securityChanged
                : undefined;
        throw rotated
            ? redirect({ to: '/setup/recovery-key', search: { reason: rotated } })
            : redirect({ href: search.redirect ?? '/app/drive' });
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
    const { securityChanged, redirect: returnTo } = Route.useSearch();
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
                const queryClient = router.options.context.queryClient;
                queryClient.clear();
                // Known again before moving on: a public page (a shared link) reads the session from the cache,
                // and an empty cache there reads as signed out.
                await queryClient.fetchQuery(sessionQueryOptions).catch(() => null);
                const rotated =
                    securityChanged === 'master-key' || securityChanged === 'recovery-key'
                        ? securityChanged
                        : undefined;
                if (rotated) {
                    // The recovery step comes first; it goes on to the page asked for when it is done.
                    if (returnTo) rememberReturn(returnTo);
                    await router.navigate({
                        to: '/setup/recovery-key',
                        search: { reason: rotated },
                        replace: true,
                    });
                } else await router.navigate({ href: returnTarget(returnTo), replace: true });
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
                <AuthFields>
                    {securityChanged && (
                        <AuthNote>
                            {securityChanged === 'password'
                                ? 'Password changed. Sign in with your new password.'
                                : securityChanged === 'uncertain'
                                  ? 'The connection dropped before your security change was confirmed. It may have been applied: try your new password first, then the old one.'
                                  : 'Your keys were rotated. Sign in to save your new recovery phrase.'}
                        </AuthNote>
                    )}
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
                    {error && <AuthNote tone="destructive">{error}</AuthNote>}
                    <AuthActions
                        action={
                            <Button type="submit" size="lg" disabled={pending}>
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
                            <Link
                                to="/register"
                                className="text-link"
                                // Signing up instead still ends on the page that sent them here.
                                onClick={() => returnTo && rememberReturn(returnTo)}
                            >
                                Create an account
                            </Link>
                        </span>
                    </AuthActions>
                </AuthFields>
            </form>
        </AuthLayout>
    );
}

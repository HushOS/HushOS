import {
    createFileRoute,
    Link,
    redirect,
    useRouter,
    type SearchSchemaInput,
} from '@tanstack/react-router';
import { revalidateLogic, useForm } from '@tanstack/react-form';
import { useEffect, useState } from 'react';
import { DeviceStorageUnreadable, StepCancelled } from '@hushos/auth/client';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { AuthActions, AuthFields, AuthLayout, AuthNote, authLink } from '@/components/auth-layout';
import {
    StepChoices,
    StepField,
    STEP_TIMED_OUT,
    stepWords,
    useStepPrompt,
} from '@/components/two-step-prompt';
import { Button, buttonVariants } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { codesLeft, FEW_CODES, notePhraseSignIn } from '@/lib/two-step';
import { rememberReturn, returnTarget, safeReturnPath } from '@/lib/return-to';
import { ensureSessionUser, sessionQueryOptions } from '@/lib/session';
import { authError, emailValue } from '@/lib/form';
import { oneOf } from '@/lib/search';
import { cardMeta, publicOrigin } from '@/lib/social';
import { cue } from '@/lib/sounds';

const securityChanged = oneOf(['password', 'master-key', 'recovery-key', 'uncertain']);
/* Why the sign-in after a security change did not happen here: this browser's device key was unreadable. */
const storage = oneOf(['blocked', 'timeout', 'unavailable']);

const loginFields = z.object({
    email: emailValue,
    password: z.string().min(1, 'Enter your password.').max(128),
});

export const Route = createFileRoute('/login')({
    validateSearch: (
        search: {
            securityChanged?: unknown;
            storage?: unknown;
            redirect?: unknown;
        } & SearchSchemaInput,
    ) => ({
        securityChanged: securityChanged(search.securityChanged),
        storage: storage(search.storage),
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
            : redirect({ href: search.redirect ?? '/app' });
    },
    headers: () => ({
        'Cache-Control': 'private, no-store',
        Vary: 'Cookie',
        'Referrer-Policy': 'no-referrer',
    }),
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: [
            { title: 'Sign in · HushOS' },
            ...(loaderData
                ? cardMeta({
                      origin: loaderData.origin,
                      card: 'login',
                      title: 'Sign in to HushOS',
                      description: 'Your drive, unlocked on your own device.',
                  })
                : []),
            {
                name: 'description',
                content: 'Sign in to HushOS.',
            },
            { name: 'robots', content: 'noindex' },
            { name: 'referrer', content: 'no-referrer' },
        ],
    }),
    component: LoginPage,
});
function LoginPage() {
    const router = useRouter();
    const { securityChanged, storage: unreadable, redirect: returnTo } = Route.useSearch();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    // This browser's device key could not be read: the person may sign in as a new device instead.
    const [offerNewDevice, setOfferNewDevice] = useState(false);
    // A browser that lands here because its device was removed from the account (the
    // server rendered this page without a session) asks once: the auth client then clears
    // what this browser kept for that account.
    const [removed, setRemoved] = useState(false);
    // The account asks for a second step this page's code cannot answer: a reload gets the code that can.
    const [outdated, setOutdated] = useState(false);
    // Signed in with a backup code and close to running out: said before the app opens.
    const [fewCodes, setFewCodes] = useState<{ left: number; next: string } | null>(null);
    const step = useStepPrompt({ onExpired: () => setError(STEP_TIMED_OUT) });
    useEffect(() => {
        void authClient
            .session()
            .catch(() => {})
            .finally(() => setRemoved(authClient.takeRemovedNotice()));
    }, []);
    const form = useForm({
        defaultValues: { email: '', password: '' },
        validationLogic: revalidateLogic(),
        validators: { onDynamic: loginFields },
        // What the press asked for, given with that press and never kept: a press that fails
        // validation leaves nothing behind for the next one.
        onSubmitMeta: { asNewDevice: false },
        onSubmit: async ({ value, meta }) => {
            setError('');
            setOutdated(false);
            setPending(true);
            try {
                await authClient.login(value.email, value.password, {
                    asNewDevice: meta.asNewDevice,
                    // An account with a second step: this page asks for it before anything opens.
                    step: step.ask,
                });
                // The form keeps what was typed and stays busy until the app replaces it:
                // emptied first, it would look for a moment as if signing in had failed.
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
                    return;
                }
                // What answered the step decides what comes next (docs/two-step-design.md 2 and 5).
                // A server that no longer offers two-step sign-in answers neither: straight on.
                const answered = step.answeredWith();
                const status =
                    answered === 'backup' || answered === 'phrase'
                        ? await authClient.twoStep().catch(() => null)
                        : null;
                // The phrase stands in for a method that is lost: Account opens on the step.
                notePhraseSignIn(answered === 'phrase' && status?.on === true);
                if (answered === 'phrase' && status?.on) {
                    await router.navigate({ to: '/app/account', hash: 'two-step', replace: true });
                } else if (
                    answered === 'backup' &&
                    status?.on &&
                    status.backupCodesLeft <= FEW_CODES
                )
                    setFewCodes({ left: status.backupCodesLeft, next: returnTarget(returnTo) });
                else await router.navigate({ href: returnTarget(returnTo), replace: true });
            } catch (error) {
                // Backed out of the step, or its time ran out (said by the step itself).
                if (error instanceof StepCancelled) return;
                cue('error');
                setOfferNewDevice(error instanceof DeviceStorageUnreadable);
                setOutdated((error as { code?: unknown } | null)?.code === 'update-required');
                setError(authError(error, { signIn: true }));
            } finally {
                // Unmounted by now, unless the app sent this page back to itself (a session the
                // browser did not keep): then the form, still filled in, can be used again.
                step.done();
                setPending(false);
            }
        },
    });
    const notice = securityChanged
        ? securityChanged === 'password' && unreadable
            ? {
                  ...notices.password,
                  tone: 'warning' as const,
                  text: `${new DeviceStorageUnreadable(unreadable).why.replace(/^./, (c) => c.toUpperCase())}, so you weren’t signed in here. Sign in with your new password.`,
              }
            : notices[securityChanged]
        : null;
    if (fewCodes)
        return (
            <AuthLayout
                title={codesLeft(fewCodes.left)}
                art="HELLO"
                description="Each backup code works once. Make a new set now, so you have one when you need it."
            >
                <AuthActions
                    action={
                        <Link
                            to="/app/account"
                            hash="two-step"
                            replace
                            className={buttonVariants({ size: 'lg' })}
                        >
                            Make new codes
                        </Link>
                    }
                >
                    {/* A real link to where the sign-in was headed, followed without a reload. */}
                    <a
                        href={fewCodes.next}
                        className={authLink}
                        onClick={(event) => {
                            event.preventDefault();
                            void router.navigate({ href: fewCodes.next, replace: true });
                        }}
                    >
                        Not now
                    </a>
                </AuthActions>
            </AuthLayout>
        );
    if (step.request)
        return (
            <AuthLayout
                title={stepWords[step.kind].title}
                description={stepWords[step.kind].about}
                art="HELLO"
                footer={
                    <button type="button" className={authLink} onClick={step.cancel}>
                        Back to sign in
                    </button>
                }
            >
                <form
                    onSubmit={(event) => {
                        event.preventDefault();
                        step.submit();
                    }}
                    aria-busy={step.checking}
                    noValidate
                >
                    <AuthFields>
                        <StepField prompt={step} />
                        <AuthActions
                            action={
                                <Button type="submit" size="lg" disabled={step.checking}>
                                    {step.checking ? 'Signing in…' : 'Sign in'}
                                </Button>
                            }
                        >
                            <StepChoices prompt={step} />
                        </AuthActions>
                    </AuthFields>
                </form>
            </AuthLayout>
        );
    return (
        <AuthLayout
            title="Welcome back"
            art="HELLO"
            footer={
                <>
                    New to HushOS?{' '}
                    <Link
                        to="/register"
                        className={authLink}
                        // Signing up instead still ends on the page that sent them here.
                        onClick={() => returnTo && rememberReturn(returnTo)}
                    >
                        Create an account
                    </Link>
                </>
            }
        >
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    // Sign in, Unlock and Try again: always as this device.
                    void form.handleSubmit({ asNewDevice: false });
                }}
                aria-busy={pending}
                noValidate
            >
                <AuthFields>
                    {notice && (
                        <AuthNote tone={notice.tone} title={notice.title}>
                            {notice.text}
                        </AuthNote>
                    )}
                    {removed && !notice && (
                        <AuthNote>This browser was removed from your account.</AuthNote>
                    )}
                    {error && <AuthNote tone="danger">{error}</AuthNote>}
                    <form.Field name="email">
                        {(field) => (
                            <AuthInput
                                label="Email"
                                id="email"
                                name={field.name}
                                type="email"
                                autoComplete="username"
                                placeholder="name@example.com"
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
                                action={
                                    <Link to="/recover" className={authLink}>
                                        Forgot your password?
                                    </Link>
                                }
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
                    <AuthActions
                        action={
                            <Button type="submit" size="lg" disabled={pending}>
                                {pending ? 'Signing in…' : offerNewDevice ? 'Try again' : 'Sign in'}
                            </Button>
                        }
                    >
                        {offerNewDevice && (
                            <Button
                                type="button"
                                variant="outline"
                                size="lg"
                                className="h-11 w-full text-[15px]"
                                disabled={pending}
                                onClick={() => void form.handleSubmit({ asNewDevice: true })}
                            >
                                Sign in as a new device
                            </Button>
                        )}
                        {outdated && (
                            <Button
                                type="button"
                                variant="outline"
                                size="lg"
                                className="h-11 w-full text-[15px]"
                                onClick={() => window.location.reload()}
                            >
                                Reload this page
                            </Button>
                        )}
                    </AuthActions>
                </AuthFields>
            </form>
        </AuthLayout>
    );
}

/* Why someone is back at sign in, said once above the form. */
const notices = {
    password: {
        tone: 'success',
        title: 'Password changed',
        text: 'Sign in with your new password.',
    },
    'master-key': {
        tone: 'info',
        title: 'Account key rotated',
        text: 'Sign in to save your new recovery phrase.',
    },
    'recovery-key': {
        tone: 'info',
        title: 'New recovery phrase made',
        text: 'Sign in to save it.',
    },
    uncertain: {
        tone: 'warning',
        title: 'We lost the connection',
        text: 'Your change may not have saved. Try your new password first, then the old one.',
    },
} as const;

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
import { StepChoices, StepField, stepWords, useStepPrompt } from '@/components/two-step-prompt';
import { Button, buttonVariants } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { codesLeft, FEW_CODES, notePhraseSignIn } from '@/lib/two-step';
import { rememberReturn, returnTarget, safeReturnPath } from '@/lib/return-to';
import { ensureSessionUser, sessionQueryOptions } from '@/lib/session';
import { authError, emailValue } from '@/lib/form';
import { oneOf } from '@/lib/search';
import { cardMeta, publicOrigin } from '@/lib/social';
import { cue } from '@/lib/sounds';

/*
 * A security change whose reply never arrived: the one way such a change still ends here. A
 * change that was made keeps this browser signed in (the server opens its session with it).
 */
const securityChanged = oneOf(['uncertain']);

const loginFields = z.object({
    email: emailValue,
    password: z.string().min(1, 'Enter your password.').max(128),
});

export const Route = createFileRoute('/login')({
    validateSearch: (
        search: {
            securityChanged?: unknown;
            redirect?: unknown;
        } & SearchSchemaInput,
    ) => ({
        securityChanged: securityChanged(search.securityChanged),
        // Only ever a same-site path: anything else is dropped here, before any page reads it.
        redirect: safeReturnPath(search.redirect) ?? undefined,
    }),
    beforeLoad: async ({ context, search, preload }) => {
        if (preload) return;
        const user = await ensureSessionUser(context.queryClient).catch(() => null);
        if (!user) return;
        throw redirect({ href: search.redirect ?? '/app' });
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
    const { securityChanged, redirect: returnTo } = Route.useSearch();
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
    const [fewCodes, setFewCodes] = useState<{
        left: number;
        next: string;
        offered: boolean;
    } | null>(null);
    // Back at the password from the step (backed out, or out of time): the field takes the focus.
    const [returned, setReturned] = useState(0);
    useEffect(() => {
        if (returned > 0) document.getElementById('password')?.focus();
    }, [returned]);
    const step = useStepPrompt({
        // The server's words for a step token that ran out.
        onExpired: () => setError('Your sign-in timed out. Sign in again.'),
    });
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
                const { step: stepped } = await authClient.login(value.email, value.password, {
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
                // What answered the step decides what comes next (docs/two-step-design.md 2 and
                // 5); the server's reply says how many backup codes are left, and whether it
                // lets the account change its step at all.
                const viaPhrase = stepped?.answered === 'phrase' && stepped.offered;
                // The phrase stands in for a method that is lost: Account opens on the step.
                notePhraseSignIn(viaPhrase);
                if (viaPhrase)
                    await router.navigate({ to: '/app/account', hash: 'two-step', replace: true });
                else if (
                    stepped?.answered === 'backup' &&
                    stepped.backupCodesLeft !== undefined &&
                    stepped.backupCodesLeft <= FEW_CODES
                )
                    setFewCodes({
                        left: stepped.backupCodesLeft,
                        next: returnTarget(returnTo),
                        offered: stepped.offered,
                    });
                else await router.navigate({ href: returnTarget(returnTo), replace: true });
            } catch (error) {
                // Backed out of the step, or its time ran out (said by the step itself).
                if (error instanceof StepCancelled) return setReturned((count) => count + 1);
                cue('error');
                setOfferNewDevice(error instanceof DeviceStorageUnreadable);
                // The account's step is one this page's code cannot answer: on the web, updating
                // is reloading.
                const old = (error as { code?: unknown } | null)?.code === 'update-required';
                setOutdated(old);
                setError(
                    old
                        ? 'This page is out of date. Reload it to sign in.'
                        : authError(error, { signIn: true }),
                );
            } finally {
                // Unmounted by now, unless the app sent this page back to itself (a session the
                // browser did not keep): then the form, still filled in, can be used again.
                step.done();
                setPending(false);
            }
        },
    });
    const notice = securityChanged ? notices[securityChanged] : null;
    if (fewCodes) {
        // A real link to where the sign-in was headed, followed without a reload.
        const onward = (
            <a
                href={fewCodes.next}
                className={fewCodes.offered ? authLink : buttonVariants({ size: 'lg' })}
                onClick={(event) => {
                    event.preventDefault();
                    void router.navigate({ href: fewCodes.next, replace: true });
                }}
            >
                {fewCodes.offered ? 'Not now' : 'Continue'}
            </a>
        );
        return (
            <AuthLayout
                title={codesLeft(fewCodes.left)}
                art="HELLO"
                description={
                    fewCodes.offered
                        ? 'Each backup code works once. Make a new set now, so you have one when you need it.'
                        : 'Each backup code works once. New codes can’t be made on this server at the moment.'
                }
            >
                {/* Nothing is offered that could not be done: no new codes where the server makes none. */}
                {fewCodes.offered ? (
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
                        {onward}
                    </AuthActions>
                ) : (
                    <AuthActions action={onward} />
                )}
            </AuthLayout>
        );
    }
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
    uncertain: {
        tone: 'warning',
        title: 'We lost the connection',
        text: 'Your change may not have saved. Try your new password first, then the old one.',
    },
} as const;

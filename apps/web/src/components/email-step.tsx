import type { SignupIntent } from '@hushos/auth/protocol';
import { revalidateLogic, useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { MailIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { AuthActions, AuthFields, AuthLayout, AuthNote, authLink } from '@/components/auth-layout';
import { ConsentField } from '@/components/consent-field';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { agreeValue, authError, emailValue } from '@/lib/form';
import { getOfferLandingServerFn, getReferralLandingServerFn } from '@/lib/growth';
import { pickCurrency } from '@/lib/currency';
import { currenciesOf, priceOf } from '@/lib/plans';
import {
    catalogueQueryOptions,
    formatMoney,
    formatQuota,
    localeHintQueryOptions,
} from '@/lib/queries';
import { cue } from '@/lib/sounds';

/*
 * The first step of signing up and of resetting a password: an email, and a
 * link sent to it. The address is kept for this tab only, so "Check your
 * inbox" can name it and send another link; it never goes in the URL.
 */

type Sent = { email: string; purpose: 'register' | 'recover'; intent?: SignupIntent };
const SENT_KEY = 'hushos-link-sent';

function rememberSent(sent: Sent) {
    try {
        sessionStorage.setItem(SENT_KEY, JSON.stringify(sent));
    } catch {
        /* Without storage the inbox page just says "your inbox". */
    }
}
function readSent(): string | null {
    try {
        return sessionStorage.getItem(SENT_KEY);
    } catch {
        return null;
    }
}
const noSubscription = () => () => {};

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
                        form.setFieldMeta('code', (meta) => ({
                            ...meta,
                            errorMap: {
                                ...meta.errorMap,
                                onSubmit:
                                    'We don’t recognise that code. Check it, or leave it empty.',
                            },
                        }));
                        return;
                    }
                    signup = { ...intent, referral: code, source: 'referral' };
                }
                const email = value.email.trim();
                await authClient.requestEmail(email, purpose, signup);
                rememberSent({ email, purpose, intent: signup });
                form.reset();
                cue('success');
                await router.navigate({
                    to: purpose === 'register' ? '/register/check-email' : '/recover/check-email',
                });
            } catch (cause) {
                cue('error');
                setError(authError(cause));
            } finally {
                setPending(false);
            }
        },
    });
    const register = purpose === 'register';
    return (
        <AuthLayout
            title={register ? 'Create your account' : 'Reset your password'}
            description={
                register
                    ? 'We’ll email you a link to confirm it’s you.'
                    : 'You’ll need your recovery kit, or the 24 words on it. We’ll email you a link to start.'
            }
            footer={
                register ? (
                    <>
                        Already have an account?{' '}
                        <Link to="/login" className={authLink}>
                            Sign in
                        </Link>
                    </>
                ) : (
                    <>
                        Remembered it?{' '}
                        <Link to="/login" className={authLink}>
                            Sign in
                        </Link>
                    </>
                )
            }
        >
            {register && intent?.plan && <ChosenPlan id={intent.plan} />}
            <form
                onSubmit={(event) => {
                    event.preventDefault();
                    void form.handleSubmit();
                }}
                aria-busy={pending}
                noValidate
            >
                <AuthFields>
                    {error && <AuthNote tone="danger">{error}</AuthNote>}
                    <form.Field name="email">
                        {(field) => (
                            <AuthInput
                                label="Email"
                                id="email"
                                name={field.name}
                                type="email"
                                autoComplete="email"
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
                    {register && (
                        <form.Field name="code">
                            {(field) => (
                                <AuthInput
                                    label="Code"
                                    optional
                                    hint="From a friend or an offer. A friend’s code gives you both more space."
                                    id="code"
                                    name={field.name}
                                    type="text"
                                    autoComplete="off"
                                    autoCapitalize="none"
                                    spellCheck={false}
                                    placeholder="k7m2p4qz"
                                    className="font-mono"
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
                    {register && (
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
                    <AuthActions
                        action={
                            <Button size="lg" type="submit" disabled={pending}>
                                {pending ? 'Sending…' : 'Send link'}
                            </Button>
                        }
                    />
                </AuthFields>
            </form>
        </AuthLayout>
    );
}

export function CheckEmailStep({ purpose }: { purpose: 'register' | 'recover' }) {
    // Rendered on the server without storage; the address arrives once the page hydrates.
    const raw = useSyncExternalStore(noSubscription, readSent, () => null);
    let sent: Sent | null = null;
    try {
        const parsed = raw ? (JSON.parse(raw) as Sent) : null;
        sent = parsed?.purpose === purpose ? parsed : null;
    } catch {
        sent = null;
    }
    const [resent, setResent] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function resend() {
        if (!sent) return;
        setPending(true);
        setError('');
        try {
            await authClient.requestEmail(sent.email, sent.purpose, sent.intent);
            cue('success');
            setResent(true);
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <AuthLayout
            icon={<MailIcon strokeWidth={1.9} aria-hidden="true" />}
            title="Check your inbox"
            description={
                <>
                    We sent a link to{' '}
                    {sent ? (
                        <span className="font-semibold text-foreground">{sent.email}</span>
                    ) : (
                        'your email'
                    )}
                    . Open it to {purpose === 'register' ? 'carry on' : 'reset your password'}. It
                    works once, for 30 minutes.
                </>
            }
        >
            {resent && sent && <AuthNote tone="success">New link sent to {sent.email}.</AuthNote>}
            {error && <AuthNote tone="danger">{error}</AuthNote>}
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                <Link to={purpose === 'register' ? '/register' : '/recover'} className={authLink}>
                    Use another email
                </Link>
                {sent && (
                    <button
                        type="button"
                        disabled={pending}
                        onClick={() => void resend()}
                        className="cursor-pointer font-semibold underline underline-offset-4 hover:text-primary disabled:opacity-60"
                    >
                        {pending ? 'Sending…' : 'Send a new link'}
                    </button>
                )}
            </div>
            <p className="text-[13px] text-muted-foreground">
                Not there? Check your spam folder. You can close this tab; the link opens a new
                page.
            </p>
        </AuthLayout>
    );
}

/*
 * The plan picked on the pricing page, said once at the top of sign-up: what it
 * is, what it costs, and that paying comes after the account exists.
 */
function ChosenPlan({ id }: { id: string }) {
    const { data: catalogue } = useQuery(catalogueQueryOptions);
    const { data: hint } = useQuery(localeHintQueryOptions);
    const plan = catalogue?.plans.find((candidate) => candidate.id === id);
    if (!catalogue || !plan) return null;
    const currencies = currenciesOf(catalogue.plans);
    const currency = pickCurrency({
        hint,
        available: currencies,
        fallback: currencies[0] ?? plan.currency,
    });
    const price = priceOf(plan, currency);
    const name = plan.name.replace(/\s*\((monthly|yearly|annual)\)\s*$/i, '');
    return (
        <div className="flex items-start justify-between gap-4 rounded-md bg-accent px-4 py-3 text-accent-foreground">
            <span className="flex flex-col gap-0.5">
                <span className="text-[15px] font-bold">
                    {name} · {formatQuota(plan.quotaBytes)}
                </span>
                <span className="text-sm">
                    {plan.interval === 'year'
                        ? `${formatMoney(Math.round(price.amount / 12), price.currency)} a month, billed ${formatMoney(price.amount, price.currency)} yearly.`
                        : `${formatMoney(price.amount, price.currency)} a month.`}{' '}
                    You pay after your account is set up.
                </span>
            </span>
            <Link
                to="/pricing"
                className="shrink-0 text-sm font-semibold underline underline-offset-2"
            >
                Change
            </Link>
        </div>
    );
}

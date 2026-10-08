import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Segmented, SettingsGroup } from '@/components/settings';
import { StorageCard } from '@/components/storage-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { billingApi } from '@/lib/billing-api';
import { pickCurrency } from '@/lib/currency';
import { authError } from '@/lib/form';
import { usePageRestored } from '@/lib/page-restore';
import { currenciesOf, priceOf, tiersOf } from '@/lib/plans';
import {
    billingQueryOptions,
    catalogueQueryOptions,
    formatMoney,
    formatQuota,
    localeHintQueryOptions,
    storageQueryOptions,
} from '@/lib/queries';
import { cue } from '@/lib/sounds';
import type { BillingSubscription, BillingSummary, Plan } from '@hushos/billing/api';
import {
    CANCELLATION_REASONS,
    cancellationReasonLabels,
    type CancellationReason,
} from '@hushos/billing/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { cn } from 'cn';
import {
    ArrowUpRightIcon,
    CheckIcon,
    CircleAlertIcon,
    CircleCheckIcon,
    InfoIcon,
    TriangleAlertIcon,
} from 'lucide-react';
import { formatDay } from '@/lib/drive';
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export const Route = createFileRoute('/_authenticated/app/billing')({
    loader: ({ context }) =>
        Promise.all([
            context.queryClient.ensureQueryData(catalogueQueryOptions),
            context.queryClient.ensureQueryData(billingQueryOptions),
            context.queryClient.ensureQueryData(localeHintQueryOptions),
        ]).catch(() => null),
    head: () => ({ meta: [{ title: 'Plan and storage · HushOS' }] }),
    validateSearch: (search: Record<string, unknown>): { checkout_id?: string; plan?: string } => ({
        ...(typeof search.checkout_id === 'string' ? { checkout_id: search.checkout_id } : {}),
        ...(typeof search.plan === 'string' ? { plan: search.plan } : {}),
    }),
    component: BillingPage,
});

/*
 * Plan and storage. People come with two questions, how much room is left and
 * what is using it, so storage comes first, broken down. Then the plan they
 * are on, then the others. Changing plan, cancelling and the card are each one
 * step and say what will happen in plain words; Polar takes the payment.
 */

type Tone = 'info' | 'success' | 'warning' | 'danger' | 'quiet';

/* One notice at a time, at the top: what just happened, or what is happening. */
function Notice({ tone, busy, children }: { tone: Tone; busy?: boolean; children: ReactNode }) {
    const Icon =
        tone === 'success'
            ? CircleCheckIcon
            : tone === 'danger'
              ? CircleAlertIcon
              : tone === 'warning'
                ? TriangleAlertIcon
                : InfoIcon;
    return (
        <div
            role={tone === 'danger' ? 'alert' : 'status'}
            className={cn(
                'flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm leading-snug',
                tone === 'info' && 'bg-accent text-accent-foreground',
                tone === 'success' && 'bg-success-soft text-success',
                tone === 'danger' && 'bg-destructive-soft text-destructive',
                (tone === 'quiet' || tone === 'warning') && 'border border-rule bg-muted',
            )}
        >
            {busy ? (
                <Spinner className="mt-0.5 size-4 shrink-0" />
            ) : (
                tone !== 'quiet' && (
                    <Icon
                        className={cn(
                            'mt-0.5 size-4 shrink-0',
                            tone === 'warning' && 'text-warning',
                        )}
                        aria-hidden="true"
                    />
                )
            )}
            <span>{children}</span>
        </div>
    );
}

const longDay = (value: string) => formatDay(value);

const per = { month: 'a month', year: 'a year' } as const;

function priceLine(plan: Plan, currency: string) {
    const price = priceOf(plan, currency);
    return `${formatMoney(price.amount, price.currency)} ${per[plan.interval]}`;
}

/* What the person actually pays: the subscription's own amount, else the plan's. */
function paying(live: BillingSubscription, plan: Plan | undefined, currency: string) {
    const interval = live.recurringInterval === 'year' ? 'year' : 'month';
    if (live.amount != null && live.currency)
        return `${formatMoney(live.amount, live.currency)} ${per[interval]}`;
    return plan ? priceLine(plan, currency) : null;
}

function BillingPage() {
    const { user } = Route.useRouteContext();
    const { checkout_id: checkoutId, plan: intendedPlan } = Route.useSearch();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const catalogue = useQuery(catalogueQueryOptions);
    const summary = useQuery(billingQueryOptions);
    const hint = useQuery(localeHintQueryOptions);
    const [busy, setBusy] = useState<string | null>(null);
    const [cancelling, setCancelling] = useState(false);
    const [notice, setNotice] = useState<{ tone: Tone; text: string; busy?: boolean } | null>(null);
    const subscription = summary.data?.subscription;
    const live = subscription && !subscription.endedAt ? subscription : null;
    const activating = Boolean(checkoutId) && !live;
    // A subscriber sees every plan in the currency they already pay in; anyone else
    // in the one their country or language suggests, as on the pricing page.
    const plans = catalogue.data?.plans;
    const currencies = currenciesOf(plans ?? []);
    const currency = pickCurrency({
        requested: live?.currency,
        hint: hint.data,
        available: currencies,
        fallback: currencies[0] ?? 'usd',
    });
    const tiers = tiersOf(plans ?? []);
    const intervals = new Set((plans ?? []).map((plan) => plan.interval));
    const [period, setPeriod] = useState<'month' | 'year'>(
        live?.recurringInterval === 'year' ? 'year' : 'month',
    );

    const settle = useCallback(
        (next: BillingSummary) => {
            queryClient.setQueryData(billingQueryOptions.queryKey, next);
            void queryClient.invalidateQueries({ queryKey: storageQueryOptions.queryKey });
        },
        [queryClient],
    );

    // Back from checkout: the webhook is usually ahead of us, but not always, so
    // the summary is polled every two seconds, fifteen times at most, until it is live.
    const ACTIVATION_TRIES = 15;
    const activation = useQuery({
        queryKey: ['billing', 'checkout', checkoutId],
        queryFn: () => billingApi.sync(),
        enabled: Boolean(checkoutId),
        retry: false,
        staleTime: Infinity,
        refetchOnWindowFocus: false,
        refetchInterval: (query) => {
            const found = query.state.data?.subscription;
            if (found && !found.endedAt) return false;
            return query.state.dataUpdateCount + query.state.errorUpdateCount >= ACTIVATION_TRIES
                ? false
                : 2_000;
        },
    });
    useEffect(() => {
        const next = activation.data;
        if (!next) return;
        settle(next);
        if (next.subscription && !next.subscription.endedAt) {
            cue('success');
            setNotice({
                tone: 'success',
                text: `You’re on ${next.subscription.productName}. Thank you.`,
            });
            void navigate({ to: '/app/billing', search: {}, replace: true });
        }
    }, [activation.data, navigate, settle]);
    // Read from the cache: the observer result doesn't carry the counts.
    const activationState = checkoutId
        ? queryClient.getQueryState(['billing', 'checkout', checkoutId])
        : undefined;
    const activationTries =
        (activationState?.dataUpdateCount ?? 0) + (activationState?.errorUpdateCount ?? 0);
    const stillActivating = Boolean(checkoutId) && activationTries >= ACTIVATION_TRIES && !live;

    // Back from Polar restores this page with `busy` still set.
    usePageRestored(() => setBusy(null));

    /*
     * An action that redirects says so, and stays busy until the browser has
     * actually left; clearing it first makes the button flash back to idle.
     */
    async function run(key: string, action: () => Promise<void | 'redirected'>) {
        setBusy(key);
        setNotice(null);
        try {
            const outcome = await action();
            if (outcome !== 'redirected') setBusy(null);
            return true;
        } catch (error) {
            cue('error');
            setNotice({ tone: 'danger', text: authError(error) });
            setBusy(null);
            return false;
        }
    }

    const choose = (plan: Plan) =>
        run(plan.id, async () => {
            const { url, confirmPayment } = await billingApi.checkout(plan.id, currency);
            if (url) {
                if (confirmPayment)
                    setNotice({
                        tone: 'warning',
                        text: `Your bank needs to confirm this payment. ${plan.name} starts once it’s confirmed.`,
                    });
                window.location.assign(url);
                return 'redirected';
            }
            settle(await billingApi.summary());
            cue('success');
            setNotice({ tone: 'success', text: `You’re on ${plan.name}. Thank you.` });
        });

    const portal = () =>
        run('portal', async () => {
            const { url } = await billingApi.portal();
            window.location.assign(url);
            return 'redirected';
        });

    const resume = () =>
        run('resume', async () => {
            settle(await billingApi.resume());
            cue('success');
            setNotice({ tone: 'success', text: 'Your plan will renew as usual.' });
        });

    // `?plan=` is the plan being considered. A new subscriber goes straight to
    // Polar's checkout, which is its own confirmation; a paid subscriber sees a
    // confirmation here, and the plan stays in the URL until they decide, so a
    // refresh or a shared link lands on the same question.
    const summaryLoaded = summary.data !== undefined;
    const switching =
        live && intendedPlan && intendedPlan !== live.productId
            ? (plans?.find((candidate) => candidate.id === intendedPlan) ?? null)
            : null;
    const clearPlan = () => navigate({ to: '/app/billing', search: {}, replace: true });
    const started = useRef<string | null>(null);
    useEffect(() => {
        if (!intendedPlan || !plans || !summaryLoaded || started.current === intendedPlan) return;
        started.current = intendedPlan;
        const plan = plans.find((candidate) => candidate.id === intendedPlan);
        if (plan && !live) void choose(plan);
        // `choose` and `live` are read once, when the intent is consumed.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [intendedPlan, plans, summaryLoaded]);

    const selling = catalogue.data?.enabled !== false;
    const livePlan = live ? plans?.find((plan) => plan.id === live.productId) : undefined;
    const overdue = live?.status === 'past_due';
    const shown =
        notice ??
        (activating && !stillActivating
            ? { tone: 'info' as const, busy: true, text: 'Payment received. Turning on your plan…' }
            : stillActivating
              ? {
                    tone: 'warning' as const,
                    text: 'Payment received, but the plan is still turning on. Refresh in a minute.',
                }
              : live?.cancelAtPeriodEnd
                ? {
                      tone: 'quiet' as const,
                      text: `Your plan ends on ${longDay(live.currentPeriodEnd)}. Resume any time before then to keep it.`,
                  }
                : !selling
                  ? {
                        tone: 'quiet' as const,
                        text: 'This HushOS server doesn’t sell plans. Ask whoever runs it if you need more room.',
                    }
                  : null);

    return (
        <div className="flex flex-col pb-10">
            <PageHeader title={selling ? 'Plan and storage' : 'Storage'} />
            <div className="flex max-w-4xl flex-col gap-9 px-5 sm:px-8">
                {shown && (
                    <Notice tone={shown.tone} busy={'busy' in shown && shown.busy}>
                        {shown.text}
                    </Notice>
                )}

                <SettingsGroup title="Storage">
                    <div className="pt-4">
                        <StorageCard userId={user.id} />
                    </div>
                </SettingsGroup>

                {selling && (
                    <SettingsGroup title="Your plan">
                        <div
                            className={cn(
                                'mt-4 flex flex-col gap-4 rounded-xl border p-5',
                                overdue ? 'border-destructive' : 'border-rule',
                            )}
                        >
                            <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                                <div className="flex min-w-0 flex-col gap-1">
                                    <span className="text-xl font-bold">
                                        {summary.isPending
                                            ? 'Your plan'
                                            : live
                                              ? `${live.productName} · ${formatQuota(live.quotaBytes)}`
                                              : `Free · ${catalogue.data ? formatQuota(catalogue.data.freeQuotaBytes) : ''}`}
                                    </span>
                                    <span className="text-sm text-muted-foreground">
                                        {live ? (
                                            <>
                                                {paying(live, livePlan, currency)} ·{' '}
                                                {live.cancelAtPeriodEnd ? (
                                                    <span className="font-semibold text-foreground">
                                                        ends {longDay(live.currentPeriodEnd)}
                                                    </span>
                                                ) : overdue ? (
                                                    <span className="font-semibold text-destructive">
                                                        payment overdue
                                                    </span>
                                                ) : (
                                                    `renews ${longDay(live.currentPeriodEnd)}`
                                                )}
                                            </>
                                        ) : (
                                            'Choose a plan below when you need more room.'
                                        )}
                                    </span>
                                </div>
                                <div className="flex shrink-0 flex-wrap gap-2">
                                    {live?.cancelAtPeriodEnd ? (
                                        <Button
                                            disabled={busy !== null}
                                            onClick={() => void resume()}
                                        >
                                            {busy === 'resume' ? 'Resuming…' : 'Resume plan'}
                                        </Button>
                                    ) : overdue ? (
                                        <Button
                                            disabled={busy !== null}
                                            onClick={() => void portal()}
                                        >
                                            {busy === 'portal' ? 'Opening…' : 'Update card'}
                                            <ArrowUpRightIcon />
                                        </Button>
                                    ) : (
                                        summary.data?.hasCustomer && (
                                            <Button
                                                variant="outline"
                                                disabled={busy !== null}
                                                onClick={() => void portal()}
                                            >
                                                {busy === 'portal'
                                                    ? 'Opening…'
                                                    : 'Card and invoices'}
                                                <ArrowUpRightIcon />
                                            </Button>
                                        )
                                    )}
                                </div>
                            </div>
                            {overdue && (
                                <Notice tone="danger">
                                    Your last payment didn’t go through. Update your card to keep{' '}
                                    {live.productName}.
                                </Notice>
                            )}
                            {live && !live.cancelAtPeriodEnd && !overdue && (
                                <button
                                    type="button"
                                    disabled={busy !== null}
                                    onClick={() => setCancelling(true)}
                                    className="w-fit cursor-pointer text-sm font-semibold underline underline-offset-4 hover:text-destructive disabled:opacity-50"
                                >
                                    Cancel plan
                                </button>
                            )}
                        </div>
                    </SettingsGroup>
                )}

                {selling && (
                    <SettingsGroup
                        title="Plans"
                        action={
                            intervals.size > 1 && (
                                <Segmented
                                    label="Billed"
                                    options={[
                                        { value: 'month', label: 'Monthly' },
                                        { value: 'year', label: 'Yearly' },
                                    ]}
                                    value={period}
                                    onChange={setPeriod}
                                />
                            )
                        }
                    >
                        {tiers.length ? (
                            <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                                <PlanCard
                                    name="Free"
                                    size={
                                        catalogue.data
                                            ? formatQuota(catalogue.data.freeQuotaBytes)
                                            : ''
                                    }
                                    price="Free"
                                    current={!live && !summary.isPending}
                                    footer={
                                        live ? (
                                            <span className="text-[13px] text-muted-foreground">
                                                Where you land if you cancel
                                            </span>
                                        ) : undefined
                                    }
                                />
                                {tiers.map((tier) => {
                                    const plan = tier[period] ?? tier.month ?? tier.year!;
                                    const current = live?.productId === plan.id;
                                    return (
                                        <PlanCard
                                            key={tier.key}
                                            name={tier.name}
                                            size={formatQuota(tier.quotaBytes)}
                                            price={`${priceLine(plan, currency)}${plan.interval === 'year' ? ' · 2 months free' : ''}`}
                                            recommended={tier.recommended && !current}
                                            current={current}
                                            footer={
                                                current ? undefined : (
                                                    <Button
                                                        className="w-full"
                                                        variant={
                                                            tier.recommended ? 'default' : 'outline'
                                                        }
                                                        disabled={busy !== null || activating}
                                                        onClick={() => {
                                                            if (live)
                                                                void navigate({
                                                                    to: '/app/billing',
                                                                    search: { plan: plan.id },
                                                                });
                                                            else void choose(plan);
                                                        }}
                                                    >
                                                        {busy === plan.id
                                                            ? 'Opening…'
                                                            : live
                                                              ? `Switch to ${tier.name}`
                                                              : `Choose ${tier.name}`}
                                                    </Button>
                                                )
                                            }
                                        />
                                    );
                                })}
                            </ul>
                        ) : (
                            <div className="mt-4">
                                <Notice tone="quiet">
                                    {catalogue.isPending
                                        ? 'Opening the plans…'
                                        : 'No plans are on sale right now.'}
                                </Notice>
                            </div>
                        )}
                        <p className="mt-3 text-[13px] text-muted-foreground">
                            Prices include tax where it applies. Payments are handled by Polar.
                        </p>
                    </SettingsGroup>
                )}
            </div>

            {live && (
                <CancelDialog
                    live={live}
                    freeSize={catalogue.data ? formatQuota(catalogue.data.freeQuotaBytes) : null}
                    open={cancelling}
                    onOpenChange={setCancelling}
                    onDone={(next) => {
                        setCancelling(false);
                        settle(next);
                        setNotice(null);
                    }}
                />
            )}
            <Dialog
                open={Boolean(switching)}
                onOpenChange={(open) => !open && busy === null && void clearPlan()}
            >
                <DialogContent className="sm:max-w-[480px]">
                    {switching && (
                        <>
                            <DialogHeader>
                                <DialogTitle>Switch to {switching.name}?</DialogTitle>
                                <DialogDescription>
                                    {formatQuota(switching.quotaBytes)} for{' '}
                                    {priceLine(switching, currency)}. Your plan changes now. The
                                    difference for the rest of this period is charged to the card
                                    you pay with, or credited if it’s less.
                                </DialogDescription>
                            </DialogHeader>
                            <DialogFooter>
                                <Button
                                    variant="outline"
                                    disabled={busy !== null}
                                    onClick={() => void clearPlan()}
                                >
                                    Keep my current plan
                                </Button>
                                <Button
                                    disabled={busy !== null}
                                    onClick={() => {
                                        void choose(switching).then((done) => {
                                            if (done) void clearPlan();
                                        });
                                    }}
                                >
                                    {busy === switching.id
                                        ? 'Switching…'
                                        : `Switch to ${switching.name}`}
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>
        </div>
    );
}

function PlanCard({
    name,
    size,
    price,
    current,
    recommended,
    footer,
}: {
    name: string;
    size: string;
    price: string;
    current: boolean;
    recommended?: boolean;
    footer?: ReactNode;
}) {
    return (
        <li
            data-plan={name}
            className={cn(
                'flex flex-col gap-3 rounded-xl border p-4',
                current ? 'border-primary bg-accent/40 ring-1 ring-primary' : 'border-rule',
            )}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-base font-bold">{name}</span>
                {recommended && <Badge variant="secondary">Recommended</Badge>}
                {current && (
                    <span className="flex items-center gap-1 text-xs font-semibold text-primary">
                        <CheckIcon className="size-3.5" strokeWidth={3} aria-hidden="true" />
                        Yours
                    </span>
                )}
            </div>
            <span className="text-2xl leading-none font-extrabold tracking-[-0.02em] tabular-nums">
                {size}
            </span>
            <span className="text-sm text-muted-foreground">{price}</span>
            <div className="mt-auto pt-1">
                {current ? (
                    <span className="flex h-9 items-center text-sm font-semibold text-muted-foreground">
                        Your plan
                    </span>
                ) : (
                    footer
                )}
            </div>
        </li>
    );
}

const reasonItems = [
    { value: '', label: 'Prefer not to say' },
    ...CANCELLATION_REASONS.map((value) => ({ value, label: cancellationReasonLabels[value] })),
];

/* Says what you keep and until when, then asks why; the reason goes to Polar with it. */
function CancelDialog({
    live,
    freeSize,
    open,
    onOpenChange,
    onDone,
}: {
    live: BillingSubscription;
    freeSize: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDone: (summary: BillingSummary) => void;
}) {
    const id = useId();
    const [reason, setReason] = useState<CancellationReason | ''>('');
    const [comment, setComment] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function submit() {
        setPending(true);
        setError('');
        try {
            const summary = await billingApi.cancel({
                reason: reason || undefined,
                comment: comment.trim() || undefined,
            });
            cue('success');
            onDone(summary);
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                    <DialogTitle>Cancel {live.productName}?</DialogTitle>
                    <DialogDescription>
                        You keep {live.productName} and {formatQuota(live.quotaBytes)} until{' '}
                        {longDay(live.currentPeriodEnd)}. After that you’re on Free
                        {freeSize ? `, with ${freeSize}` : ''}. Nothing is deleted.
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={`${id}-reason`} className="text-[13px] font-semibold">
                        Why are you cancelling?
                    </label>
                    <Select
                        value={reason}
                        disabled={pending}
                        onValueChange={(value) =>
                            setReason((value ?? '') as CancellationReason | '')
                        }
                        items={reasonItems}
                    >
                        <SelectTrigger id={`${id}-reason`} className="w-full">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {reasonItems.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                    {item.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={`${id}-comment`} className="text-[13px] font-semibold">
                        Anything else?{' '}
                        <span className="font-normal text-muted-foreground">· optional</span>
                    </label>
                    <Textarea
                        id={`${id}-comment`}
                        maxLength={500}
                        disabled={pending}
                        value={comment}
                        onChange={(event) => setComment(event.target.value)}
                        className="min-h-20 text-[15px]"
                    />
                </div>
                {error && (
                    <p role="alert" className="text-[13px] text-destructive">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() => onOpenChange(false)}
                    >
                        Keep my plan
                    </Button>
                    <Button variant="destructive" disabled={pending} onClick={() => void submit()}>
                        {pending ? 'Cancelling…' : 'Cancel plan'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

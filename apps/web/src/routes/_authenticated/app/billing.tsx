import { Collapse, PendingLabel } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { billingApi } from '@/lib/billing-api';
import { pickCurrency } from '@/lib/currency';
import { authError } from '@/lib/form';
import { usePageRestored } from '@/lib/page-restore';
import { currenciesOf, priceOf } from '@/lib/plans';
import {
    billingQueryOptions,
    catalogueQueryOptions,
    formatGiB,
    formatMoney,
    localeHintQueryOptions,
    storageQueryOptions,
} from '@/lib/queries';
import { cue } from '@/lib/sounds';
import type { BillingSummary, Plan } from '@hushos/billing/api';
import {
    CANCELLATION_REASONS,
    cancellationReasonLabels,
    type CancellationReason,
} from '@hushos/billing/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowRightIcon, ExternalLinkIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

export const Route = createFileRoute('/_authenticated/app/billing')({
    loader: ({ context }) =>
        Promise.all([
            context.queryClient.ensureQueryData(catalogueQueryOptions),
            context.queryClient.ensureQueryData(billingQueryOptions),
            context.queryClient.ensureQueryData(localeHintQueryOptions),
        ]).catch(() => null),
    head: () => ({ meta: [{ title: 'Billing · HushOS' }] }),
    validateSearch: (search: Record<string, unknown>): { checkout_id?: string; plan?: string } => ({
        ...(typeof search.checkout_id === 'string' ? { checkout_id: search.checkout_id } : {}),
        ...(typeof search.plan === 'string' ? { plan: search.plan } : {}),
    }),
    component: BillingPage,
});

/* A key and its value on one line, joined to the next by a dotted leader. */
function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-dotted border-rule px-4 py-3 text-sm last:border-b-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-medium tabular-nums wrap-anywhere">{value}</dd>
        </div>
    );
}

function Section({
    id,
    title,
    description,
    children,
}: {
    id: string;
    title: string;
    description: string;
    children: React.ReactNode;
}) {
    return (
        <section aria-labelledby={id} className="flex flex-col gap-4">
            <div>
                <h2 id={id} className="text-lg font-bold">
                    {title}
                </h2>
                <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                    {description}
                </p>
            </div>
            {children}
        </section>
    );
}

/* What just happened, said once inside the box it concerns. */
function Note({
    tone = 'default',
    children,
}: {
    tone?: 'default' | 'success' | 'destructive';
    children: React.ReactNode;
}) {
    return (
        <p
            role={tone === 'destructive' ? 'alert' : undefined}
            className={`px-4 py-3 text-sm leading-relaxed ${
                tone === 'destructive'
                    ? 'bg-destructive-soft text-destructive'
                    : tone === 'success'
                      ? 'bg-success-soft text-success'
                      : 'text-muted-foreground'
            }`}
        >
            {children}
        </p>
    );
}

const box = 'overflow-hidden rounded-md border border-rule';

function formatDay(value: string) {
    return new Date(value).toLocaleDateString(undefined, {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
    });
}

const intervalLabel = { month: 'month', year: 'year' } as const;

function planPrice(plan: Plan, currency: string) {
    const price = priceOf(plan, currency);
    return `${formatMoney(price.amount, price.currency)} / ${intervalLabel[plan.interval]}`;
}

const reasonItems = [
    { value: '', label: 'Prefer not to say' },
    ...CANCELLATION_REASONS.map((value) => ({ value, label: cancellationReasonLabels[value] })),
];

/* Sent to Polar with the cancellation, so churn reasons land in its dashboard. */
function CancelForm({
    endsOn,
    onCancel,
    onDone,
}: {
    endsOn: string;
    onCancel: () => void;
    onDone: (summary: BillingSummary) => void;
}) {
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
                comment: comment || undefined,
            });
            cue('success');
            onDone(summary);
        } catch (error) {
            cue('error');
            setError(authError(error));
        } finally {
            setPending(false);
        }
    }
    return (
        <form
            noValidate
            aria-busy={pending}
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
        >
            <Note>
                Your plan stays active until {formatDay(endsOn)}. After that your allowance returns
                to the free tier. Nothing is deleted, and you can resume any time before then.
            </Note>
            <div className="flex flex-col gap-4 px-4 pb-4">
                <div className="flex max-w-md flex-col gap-1.5">
                    <Label htmlFor="cancel-reason">Reason</Label>
                    <Select
                        value={reason}
                        disabled={pending}
                        onValueChange={(value) =>
                            setReason((value ?? '') as CancellationReason | '')
                        }
                        items={reasonItems}
                    >
                        <SelectTrigger id="cancel-reason">
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
                <div className="flex max-w-md flex-col gap-1.5">
                    <Label htmlFor="cancel-comment">Comment</Label>
                    <Input
                        id="cancel-comment"
                        type="text"
                        value={comment}
                        maxLength={500}
                        disabled={pending}
                        placeholder="Optional"
                        onChange={(event) => setComment(event.target.value)}
                    />
                </div>
                {error && (
                    <div className="overflow-hidden rounded-md">
                        <Note tone="destructive">{error}</Note>
                    </div>
                )}
                <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                    <Button type="submit" variant="destructive" disabled={pending}>
                        <PendingLabel pending={pending} idle="Cancel plan" busy="Cancelling…" />
                        <ArrowRightIcon aria-hidden="true" />
                    </Button>
                    <button
                        type="button"
                        className="text-link cursor-pointer text-sm"
                        disabled={pending}
                        onClick={onCancel}
                    >
                        Keep my plan
                    </button>
                </div>
            </div>
        </form>
    );
}

function BillingPage() {
    const { checkout_id: checkoutId, plan: intendedPlan } = Route.useSearch();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const catalogue = useQuery(catalogueQueryOptions);
    const summary = useQuery(billingQueryOptions);
    const hint = useQuery(localeHintQueryOptions);
    const [busy, setBusy] = useState<string | null>(null);
    const [cancelling, setCancelling] = useState(false);

    const [notice, setNotice] = useState('');
    const [error, setError] = useState('');
    const subscription = summary.data?.subscription;
    const live = subscription && !subscription.endedAt ? subscription : null;
    const activating = Boolean(checkoutId) && !live;
    // A subscriber sees every plan in the currency they already pay in; anyone else
    // in the one their country or language suggests, as on the pricing page.
    const currencies = currenciesOf(catalogue.data?.plans ?? []);
    const currency = pickCurrency({
        requested: live?.currency,
        hint: hint.data,
        available: currencies,
        fallback: currencies[0] ?? 'usd',
    });

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
            setNotice(`You're on ${next.subscription.productName}. Thank you.`);
            void navigate({ to: '/app/billing', search: {}, replace: true });
        }
    }, [activation.data, navigate, settle]);
    useEffect(() => {
        if (!checkoutId) return;
        const state = queryClient.getQueryState(['billing', 'checkout', checkoutId]);
        const tries = (state?.dataUpdateCount ?? 0) + (state?.errorUpdateCount ?? 0);
        const found = activation.data?.subscription;
        if (tries >= ACTIVATION_TRIES && !(found && !found.endedAt))
            setError('Payment received, but the plan is still activating. Refresh in a minute.');
    }, [
        checkoutId,
        queryClient,
        activation.data,
        activation.dataUpdatedAt,
        activation.errorUpdatedAt,
    ]);

    // Back from Polar restores this page with `busy` still set.
    usePageRestored(() => setBusy(null));

    /*
     * An action that redirects says so, and stays busy until the browser has
     * actually left; clearing it first makes the button flash back to idle.
     */
    async function run(key: string, action: () => Promise<void | 'redirected'>) {
        setBusy(key);
        setError('');
        setNotice('');
        try {
            const outcome = await action();
            if (outcome !== 'redirected') setBusy(null);
            return true;
        } catch (error) {
            cue('error');
            setError(authError(error));
            setBusy(null);
            return false;
        }
    }

    const choose = (plan: Plan) =>
        run(plan.id, async () => {
            const { url, confirmPayment } = await billingApi.checkout(plan.id, currency);
            if (url) {
                if (confirmPayment)
                    setNotice(
                        'Your bank needs to confirm this payment. Taking you to the billing portal to finish it…',
                    );
                window.location.assign(url);
                return 'redirected';
            }
            settle(await billingApi.summary());
            cue('success');
            setNotice(`You're on ${plan.name}. Your plan will renew as usual.`);
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
            setNotice('Your plan will renew as usual.');
        });

    // `?plan=` is the plan being considered. A new subscriber goes straight to
    // Polar's checkout, which is its own confirmation; a paid subscriber sees a
    // confirmation here, and the plan stays in the URL until they decide, so a
    // refresh or a shared link lands on the same question.
    const plans = catalogue.data?.plans;
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

    if (catalogue.data && !catalogue.data.enabled)
        return (
            <div className="flex flex-col">
                <PageHeader
                    eyebrow="Account"
                    title="Billing"
                    description="This server does not offer paid plans. Your allowance is set by whoever runs it."
                />
            </div>
        );

    const planActions =
        summary.data?.hasCustomer || (live && (live.cancelAtPeriodEnd || !cancelling));
    return (
        <div className="flex flex-col">
            <PageHeader
                eyebrow="Account"
                title="Billing"
                description="Your plan, your storage allowance, and your invoices."
            />
            <div className="flex max-w-5xl flex-col gap-10 px-5 py-6 sm:px-8 sm:py-8">
                <Section
                    id="plan-title"
                    title="Your plan"
                    description={
                        live
                            ? 'Invoices, receipts, and your payment method live in the billing portal, run by Polar as our merchant of record.'
                            : 'Every account starts on the free tier. Upgrade below when you need more room.'
                    }
                >
                    <div className={`${box} max-w-2xl`}>
                        <Collapse open={Boolean(notice)} className="border-b border-rule">
                            <output className="block">
                                <Note tone="success">{notice}</Note>
                            </output>
                        </Collapse>
                        <Collapse open={activating && !error} className="border-b border-rule">
                            <Note>Payment received. Activating your plan…</Note>
                        </Collapse>
                        <Collapse open={Boolean(error)} className="border-b border-rule">
                            <Note tone="destructive">{error}</Note>
                        </Collapse>
                        <dl>
                            <Row
                                label="Plan"
                                value={summary.isPending ? '-' : live ? live.productName : 'Free'}
                            />
                            <Row
                                label="Storage"
                                value={
                                    summary.isPending
                                        ? '-'
                                        : live
                                          ? formatGiB(live.quotaBytes)
                                          : catalogue.data
                                            ? formatGiB(catalogue.data.freeQuotaBytes)
                                            : '-'
                                }
                            />
                            {live && (
                                <Row
                                    label={live.cancelAtPeriodEnd ? 'Ends' : 'Renews'}
                                    value={formatDay(live.currentPeriodEnd)}
                                />
                            )}
                            {live?.status === 'past_due' && (
                                <Row
                                    label="Status"
                                    value="Payment overdue. Update your card in the portal."
                                />
                            )}
                        </dl>
                        {planActions && (
                            <div className="flex flex-wrap gap-2 border-t border-rule px-4 py-3">
                                {summary.data?.hasCustomer && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        disabled={busy !== null}
                                        onClick={() => void portal()}
                                    >
                                        <PendingLabel
                                            pending={busy === 'portal'}
                                            idle="Manage billing"
                                            busy="Opening…"
                                        />
                                        <ExternalLinkIcon aria-hidden="true" />
                                    </Button>
                                )}
                                {live && live.cancelAtPeriodEnd && (
                                    <Button
                                        size="sm"
                                        disabled={busy !== null}
                                        onClick={() => void resume()}
                                    >
                                        <PendingLabel
                                            pending={busy === 'resume'}
                                            idle="Resume plan"
                                            busy="Resuming…"
                                        />
                                        <ArrowRightIcon aria-hidden="true" />
                                    </Button>
                                )}
                                {live && !live.cancelAtPeriodEnd && !cancelling && (
                                    <Button
                                        variant="destructive-outline"
                                        size="sm"
                                        className="sm:ml-auto"
                                        disabled={busy !== null}
                                        onClick={() => {
                                            setCancelling(true);
                                            setNotice('');
                                            setError('');
                                        }}
                                    >
                                        Cancel plan <ArrowRightIcon aria-hidden="true" />
                                    </Button>
                                )}
                            </div>
                        )}
                        {live && !live.cancelAtPeriodEnd && (
                            <Collapse open={cancelling} className="border-t border-rule">
                                <CancelForm
                                    endsOn={live.currentPeriodEnd}
                                    onCancel={() => setCancelling(false)}
                                    onDone={(next) => {
                                        setCancelling(false);
                                        settle(next);
                                        setNotice(
                                            `Your plan ends on ${formatDay(live.currentPeriodEnd)}.`,
                                        );
                                    }}
                                />
                            </Collapse>
                        )}
                    </div>
                </Section>
                <Section
                    id="plans-title"
                    title="Plans"
                    description="Prices include tax where it applies. Switching plans charges or credits the prorated difference to your saved card straight away; yearly plans cost ten months."
                >
                    <Collapse open={Boolean(switching)}>
                        {switching && (
                            <div className={`${box} max-w-2xl bg-accent/50`}>
                                <p className="px-4 pt-3.5 text-sm leading-relaxed">
                                    Switch to {switching.name}, {formatGiB(switching.quotaBytes)}{' '}
                                    for {planPrice(switching, currency)}? Your plan changes now and
                                    the prorated difference is charged, or credited, to your saved
                                    card.
                                </p>
                                <div className="flex flex-wrap items-center gap-x-5 gap-y-3 px-4 py-3.5">
                                    <Button
                                        disabled={busy !== null}
                                        onClick={() => {
                                            void choose(switching).then((done) => {
                                                if (done) void clearPlan();
                                            });
                                        }}
                                    >
                                        <PendingLabel
                                            pending={busy === switching.id}
                                            idle="Confirm switch"
                                            busy="Switching…"
                                        />
                                        <ArrowRightIcon aria-hidden="true" />
                                    </Button>
                                    <button
                                        type="button"
                                        className="text-link cursor-pointer text-sm"
                                        disabled={busy !== null}
                                        onClick={() => void clearPlan()}
                                    >
                                        Keep my current plan
                                    </button>
                                </div>
                            </div>
                        )}
                    </Collapse>
                    {catalogue.data?.plans.length ? (
                        <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                            {catalogue.data.plans.map((plan) => {
                                const current = live?.productId === plan.id;
                                return (
                                    <li
                                        key={plan.id}
                                        className={`flex flex-col gap-4 rounded-md border p-5 ${
                                            plan.recommended
                                                ? 'border-primary ring-[3px] ring-accent'
                                                : 'border-rule'
                                        }`}
                                    >
                                        <div className="flex flex-1 flex-col gap-1.5">
                                            <p className="flex flex-wrap items-center justify-between gap-2 text-sm font-semibold">
                                                {plan.name}
                                                {plan.recommended && <Badge>Recommended</Badge>}
                                            </p>
                                            <p className="text-3xl font-bold tracking-tight tabular-nums">
                                                {formatGiB(plan.quotaBytes)}
                                            </p>
                                            {plan.description && (
                                                <p className="text-sm leading-relaxed text-muted-foreground">
                                                    {plan.description}
                                                </p>
                                            )}
                                        </div>
                                        <p className="text-sm font-medium tabular-nums">
                                            {current && live?.amount != null && live.currency
                                                ? `${formatMoney(live.amount, live.currency)} / ${intervalLabel[plan.interval]}`
                                                : planPrice(plan, currency)}
                                        </p>
                                        <Button
                                            variant={
                                                !current && plan.recommended ? 'default' : 'outline'
                                            }
                                            className="w-full"
                                            disabled={
                                                (current && !live?.cancelAtPeriodEnd) ||
                                                busy !== null ||
                                                activating
                                            }
                                            onClick={() => {
                                                if (live && !current)
                                                    void navigate({
                                                        to: '/app/billing',
                                                        search: { plan: plan.id },
                                                    });
                                                else void choose(plan);
                                            }}
                                        >
                                            <PendingLabel
                                                pending={busy === plan.id}
                                                idle={
                                                    live?.cancelAtPeriodEnd
                                                        ? current
                                                            ? 'Resume'
                                                            : 'Switch'
                                                        : current
                                                          ? 'Current'
                                                          : live
                                                            ? 'Switch'
                                                            : 'Choose'
                                                }
                                                busy="Opening…"
                                            />
                                        </Button>
                                    </li>
                                );
                            })}
                        </ul>
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            {catalogue.isPending
                                ? 'Loading plans…'
                                : 'No plans are on sale right now.'}
                        </p>
                    )}
                </Section>
            </div>
        </div>
    );
}

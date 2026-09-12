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
import { FormActions, FormNote, FormRow, FormTable } from '@/components/form-rows';
import { Collapse, PendingLabel } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
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

const rowGrid = 'grid sm:grid-cols-[9.5rem_minmax(0,1fr)]';
const rowLabel =
    'eyebrow flex items-center px-4 pt-3.5 text-muted-foreground sm:h-12 sm:border-r sm:pt-0';
const rowValue =
    'flex min-w-0 items-center py-3.5 pr-5 pl-4 font-mono text-[13px] wrap-anywhere sm:h-12 sm:py-0 sm:pr-6';

function Row({ label, value }: { label: string; value: string }) {
    return (
        <div className={`${rowGrid} border-b last:border-b-0`}>
            <dt className={rowLabel}>{label}</dt>
            <dd className={rowValue}>{value}</dd>
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
        <section aria-labelledby={id} className="border-b">
            <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
                <div className="px-5 py-6 lg:border-r sm:px-8">
                    <h2 id={id} className="eyebrow">
                        {title}
                    </h2>
                    <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground">
                        {description}
                    </p>
                </div>
                <div className="border-t lg:border-t-0">{children}</div>
            </div>
        </section>
    );
}

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
            <FormTable className="border-0">
                <FormNote>
                    Your plan stays active until {formatDay(endsOn)}. After that your allowance
                    returns to the free tier. Nothing is deleted, and you can resume any time before
                    then.
                </FormNote>
                <FormRow label="Reason" htmlFor="cancel-reason">
                    <Select
                        value={reason}
                        disabled={pending}
                        onValueChange={(value) =>
                            setReason((value ?? '') as CancellationReason | '')
                        }
                        items={reasonItems}
                    >
                        <SelectTrigger
                            id="cancel-reason"
                            className="h-12 border-0 bg-transparent px-4 hover:bg-muted"
                        >
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
                </FormRow>
                <FormRow label="Comment" htmlFor="cancel-comment">
                    <input
                        id="cancel-comment"
                        type="text"
                        value={comment}
                        maxLength={500}
                        disabled={pending}
                        placeholder="Optional"
                        onChange={(event) => setComment(event.target.value)}
                        className="h-12 w-full bg-transparent px-4 font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus-visible:bg-muted"
                    />
                </FormRow>
                {error && <FormNote tone="destructive">{error}</FormNote>}
                <FormActions
                    action={
                        <Button
                            type="submit"
                            variant="destructive"
                            size="lg"
                            disabled={pending}
                            data-cuelume-press="pulse"
                        >
                            <PendingLabel pending={pending} idle="Cancel plan" busy="Cancelling…" />
                            <ArrowRightIcon aria-hidden="true" />
                        </Button>
                    }
                >
                    <button
                        type="button"
                        className="text-link"
                        disabled={pending}
                        data-cuelume-press=""
                        data-cuelume-release=""
                        onClick={onCancel}
                    >
                        Keep my plan
                    </button>
                </FormActions>
            </FormTable>
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

    // Back from checkout: the webhook is usually ahead of us, but not always.
    useEffect(() => {
        if (!checkoutId) return;
        let attempts = 0;
        let active = true;
        const tick = async () => {
            if (!active) return;
            attempts += 1;
            try {
                const next = await billingApi.sync();
                if (!active) return;
                settle(next);
                if (next.subscription && !next.subscription.endedAt) {
                    cue('success');
                    setNotice(`You're on ${next.subscription.productName}. Thank you.`);
                    void navigate({ to: '/app/billing', search: {}, replace: true });
                    return;
                }
            } catch {
                /* Try again on the next tick. */
            }
            if (attempts < 15) window.setTimeout(() => void tick(), 2_000);
            else
                setError(
                    'Payment received, but the plan is still activating. Refresh in a minute.',
                );
        };
        void tick();
        return () => {
            active = false;
        };
    }, [checkoutId, navigate, settle]);

    async function run(key: string, action: () => Promise<void>) {
        setBusy(key);
        setError('');
        setNotice('');
        try {
            await action();
            return true;
        } catch (error) {
            cue('error');
            setError(authError(error));
            return false;
        } finally {
            setBusy(null);
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
                return;
            }
            settle(await billingApi.summary());
            cue('success');
            setNotice(`You're on ${plan.name}. Your plan will renew as usual.`);
        });

    const portal = () =>
        run('portal', async () => {
            const { url } = await billingApi.portal();
            window.location.assign(url);
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

    return (
        <div className="flex flex-col">
            <PageHeader
                eyebrow="Account"
                title="Billing"
                description="Your plan, your storage allowance, and your invoices."
            />
            <Section
                id="plan-title"
                title="Your plan"
                description={
                    live
                        ? 'Invoices, receipts, and your payment method live in the billing portal, run by Polar as our merchant of record.'
                        : 'Every account starts on the free tier. Upgrade below when you need more room.'
                }
            >
                <Collapse open={Boolean(notice)} className="border-b">
                    <output className="block">
                        <FormNote>{notice}</FormNote>
                    </output>
                </Collapse>
                <Collapse open={activating && !error} className="border-b">
                    <FormNote>Payment received. Activating your plan…</FormNote>
                </Collapse>
                <Collapse open={Boolean(error)} className="border-b">
                    <FormNote tone="destructive">{error}</FormNote>
                </Collapse>
                <dl>
                    <Row
                        label="Plan"
                        value={summary.isPending ? '—' : live ? live.productName : 'Free'}
                    />
                    <Row
                        label="Storage"
                        value={
                            summary.isPending
                                ? '—'
                                : live
                                  ? formatGiB(live.quotaBytes)
                                  : catalogue.data
                                    ? formatGiB(catalogue.data.freeQuotaBytes)
                                    : '—'
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
                {summary.data?.hasCustomer && (
                    <Button
                        variant="row"
                        size="row"
                        className="border-t"
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
                        variant="row"
                        size="row"
                        className="border-t"
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
                {live && !live.cancelAtPeriodEnd && (
                    <>
                        <Collapse open={!cancelling}>
                            <Button
                                variant="row"
                                size="row"
                                className="border-t text-destructive hover:bg-destructive/10 [&>svg]:text-destructive"
                                disabled={busy !== null}
                                onClick={() => {
                                    setCancelling(true);
                                    setNotice('');
                                    setError('');
                                }}
                            >
                                Cancel plan <ArrowRightIcon aria-hidden="true" />
                            </Button>
                        </Collapse>
                        <Collapse open={cancelling} className="border-t">
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
                    </>
                )}
            </Section>
            <Section
                id="plans-title"
                title="Plans"
                description="Prices include tax where it applies. Switching plans charges or credits the prorated difference to your saved card straight away; yearly plans cost ten months."
            >
                <Collapse open={Boolean(switching)} className="border-b">
                    {switching && (
                        <div>
                            <FormNote>
                                Switch to {switching.name}, {formatGiB(switching.quotaBytes)} for{' '}
                                {planPrice(switching, currency)}? Your plan changes now and the
                                prorated difference is charged, or credited, to your saved card.
                            </FormNote>
                            <FormActions
                                action={
                                    <Button
                                        size="lg"
                                        disabled={busy !== null}
                                        data-cuelume-press="pulse"
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
                                }
                            >
                                <button
                                    type="button"
                                    className="text-link"
                                    disabled={busy !== null}
                                    data-cuelume-press=""
                                    data-cuelume-release=""
                                    onClick={() => void clearPlan()}
                                >
                                    Keep my current plan
                                </button>
                            </FormActions>
                        </div>
                    )}
                </Collapse>
                {catalogue.data?.plans.length ? (
                    <ul>
                        {catalogue.data.plans.map((plan) => {
                            const current = live?.productId === plan.id;
                            return (
                                <li
                                    key={plan.id}
                                    className="grid items-center gap-x-4 border-b px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:px-5"
                                >
                                    <div className="min-w-0">
                                        <p className="font-mono text-[13px] font-medium">
                                            {plan.name}
                                            <span className="ml-3 text-muted-foreground">
                                                {formatGiB(plan.quotaBytes)}
                                            </span>
                                        </p>
                                        {plan.description && (
                                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                                                {plan.description}
                                            </p>
                                        )}
                                    </div>
                                    <p className="font-mono text-[13px] tabular-nums sm:text-right">
                                        {current && live?.amount != null && live.currency
                                            ? `${formatMoney(live.amount, live.currency)} / ${intervalLabel[plan.interval]}`
                                            : planPrice(plan, currency)}
                                    </p>
                                    <Button
                                        variant={
                                            current ? 'outline' : live ? 'secondary' : 'default'
                                        }
                                        size="sm"
                                        className="mt-2 sm:mt-0 sm:w-28"
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
                                        data-cuelume-press="pulse"
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
                    <p className="px-4 py-3.5 font-mono text-xs text-muted-foreground sm:px-5">
                        {catalogue.isPending ? 'Loading plans…' : 'No plans are on sale right now.'}
                    </p>
                )}
            </Section>
        </div>
    );
}

import type { FamilyPlan } from '@hushos/billing/api';
import { FAMILY_MAX_MEMBERS } from '@hushos/billing/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { ArrowUpRightIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { Segmented } from '@/components/settings';
import { StorageMeter } from '@/components/storage-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { localeHintQueryOptions } from '@/lib/billing';
import { groupBillingApi } from '@/lib/billing-api';
import { pickCurrency } from '@/lib/currency';
import { formatDay } from '@/lib/drive';
import { familyQueryOptions, type FamilyMember } from '@/lib/families';
import {
    addRange,
    billingAccess,
    currentPlan,
    familyActions,
    familyBillingQueryOptions,
    familyCurrencies,
    familyPrice,
    livePrice,
    nextCharge,
    needsPlan,
    planState,
    quoteAdd,
    seatNoteFor,
    removeRange,
    renewalAmount,
    TAX_LINE,
    TAX_ON_CHARGES,
    type FamilyBilling,
    type FamilyBillingFull,
    type FamilyGlance,
} from '@/lib/family-billing';
import { formatMoney, formatQuota, formatSpace } from '@/lib/format';
import { authError } from '@/lib/form';
import { usePageRestored } from '@/lib/page-restore';
import { cue } from '@/lib/sounds';

/*
 * A family's plan on its page (docs/groups-design.md 3.5). Before one is paid
 * for, "Choose a plan" comes first and nobody can be invited. Once it is
 * live, the payer and `billing` holders see Billing: the plan, the next
 * charge, places and the pool; only the payer changes it, and cancelling and
 * the card happen in Polar's portal. Everyone else sees the plan's name and
 * the storage used. Refusals are the server's own sentences.
 */

const per = { month: 'a month', year: 'a year' } as const;
const intervalOf = (value: string) => (value === 'year' ? 'year' : 'month');
const places = (n: number) => `${n} ${n === 1 ? 'place' : 'places'}`;
const tierName = (plan: FamilyPlan) => plan.name.replace(/\s*\((monthly|yearly|annual)\)\s*$/i, '');

/* A person the server names, for a sentence: their name with their address, or a fallback. */
function personLine(members: readonly FamilyMember[] | undefined, userId: string | undefined) {
    const member = userId ? members?.find((at) => at.userId === userId) : undefined;
    return member ? `${member.name} (${member.email})` : null;
}

function organizersLine(members: readonly FamilyMember[] | undefined) {
    const names = (members ?? [])
        .filter((member) => member.state === 'active' && member.roles.includes('billing'))
        .map((member) => member.name);
    return names.length ? names.join(' or ') : null;
}

function Section({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
    return (
        <section id={id} className="flex scroll-mt-4 flex-col" aria-label={title}>
            <h2 className="eyebrow px-5 pt-6 pb-2 text-muted-foreground sm:px-8">{title}</h2>
            <div className="flex flex-col gap-3 border-t border-rule px-5 pt-4 sm:px-8">
                {children}
            </div>
        </section>
    );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 tabular-nums">{children}</dd>
        </>
    );
}

function PoolLine({ storage }: { storage: FamilyBilling['storage'] }) {
    // No pool (a family from before plans were sold), or an empty one: nothing to measure.
    if (!storage || storage.quotaBytes === '0') return null;
    const used = Number(storage.usedBytes);
    const quota = Number(storage.quotaBytes);
    return (
        <span className="flex flex-col gap-1.5">
            <span>
                {formatSpace(storage.usedBytes)} of {formatQuota(storage.quotaBytes)} used
            </span>
            <StorageMeter used={used} quota={quota} parts={null} className="h-1.5 max-w-64" />
        </span>
    );
}

/* Whether invites and new family folders wait for a plan, from the family's own summary. */
export function useFamilyPlanGate(userId: string, groupId: string, enabled = true) {
    const summary = useQuery({ ...familyBillingQueryOptions(userId, groupId), enabled });
    // An unreadable summary leaves the server to refuse; a loading one hides the actions.
    if (summary.isError) return { waiting: false, summary: undefined };
    return { waiting: needsPlan(summary.data), summary: summary.data };
}

type Props = {
    userId: string;
    groupId: string;
    family: string;
    roles: readonly string[];
    /* Polar's checkout id, back from paying: the plan is waited for. */
    checkoutId?: string;
    onCheckoutSeen: () => void;
};

/*
 * The whole of it, placed by the page: `place="top"` is the "Choose a plan"
 * step and the notices that come before the members; `place="bottom"` is the
 * Billing (or Plan) section under them.
 */
export function FamilyPlan({ place, ...props }: Props & { place: 'top' | 'bottom' }) {
    const { userId, groupId } = props;
    const summary = useQuery(familyBillingQueryOptions(userId, groupId));
    const detail = useQuery(familyQueryOptions(userId, groupId));
    const data = summary.data;
    if (!data || !data.enabled) return null;
    const members = detail.data?.members;
    if (data.view === 'member')
        return place === 'top' ? (
            <GlanceTop family={props.family} summary={data} members={members} />
        ) : (
            <GlanceSection summary={data} />
        );
    return place === 'top' ? (
        <PlanTop {...props} summary={data} members={members} />
    ) : (
        <PlanSection {...props} summary={data} members={members} />
    );
}

/*
 * A member without `billing`: whether the family has a plan (what keeps it
 * from taking anyone new) and who can choose one. Nothing about its state or
 * price: the server sends none.
 */
function GlanceTop({
    family,
    summary,
    members,
}: {
    family: string;
    summary: FamilyGlance;
    members: readonly FamilyMember[] | undefined;
}) {
    if (summary.hasPlan) return null;
    const who = organizersLine(members);
    const empty = summary.storage !== null && summary.storage.quotaBytes === '0';
    return (
        <div className="px-5 sm:px-8">
            <Alert data-plan-notice="none">
                <AlertTitle>{family} doesn’t have a plan right now</AlertTitle>
                <AlertDescription>
                    {empty
                        ? 'Nobody new can join, and nothing can be added to the family folders, until it has one.'
                        : 'Nobody new can join until it has one.'}{' '}
                    {who ? `${who} can choose one.` : 'The organizer can choose one.'}
                </AlertDescription>
            </Alert>
        </div>
    );
}

/* The plan's name, and the pool: all a member without `billing` is shown. */
function GlanceSection({ summary }: { summary: FamilyGlance }) {
    if (!summary.hasPlan || !summary.planName) return null;
    return (
        <Section title="Plan">
            <div data-family-plan="glance" className="flex flex-col gap-2 text-sm">
                <span className="text-base font-bold">
                    {summary.planName.replace(/\s*\((monthly|yearly|annual)\)\s*$/i, '')}
                    {summary.storage && summary.storage.quotaBytes !== '0'
                        ? ` · ${formatQuota(summary.storage.quotaBytes)}`
                        : ''}
                </span>
                <PoolLine storage={summary.storage} />
            </div>
        </Section>
    );
}

type Inner = Props & { summary: FamilyBillingFull; members: readonly FamilyMember[] | undefined };

/*
 * Back from checkout: Polar's delivery is usually first, else the family is
 * synced from Polar every three seconds, eight times at most (the route allows
 * ten in ten minutes). Only a live plan is called paid.
 */
const SYNC_TRIES = 8;
function useCheckoutReturn({ userId, groupId, checkoutId, onCheckoutSeen, summary }: Inner) {
    const queryClient = useQueryClient();
    const key = familyBillingQueryOptions(userId, groupId).queryKey;
    const [tries, setTries] = useState(0);
    const live = summary.subscription !== null;
    useEffect(() => {
        if (!checkoutId || live || tries >= SYNC_TRIES) return;
        const timer = setTimeout(
            () => {
                void groupBillingApi
                    .sync(groupId)
                    .then((next) => queryClient.setQueryData(key, next))
                    .catch(() => undefined)
                    .finally(() => setTries((n) => n + 1));
            },
            tries === 0 ? 0 : 3_000,
        );
        return () => clearTimeout(timer);
        // `key` is rebuilt each render from the same ids.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [checkoutId, live, tries, groupId, queryClient]);
    useEffect(() => {
        if (checkoutId && live) {
            cue('success');
            toast.add({
                type: 'success',
                title: `Payment received. ${summary.subscription?.productName ?? 'The plan'} is on`,
                description: 'You can invite people now.',
            });
            void queryClient.invalidateQueries({ queryKey: key.slice(0, 4) });
            onCheckoutSeen();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [checkoutId, live]);
    return { activating: Boolean(checkoutId) && !live, gaveUp: tries >= SYNC_TRIES };
}

function PlanTop(props: Inner) {
    const { summary, family, roles, members } = props;
    const state = planState(summary);
    const actions = familyActions(summary, roles);
    const { activating, gaveUp } = useCheckoutReturn(props);
    const emptyPool = summary.storage !== null && summary.storage.quotaBytes === '0';
    const payerName = personLine(members, summary.payer?.userId);
    const payerYou = summary.payer?.you ?? false;

    if (activating)
        return (
            <div className="px-5 sm:px-8">
                <Alert variant={gaveUp ? 'warning' : 'info'}>
                    <AlertDescription>
                        {gaveUp
                            ? 'Your payment is still being finished. Refresh in a minute; nothing is charged twice.'
                            : 'Finishing your payment…'}
                    </AlertDescription>
                </Alert>
            </div>
        );

    if (state.kind === 'live') {
        const live = state.subscription;
        const ends = formatDay(live.currentPeriodEnd);
        const waiting = live.units - live.paidUnits;
        if (state.overdue)
            return (
                <div className="px-5 sm:px-8" data-plan-notice="overdue">
                    <Alert variant="destructive">
                        <AlertTitle>
                            The last payment for {family}’s plan didn’t go through
                        </AlertTitle>
                        <AlertDescription>
                            {payerYou
                                ? 'Update the card in Manage payment and invoices, under Billing, to keep it.'
                                : `${payerName ?? 'The person who pays for it'} needs to update the card to keep it.`}
                        </AlertDescription>
                    </Alert>
                </div>
            );
        if (state.ending)
            return (
                <div className="px-5 sm:px-8" data-plan-notice="ending">
                    <Alert>
                        <AlertTitle>
                            {family}’s plan ends on {ends}
                        </AlertTitle>
                        <AlertDescription>
                            After that, nobody can upload to the family folders. Nothing is deleted.{' '}
                            {payerYou
                                ? 'To keep the plan, resume it in Manage payment and invoices, under Billing.'
                                : `${payerName ?? 'The person who pays for it'} can resume it before then.`}
                        </AlertDescription>
                    </Alert>
                </div>
            );
        if (waiting > 0 && payerYou)
            return (
                <div className="px-5 sm:px-8">
                    <Alert variant="warning">
                        <AlertDescription>
                            Your bank hasn’t confirmed the charge for {places(waiting)} yet. They
                            open once it does: confirm it in Manage payment and invoices.
                        </AlertDescription>
                    </Alert>
                </div>
            );
        return null;
    }

    // Any `billing` holder can choose a plan while none is live (the server makes them the payer).
    const ask = organizersLine(members);
    if (state.kind === 'lapsed')
        return (
            <div className="flex flex-col gap-2 px-5 sm:px-8">
                <Alert data-plan-notice="lapsed">
                    <AlertTitle>
                        {family}’s plan ended on {formatDay(state.endedAt)}
                    </AlertTitle>
                    <AlertDescription>
                        {emptyPool
                            ? 'Nobody can upload to the family folders, and nobody new can join, until it’s renewed.'
                            : 'Nobody new can join until it’s renewed.'}{' '}
                        Nothing has been deleted.{' '}
                        {actions.choosePlan
                            ? 'Choose a plan below to renew it.'
                            : ask
                              ? `${ask} can renew it.`
                              : 'Whoever paid for it can renew it.'}
                    </AlertDescription>
                </Alert>
                {actions.choosePlan && <ChoosePlan {...props} renewing />}
            </div>
        );

    // Never paid for.
    if (actions.choosePlan) return <ChoosePlan {...props} />;
    return (
        <div className="px-5 sm:px-8">
            <Alert data-plan-notice="none">
                <AlertTitle>{family} doesn’t have a plan right now</AlertTitle>
                <AlertDescription>
                    {emptyPool
                        ? 'Nobody new can join, and nothing can be added to the family folders, until it has one.'
                        : 'Nobody new can join until it has one.'}{' '}
                    {roles.includes('billing')
                        ? 'No family plans are on sale right now.'
                        : ask
                          ? `${ask} can choose one.`
                          : 'The organizer can choose one.'}
                </AlertDescription>
            </Alert>
        </div>
    );
}

/* The plans, monthly or yearly, in the visitor's currency as the pricing page picks it. */
function ChoosePlan({ groupId, family, summary, renewing }: Inner & { renewing?: boolean }) {
    const hint = useQuery(localeHintQueryOptions);
    const plans = summary.plans;
    const currencies = familyCurrencies(plans);
    const currency = pickCurrency({
        hint: hint.data,
        available: currencies,
        fallback: currencies[0] ?? 'usd',
    });
    const intervals = new Set(plans.map((plan) => plan.interval));
    const [period, setPeriod] = useState<'month' | 'year'>(
        intervals.has('month') ? 'month' : 'year',
    );
    const shown = plans.filter((plan) => plan.interval === period);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');
    usePageRestored(() => setBusy(null));

    async function choose(plan: FamilyPlan) {
        setBusy(plan.id);
        setError('');
        try {
            const { url } = await groupBillingApi.checkout(groupId, plan.id, currency);
            window.location.assign(url);
        } catch (cause) {
            cue('error');
            setError(authError(cause));
            setBusy(null);
        }
    }

    return (
        <section
            id="choose-plan"
            aria-labelledby={`${groupId}-choose`}
            data-choose-plan
            className={cn('flex scroll-mt-4 flex-col gap-4', !renewing && 'px-5 sm:px-8')}
        >
            <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-rule pb-3">
                <div className="flex min-w-0 flex-col gap-0.5">
                    <h2 id={`${groupId}-choose`} className="text-lg font-bold tracking-[-0.01em]">
                        Choose a plan
                    </h2>
                    {!renewing && (
                        <p className="max-w-[43em] text-sm text-muted-foreground">
                            {family} needs a plan before you can invite anyone or make family
                            folders. Until then, only you are in it.
                        </p>
                    )}
                </div>
                {intervals.size > 1 && (
                    <Segmented
                        label="Billed"
                        options={[
                            { value: 'month', label: 'Monthly' },
                            { value: 'year', label: 'Yearly' },
                        ]}
                        value={period}
                        onChange={setPeriod}
                    />
                )}
            </div>
            {shown.length ? (
                <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    {shown.map((plan) => {
                        const price = familyPrice(plan, currency);
                        if (!price) return null;
                        const extra = formatMoney(price.perMember, price.currency);
                        return (
                            <li
                                key={plan.id}
                                data-plan={plan.name}
                                className="flex flex-col gap-3 rounded-xl border border-rule p-4"
                            >
                                <span className="text-base font-bold">{tierName(plan)}</span>
                                <span className="text-2xl leading-none font-extrabold tracking-[-0.02em] tabular-nums">
                                    {formatQuota(plan.quotaBytes)}
                                </span>
                                <span className="flex flex-col gap-1 text-sm text-muted-foreground">
                                    <span className="font-semibold text-foreground">
                                        {formatMoney(price.base, price.currency)}{' '}
                                        {per[plan.interval]}
                                        {plan.interval === 'year' ? ' · 2 months free' : ''}
                                    </span>
                                    <span>
                                        For up to {plan.includedMembers} members, sharing{' '}
                                        {formatQuota(plan.quotaBytes)}.
                                    </span>
                                    <span>
                                        Then {extra} {per[plan.interval]} for each member after
                                        that, up to {plan.maxMembers}.
                                    </span>
                                </span>
                                <Button
                                    className="mt-auto w-full"
                                    disabled={busy !== null}
                                    onClick={() => void choose(plan)}
                                >
                                    {busy === plan.id ? 'Opening…' : `Choose ${tierName(plan)}`}
                                </Button>
                            </li>
                        );
                    })}
                </ul>
            ) : (
                <p className="text-sm text-muted-foreground">
                    No family plans are on sale right now.
                </p>
            )}
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            <p className="text-[13px] text-muted-foreground">
                {TAX_LINE} Payments are handled by Polar.
            </p>
        </section>
    );
}

/* Billing, for the payer and `billing` holders, under the members. */
function PlanSection(props: Inner) {
    const { summary, family, roles, members, groupId, userId } = props;
    const queryClient = useQueryClient();
    const key = familyBillingQueryOptions(userId, groupId).queryKey;
    const state = planState(summary);
    const access = billingAccess(summary);
    const actions = familyActions(summary, roles);
    const [adding, setAdding] = useState(false);
    const [removing, setRemoving] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [busy, setBusy] = useState<'portal' | 'keep' | null>(null);
    const [error, setError] = useState('');
    usePageRestored(() => setBusy(null));
    if (state.kind !== 'live') return null;
    const live = state.subscription;
    const ends = formatDay(live.currentPeriodEnd);
    const name = `${live.productName.replace(/\s*\((monthly|yearly|annual)\)\s*$/i, '')} · ${formatQuota(live.quotaBytes)}`;

    const settle = (next: FamilyBilling) => {
        queryClient.setQueryData(key, next);
        void queryClient.invalidateQueries({ queryKey: key.slice(0, 4) });
    };

    async function portal() {
        setBusy('portal');
        setError('');
        try {
            const { url } = await groupBillingApi.portal(groupId);
            window.location.assign(url);
        } catch (cause) {
            cue('error');
            setError(authError(cause));
            setBusy(null);
        }
    }

    async function keep() {
        setBusy('keep');
        setError('');
        try {
            const result = await groupBillingApi.setUnits(groupId, live.units);
            settle(result.billing);
            cue('success');
            toast.add({ type: 'success', title: `${family} keeps ${places(live.units)}` });
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setBusy(null);
        }
    }

    const interval = intervalOf(live.recurringInterval);
    const charge = nextCharge(summary);
    // List price for the places bought, as every other figure here: before any discount.
    const listed = renewalAmount(summary, live.units);
    const amountLine = listed
        ? `${formatMoney(listed.amount, listed.currency)} ${per[interval]}`
        : null;
    const payerName = summary.payer?.you ? 'You' : personLine(members, summary.payer?.userId);

    return (
        <Section id="billing" title="Billing">
            <div
                data-family-plan="billing"
                className={cn(
                    'flex flex-col gap-4 rounded-xl border p-4 sm:p-5',
                    state.overdue ? 'border-destructive' : 'border-rule',
                )}
            >
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                    <div className="flex min-w-0 flex-col gap-1">
                        <span className="text-xl font-bold">{name}</span>
                        <span className="text-sm text-muted-foreground">
                            {amountLine ? `${amountLine} · ` : ''}
                            {state.ending ? (
                                <span className="font-semibold text-foreground">ends {ends}</span>
                            ) : state.overdue ? (
                                <span className="font-semibold text-destructive">
                                    payment overdue
                                </span>
                            ) : (
                                `renews ${ends}`
                            )}
                        </span>
                    </div>
                    {actions.portal && (
                        <Button
                            variant={state.overdue || state.ending ? 'default' : 'outline'}
                            disabled={busy !== null}
                            onClick={() => void portal()}
                        >
                            {busy === 'portal' ? 'Opening…' : 'Manage payment and invoices'}
                            <ArrowUpRightIcon />
                        </Button>
                    )}
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
                    <Fact label="Places">
                        {summary.seats.used} of {summary.seats.limit} taken · {live.includedMembers}{' '}
                        included
                        {live.pendingUnits !== null && live.pendingUnits < live.units && (
                            <span className="block text-muted-foreground">
                                {places(live.units)} paid for until {ends}
                            </span>
                        )}
                        {live.paidUnits < live.units && (
                            <span className="block text-muted-foreground">
                                {places(live.units - live.paidUnits)} wait for the bank
                            </span>
                        )}
                    </Fact>
                    <Fact label="Storage">
                        <PoolLine storage={summary.storage} />
                    </Fact>
                    {charge && (
                        <Fact label="Next charge">
                            {formatMoney(charge.amount, charge.currency)} on {formatDay(charge.on)}
                        </Fact>
                    )}
                    {payerName && <Fact label="Paid by">{payerName}</Fact>}
                </dl>
                {(actions.addPlaces || actions.removePlaces || actions.keepPlaces) && (
                    <div className="flex flex-wrap gap-2">
                        {actions.addPlaces && (
                            <Button
                                variant="outline"
                                disabled={busy !== null}
                                onClick={() => setAdding(true)}
                            >
                                Add places
                            </Button>
                        )}
                        {actions.keepPlaces && (
                            <Button
                                variant="outline"
                                disabled={busy !== null}
                                onClick={() => void keep()}
                            >
                                {busy === 'keep' ? 'Keeping…' : `Keep ${places(live.units)}`}
                            </Button>
                        )}
                        {actions.removePlaces && (
                            <Button
                                variant="outline"
                                disabled={busy !== null}
                                onClick={() => setRemoving(true)}
                            >
                                Remove places at renewal
                            </Button>
                        )}
                    </div>
                )}
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                {actions.cancel && (
                    <Button
                        variant="ghost"
                        disabled={busy !== null}
                        onClick={() => setCancelling(true)}
                        className="-ml-3.5 self-start underline underline-offset-4 hover:text-destructive pointer-coarse:-ml-4"
                    >
                        Cancel plan
                    </Button>
                )}
                <p className="text-[13px] text-muted-foreground">
                    {access === 'billing'
                        ? `Only the person who pays for the plan can change it. ${TAX_ON_CHARGES}`
                        : TAX_ON_CHARGES}
                </p>
            </div>
            {actions.addPlaces && (
                <AddPlacesDialog
                    {...props}
                    open={adding}
                    onOpenChange={setAdding}
                    onDone={settle}
                />
            )}
            {actions.removePlaces && (
                <RemovePlacesDialog
                    {...props}
                    open={removing}
                    onOpenChange={setRemoving}
                    onDone={settle}
                />
            )}
            <AlertDialog open={cancelling} onOpenChange={setCancelling}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Cancel {family}’s plan?</AlertDialogTitle>
                        <AlertDialogDescription>
                            You cancel it in the billing portal. The family keeps its plan and{' '}
                            {formatQuota(live.quotaBytes)} until {ends}. After that, nobody can
                            upload to the family folders. Nothing is deleted.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep the plan</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            disabled={busy !== null}
                            onClick={() => void portal()}
                        >
                            {busy === 'portal' ? 'Opening…' : 'Cancel in the billing portal'}
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </Section>
    );
}

/* A count between two bounds: minus, the number, plus. */
function Stepper({
    label,
    value,
    min,
    max,
    onChange,
    disabled,
}: {
    label: string;
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
    disabled?: boolean;
}) {
    const id = useId();
    const clamp = (n: number) => Math.min(max, Math.max(min, Math.round(n)));
    return (
        <div className="flex flex-col gap-1.5">
            <label htmlFor={id} className="text-[13px] font-semibold">
                {label}
            </label>
            <div className="flex items-center gap-2">
                <Button
                    variant="outline"
                    size="icon"
                    aria-label="Fewer"
                    disabled={disabled || value <= min}
                    onClick={() => onChange(clamp(value - 1))}
                >
                    <MinusIcon />
                </Button>
                <Input
                    id={id}
                    type="number"
                    inputMode="numeric"
                    min={min}
                    max={max}
                    value={value}
                    disabled={disabled}
                    onChange={(event) => {
                        const next = Number(event.target.value);
                        if (Number.isFinite(next) && event.target.value !== '')
                            onChange(clamp(next));
                    }}
                    className="h-9 w-20 text-center tabular-nums pointer-coarse:h-11"
                />
                <Button
                    variant="outline"
                    size="icon"
                    aria-label="More"
                    disabled={disabled || value >= max}
                    onClick={() => onChange(clamp(value + 1))}
                >
                    <PlusIcon />
                </Button>
            </div>
        </div>
    );
}

type DialogProps = Inner & {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDone: (next: FamilyBilling) => void;
};

/*
 * "Add places": charged now for the rest of the period, at the per-member
 * rate past the included members, quoted as Polar truncates it. A bank that
 * wants the payer to confirm sends them to the portal; nothing opens before.
 */
function AddPlacesDialog({ groupId, family, summary, open, onOpenChange, onDone }: DialogProps) {
    const range = addRange(summary);
    const [count, setCount] = useState(1);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
    const live = summary.subscription;
    const price = livePrice(summary);
    if (!live || !range) return null;
    const value = Math.min(count, range.max);
    const now = quoteAdd(summary, value);
    // A raise drops any scheduled cut, so the renewal is for every place the family then has.
    const then = renewalAmount(summary, live.units + value);
    const interval = intervalOf(live.recurringInterval);

    async function add() {
        setBusy(true);
        setError('');
        try {
            const result = await groupBillingApi.setUnits(groupId, live!.units + value);
            onDone(result.billing);
            if (result.confirmPayment && result.url) {
                setConfirmUrl(result.url);
                return;
            }
            cue('success');
            toast.add({ type: 'success', title: `Added ${places(value)} to ${family}` });
            onOpenChange(false);
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (busy) return;
                onOpenChange(next);
                if (!next) {
                    setError('');
                    setConfirmUrl(null);
                    setCount(1);
                }
            }}
        >
            <DialogContent className="sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle>Add places</DialogTitle>
                    <DialogDescription>
                        {price
                            ? `Each place past the ${live.includedMembers} included is ${formatMoney(price.perMember, price.currency)} ${per[interval]}. You pay now for the rest of this period.`
                            : 'You pay now for the rest of this period.'}
                    </DialogDescription>
                </DialogHeader>
                <Stepper
                    label="Places to add"
                    value={value}
                    min={range.min}
                    max={range.max}
                    onChange={setCount}
                    disabled={busy || confirmUrl !== null}
                />
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                    {now && (
                        <Fact label="Charged now">{formatMoney(now.amount, now.currency)}</Fact>
                    )}
                    {then && (
                        <Fact label="Then">
                            {formatMoney(then.amount, then.currency)} {per[interval]} from{' '}
                            {formatDay(live.currentPeriodEnd)}
                        </Fact>
                    )}
                </dl>
                <p className="text-[13px] text-muted-foreground">
                    {TAX_ON_CHARGES} You can add up to {places(range.max)} now; a family has at most{' '}
                    {currentPlan(summary)?.maxMembers ?? FAMILY_MAX_MEMBERS} members.
                </p>
                {confirmUrl && (
                    <Alert variant="warning">
                        <AlertDescription>
                            Your bank wants you to confirm this payment. The places open once you
                            do.
                        </AlertDescription>
                    </Alert>
                )}
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    {confirmUrl ? (
                        <Button onClick={() => window.location.assign(confirmUrl)}>
                            Confirm with your bank
                            <ArrowUpRightIcon />
                        </Button>
                    ) : (
                        <Button disabled={busy} onClick={() => void add()}>
                            {busy ? 'Adding…' : `Add ${places(value)}`}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/*
 * "Remove places at renewal": free, from the period's end, never below the
 * members or the included count. The places removed stop taking newcomers now.
 */
function RemovePlacesDialog({ groupId, family, summary, open, onOpenChange, onDone }: DialogProps) {
    const range = removeRange(summary);
    const live = summary.subscription;
    const [target, setTarget] = useState<number | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    if (!live || !range) return null;
    const value = Math.min(
        range.max,
        Math.max(range.min, target ?? live.pendingUnits ?? range.max),
    );
    const ends = formatDay(live.currentPeriodEnd);
    const then = renewalAmount(summary, value);
    const interval = intervalOf(live.recurringInterval);

    async function remove() {
        setBusy(true);
        setError('');
        try {
            const result = await groupBillingApi.setUnits(groupId, value);
            onDone(result.billing);
            cue('success');
            toast.add({ type: 'success', title: `${family} has ${places(value)} from ${ends}` });
            onOpenChange(false);
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setBusy(false);
        }
    }

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (busy) return;
                onOpenChange(next);
                if (!next) {
                    setError('');
                    setTarget(null);
                }
            }}
        >
            <DialogContent className="sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle>Remove places at renewal</DialogTitle>
                    <DialogDescription>
                        From {ends}, {family} has fewer places. Nothing is refunded and nobody is
                        removed. Nobody new can take the places you remove, starting now.
                    </DialogDescription>
                </DialogHeader>
                <Stepper
                    label={`Places from ${ends}`}
                    value={value}
                    min={range.min}
                    max={range.max}
                    onChange={setTarget}
                    disabled={busy}
                />
                {then && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                        <Fact label="Then">
                            {formatMoney(then.amount, then.currency)} {per[interval]}
                        </Fact>
                    </dl>
                )}
                <p className="text-[13px] text-muted-foreground">
                    {TAX_ON_CHARGES} It can’t go below the family’s {summary.seats.used}{' '}
                    {summary.seats.used === 1 ? 'member' : 'members'} or the {live.includedMembers}{' '}
                    the plan includes.
                </p>
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
                        Cancel
                    </Button>
                    <Button disabled={busy} onClick={() => void remove()}>
                        {busy ? 'Removing…' : 'Remove places'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/*
 * Before "Let them in", for the payer of a full family: the place it takes is
 * bought then, so the charge is said first. Nothing for anyone else.
 */
export function SeatNote({
    userId,
    groupId,
    first,
}: {
    userId: string;
    groupId: string;
    first: string;
}) {
    const summary = useQuery(familyBillingQueryOptions(userId, groupId)).data;
    const note = seatNoteFor(summary);
    if (!note || summary?.view !== 'manage' || !summary.subscription) return null;
    const interval = per[intervalOf(summary.subscription.recurringInterval)];
    return (
        <p className="text-sm text-muted-foreground" data-seat-note={note.kind}>
            {note.kind === 'bank'
                ? `Your bank hasn’t confirmed the charge for the last places yet. ${first} can be let in once it does.`
                : note.kind === 'keep'
                  ? `Every place is taken. Letting ${first} in keeps one of the places you’re removing on ${formatDay(note.from)}, with nothing charged now.`
                  : `Every place is taken. Letting ${first} in adds one: ${formatMoney(note.now.amount, note.now.currency)} now, then ${formatMoney(note.perMember, note.now.currency)} ${interval}, before any discount and plus tax where it applies.`}
        </p>
    );
}

/*
 * After "Let them in" was refused for want of a place: what this person can
 * do about it, or who can. Only the payer can buy places, so anyone else is
 * told who pays.
 */
export function SeatHelp({
    userId,
    groupId,
    roles,
    reason,
    url,
    onChoosePlan,
}: {
    userId: string;
    groupId: string;
    roles: readonly string[];
    reason: string;
    url: string | null;
    onChoosePlan: () => void;
}) {
    const summary = useQuery(familyBillingQueryOptions(userId, groupId)).data;
    const members = useQuery(familyQueryOptions(userId, groupId)).data?.members;
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    usePageRestored(() => setBusy(false));
    if (!summary?.enabled) return null;
    // A manager without `billing` isn't told who pays (the glance names nobody): the refusal says it.
    const payerYou = summary.view === 'manage' && (summary.payer?.you ?? false);
    const payer = summary.view === 'manage' ? personLine(members, summary.payer?.userId) : null;
    const actions = familyActions(summary, roles);

    async function portal() {
        setBusy(true);
        setError('');
        try {
            window.location.assign((await groupBillingApi.portal(groupId)).url);
        } catch (cause) {
            setError(authError(cause));
            setBusy(false);
        }
    }

    let body: ReactNode = null;
    if (reason === 'no-plan')
        body = actions.choosePlan ? (
            <Button variant="outline" onClick={onChoosePlan}>
                Choose a plan
            </Button>
        ) : (
            <p>{`${payer ?? organizersLine(members) ?? 'The organizer'} can choose one.`}</p>
        );
    // Anyone but the payer: who pays, by name. Without a name the refusal above already says it.
    else if (reason === 'payer' || ((reason === 'canceling' || reason === 'declined') && !payerYou))
        body = payer ? (
            <p>
                {reason === 'canceling'
                    ? `${payer} pays for the family and can resume the plan.`
                    : `${payer} pays for the family and can add a place under Billing.`}
            </p>
        ) : null;
    else if (reason === 'confirm' && url)
        body = (
            <Button variant="outline" onClick={() => window.location.assign(url)}>
                Confirm with your bank
                <ArrowUpRightIcon />
            </Button>
        );
    else if ((reason === 'declined' || reason === 'canceling' || reason === 'confirm') && payerYou)
        body = (
            <Button variant="outline" disabled={busy} onClick={() => void portal()}>
                {busy ? 'Opening…' : 'Manage payment and invoices'}
                <ArrowUpRightIcon />
            </Button>
        );
    if (!body) return null;
    return (
        <div className="flex flex-col items-start gap-2 text-sm" data-seat-help={reason}>
            {body}
            {error && (
                <p role="alert" className="text-destructive">
                    {error}
                </p>
            )}
        </div>
    );
}

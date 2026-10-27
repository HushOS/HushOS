import type { FamilyPlan } from '@hushos/billing/api';
import {
    CANCELLATION_REASONS,
    FAMILY_MAX_MEMBERS,
    cancellationReasonLabels,
    planTierName,
    spaceOf,
    type CancellationReason,
} from '@hushos/billing/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { ArrowUpRightIcon, MinusIcon, PlusIcon } from 'lucide-react';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { PortalLink } from '@/components/portal-link';
import { Segmented, Setting, SettingsGroup } from '@/components/settings';
import { StorageMeter } from '@/components/storage-card';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
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
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { billingQueryOptions, localeHintQueryOptions } from '@/lib/billing';
import { storageQueryOptions } from '@/lib/queries';
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
    pendingTier,
    planState,
    paymentNeedsYou,
    placesOf,
    quoteAdd,
    seatNoteFor,
    removeRange,
    renewalAmount,
    TAX_LINE,
    TAX_ON_CHARGES,
    tierMoves,
    upgradeWaiting,
    type FamilyBilling,
    type FamilyBillingFull,
    type FamilyGlance,
    type TierMove,
} from '@/lib/family-billing';
import { formatMoney, formatQuota, formatSpace } from '@/lib/format';
import { authError } from '@/lib/form';
import { usePageRestored } from '@/lib/page-restore';
import {
    familyPairs,
    familyTierName as tierName,
    personalPlanEnding,
    twoMonthsFree,
} from '@/lib/plans';
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

/* A person the server names, for a sentence: their name with their address, or a fallback. */
function personLine(members: readonly FamilyMember[] | undefined, userId: string | undefined) {
    const member = userId ? members?.find((at) => at.userId === userId) : undefined;
    return member ? `${member.name} (${member.email})` : null;
}

function organizersLine(members: readonly FamilyMember[] | undefined) {
    const names = (members ?? [])
        .filter((member) => member.state === 'active' && member.roles.includes('billing'))
        // A name from the server always has its address beside it.
        .map((member) => (member.email ? `${member.name} (${member.email})` : member.name));
    return names.length ? names.join(' or ') : null;
}

/* A label and its figure in a dialog's list of amounts (a `dl` grid). */
function Fact({ label, children }: { label: string; children: ReactNode }) {
    return (
        <>
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 tabular-nums">{children}</dd>
        </>
    );
}

/* A figure in a row of facts: tabular, so sizes and dates line up down the column. */
function Figure({ children }: { children: ReactNode }) {
    return <span className="tabular-nums">{children}</span>;
}

/* The family has a pool to share, and the server said who stores what in it: Storage shows. */
function poolShown(data: FamilyBilling | undefined): data is FamilyBilling & {
    usage: NonNullable<FamilyBilling['usage']>;
    storage: NonNullable<FamilyBilling['storage']>;
} {
    return Boolean(data?.enabled && data.usage && data.storage && data.storage.quotaBytes !== '0');
}

/* A member's own files as a manager sees them: whole GB, rounded up on the server. */
const roundedLabel = (bytes: string) => (bytes === '0' ? 'Under 1 GB' : formatQuota(bytes));

/*
 * The family's storage, said once on the page (docs/families-shared-pool.md 3.9, 7.3), in
 * one format per viewer. Someone who manages the family sees each person's own files as the
 * server rounds them (whole GB, rounded up, largest first), the family folders and what is
 * free, never a total beside the rows. Everyone else sees the family's total (Used, which the
 * server counts part by part in whole GB, so it gives no one member away), their own files
 * exactly, and the family folders.
 * Nobody sees names, counts or types of anyone's files. Shown only while the family has a
 * pool to share (billing on, a live plan).
 */
export function FamilyStorage({
    userId,
    groupId,
    family,
}: {
    userId: string;
    groupId: string;
    family: string;
}) {
    const summary = useQuery(familyBillingQueryOptions(userId, groupId));
    const detail = useQuery(familyQueryOptions(userId, groupId));
    // What is free, as the sidebar says it: the server's figure for this pool, which counts
    // uploads in flight; the summary's own arithmetic only for a payer who isn't pooled.
    const account = useQuery(storageQueryOptions);
    const data = summary.data;
    if (!poolShown(data)) return null;
    const { usage, storage } = data;
    // Someone without billing sees the plan here, beside the storage it gives, not in a
    // section of its own that would only repeat the page header's places.
    const planRow =
        data.view === 'member' && data.hasPlan && data.planName ? (
            <Setting label="Plan" data={{ 'data-family-plan': 'glance' }}>
                <span className="font-semibold">
                    {planTierName({ name: data.planName })} · {formatQuota(storage.quotaBytes)}
                </span>
            </Setting>
        ) : null;
    const quota = BigInt(storage.quotaBytes);
    const used = BigInt(storage.usedBytes);
    const free =
        account.data?.pool?.groupId === groupId
            ? BigInt(account.data.availableBytes)
            : quota > used
              ? quota - used
              : 0n;
    const nameOf = (id: string) => {
        if (id === userId) return 'You';
        const member = detail.data?.members.find((at) => at.userId === id);
        return member ? member.name : 'Someone in the family';
    };
    const meter = (
        <StorageMeter
            used={Number(used)}
            quota={Number(quota)}
            parts={null}
            className="mt-2 h-1.5 max-w-64"
        />
    );
    const full = (
        <span className="font-semibold text-destructive">The family’s storage is full</span>
    );
    const folders = (
        <Setting data={{ 'data-usage-folders': true }} label="Family folders">
            <Figure>{usage.foldersBytes === '0' ? 'None' : formatQuota(usage.foldersBytes)}</Figure>
        </Setting>
    );
    return (
        <SettingsGroup
            title="Storage"
            description={
                usage.members
                    ? 'Each person’s own files, rounded up to the whole GB.'
                    : `The people who manage ${family} see only how much your files take, rounded up to the whole GB.`
            }
        >
            {usage.members ? (
                <div data-family-usage="manager" className="flex flex-col">
                    {planRow}
                    {usage.members.map((member) => (
                        <Setting
                            key={member.userId}
                            data={{ 'data-usage-member': true }}
                            label={nameOf(member.userId)}
                        >
                            <Figure>{roundedLabel(member.ownBytesRounded)}</Figure>
                        </Setting>
                    ))}
                    {folders}
                    <Setting data={{ 'data-usage-free': true }} label="Free">
                        {free === 0n ? full : <Figure>{formatSpace(free.toString())}</Figure>}
                        {meter}
                    </Setting>
                </div>
            ) : (
                <div data-family-usage="member" className="flex flex-col">
                    {planRow}
                    <Setting data={{ 'data-usage-total': true }} label="Used">
                        <Figure>
                            {formatSpace(storage.usedBytes)} of {formatQuota(storage.quotaBytes)}
                        </Figure>
                        {free === 0n && <span className="block">{full}</span>}
                        {meter}
                    </Setting>
                    {usage.ownBytes !== null && (
                        <Setting data={{ 'data-usage-own': true }} label="Your files">
                            <Figure>{formatSpace(usage.ownBytes)}</Figure>
                        </Setting>
                    )}
                    {folders}
                </div>
            )}
        </SettingsGroup>
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
            <GlanceSection summary={data} seats={placesOf(detail.data?.seats, data)} />
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
    const lapsed = summary.lapsedPlan;
    if (lapsed) {
        const name = tierName({ name: lapsed.productName });
        const paused = lapsed.standing === 'paused';
        return (
            <div>
                {/* Nothing here is theirs to fix, but it is still a warning: plain words, the status colour. */}
                <Alert variant={paused ? 'warning' : 'destructive'} data-plan-notice="unpaid">
                    <AlertTitle>
                        {paused ? `${name} is paused` : `${name}’s payment didn’t go through`}
                    </AlertTitle>
                    <AlertDescription>
                        {paused
                            ? 'The plan is paused, so the family’s storage is empty until it resumes.'
                            : 'The plan gives no storage until it’s paid or replaced.'}{' '}
                        Nothing can be added to the family folders, nobody new can join, and your
                        own files count against your own storage again. Nothing is deleted.{' '}
                        {who ? `${who} can sort it out.` : 'The organizer can sort it out.'}
                    </AlertDescription>
                </Alert>
            </div>
        );
    }
    return (
        <div>
            <Alert data-plan-notice="none">
                <AlertTitle>No family plan right now</AlertTitle>
                <AlertDescription>
                    {empty
                        ? `Nobody new can join ${family}, and nothing can be added to the family folders, until there’s a plan.`
                        : `Nobody new can join ${family} until there’s a plan.`}{' '}
                    {who ? `${who} can choose one.` : 'The organizer can choose one.'}
                </AlertDescription>
            </Alert>
        </div>
    );
}

/* The plan's name, and the pool: all a member without `billing` is shown. */
function GlanceSection({
    summary,
    seats,
}: {
    summary: FamilyGlance;
    /* The family's places, as its page header says them (placesOf): the same figure in both. */
    seats: { used: number; limit: number } | null;
}) {
    // With a pool to share, Storage names the plan beside what it gives (FamilyStorage).
    if (!summary.hasPlan || !summary.planName || poolShown(summary)) return null;
    // The storage it gives is Storage's, below: said there once, not here as well.
    return (
        <SettingsGroup title="Plan">
            <div data-family-plan="glance" className="flex flex-col">
                {/* The group is already called Plan: its first row says only which one. */}
                <p className="border-b border-rule py-4 text-[15px] font-semibold last:border-0">
                    {planTierName({ name: summary.planName })}
                    {summary.storage && summary.storage.quotaBytes !== '0'
                        ? ` · ${formatQuota(summary.storage.quotaBytes)}`
                        : ''}
                </p>
                {seats && (
                    <Setting label="Places" data={{ 'data-glance-places': true }}>
                        <Figure>
                            {seats.used} of {seats.limit} taken
                        </Figure>
                    </Setting>
                )}
            </div>
        </SettingsGroup>
    );
}

type Inner = Props & { summary: FamilyBillingFull; members: readonly FamilyMember[] | undefined };

/*
 * Back from checkout: Polar's delivery is usually first, else the family is
 * synced from Polar every three seconds, eight times at most (the route allows
 * ten in ten minutes). Only a live plan is called paid.
 */
const SYNC_TRIES = 8;
/*
 * Checkouts already announced in this tab: the effect below runs again when the component
 * mounts again before the checkout id leaves the address (React's development double mount,
 * or a remount while a refetch settles), and must not say "Payment received" twice.
 */
const announced = new Set<string>();
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
            onCheckoutSeen();
            if (announced.has(checkoutId)) return;
            announced.add(checkoutId);
            cue('success');
            toast.add({
                type: 'success',
                title: `Payment received. ${summary.subscription?.productName ?? 'The plan'} is on`,
                description: 'You can invite people now.',
            });
            void queryClient.invalidateQueries({ queryKey: key.slice(0, 4) });
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
            <div>
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
                <div data-plan-notice="overdue">
                    <Alert variant="destructive">
                        <AlertTitle>
                            The last payment for the family’s plan didn’t go through
                        </AlertTitle>
                        <AlertDescription>
                            {payerYou
                                ? 'Update the card in Card and invoices, under Billing, to keep it.'
                                : `${payerName ?? 'The person who pays for it'} needs to update the card to keep it.`}
                        </AlertDescription>
                    </Alert>
                </div>
            );
        if (state.ending)
            return (
                <div data-plan-notice="ending">
                    <Alert>
                        <AlertTitle>The family’s plan ends on {ends}</AlertTitle>
                        <AlertDescription>
                            After that, nobody can upload to the family folders, and everyone’s own
                            files count against their own storage again. Nothing is deleted.{' '}
                            {payerYou
                                ? 'To keep it, choose Resume plan under Billing.'
                                : `${payerName ?? 'The person who pays for it'} can resume it before then.`}
                        </AlertDescription>
                    </Alert>
                </div>
            );
        if (upgradeWaiting(live) && payerYou)
            return (
                <div data-plan-notice="upgrade-waiting">
                    <Alert variant="warning">
                        <AlertDescription>
                            Your bank hasn’t confirmed the charge for{' '}
                            {tierName({ name: live.productName })} yet. It starts once it does:
                            confirm it in Card and invoices, under Billing. Until then the family
                            keeps the storage it has.
                        </AlertDescription>
                    </Alert>
                </div>
            );
        if (waiting > 0 && payerYou)
            return (
                <div>
                    <Alert variant="warning">
                        <AlertDescription>
                            Your bank hasn’t confirmed the charge for {places(waiting)} yet. They
                            open once it does: confirm it in Card and invoices, under Billing.
                        </AlertDescription>
                    </Alert>
                </div>
            );
        return null;
    }

    // Any `billing` holder can choose a plan while none is live (the server makes them the payer).
    const ask = organizersLine(members);
    if (state.kind === 'unpaid') {
        const name = tierName({ name: state.productName });
        const paused = state.standing === 'paused';
        const payer = payerName ?? 'The person who pays for it';
        // The way forward, for whoever is reading: a new plan ends this one first (the server
        // revokes it before the checkout), and only the payer has a portal.
        const next = actions.choosePlan
            ? payerYou
                ? paused
                    ? `Resume it in Card and invoices, or choose a plan below, which ends ${name} first.`
                    : `Choose a plan below; that ends ${name} first. If Card and invoices offers to retry the payment, that restores ${name}.`
                : paused
                  ? `Choose a plan below; that ends ${name} first, and you pay for the family from then on. ${payer} can resume it instead.`
                  : `Choose a plan below; that ends ${name} first, and you pay for the family from then on. ${payer} can instead retry the payment in Card and invoices, if it offers to.`
            : payerYou
              ? paused
                  ? 'Resume it in Card and invoices.'
                  : 'Retry the payment in Card and invoices, if it offers to.'
              : ask
                ? `${ask} can sort it out.`
                : `${payer} can sort it out.`;
        return (
            <div className="flex flex-col gap-6">
                <Alert variant={paused ? 'warning' : 'destructive'} data-plan-notice="unpaid">
                    <AlertTitle>
                        {paused ? `${name} is paused` : `${name}’s payment didn’t go through`}
                    </AlertTitle>
                    <AlertDescription>
                        {paused
                            ? 'The plan is paused, so the family’s storage is empty until it resumes.'
                            : 'The plan gives no storage until it’s paid or replaced.'}{' '}
                        Nothing can be added to the family folders, nobody new can join, and
                        everyone’s own files count against their own storage again. Nothing is
                        deleted. {next}
                    </AlertDescription>
                    {actions.portal && (
                        <AlertAction>
                            <PortalButton
                                groupId={props.groupId}
                                label={paused ? 'Resume in Card and invoices' : 'Card and invoices'}
                            />
                        </AlertAction>
                    )}
                </Alert>
                {actions.choosePlan && <ChoosePlan {...props} renewing />}
            </div>
        );
    }
    if (state.kind === 'lapsed')
        return (
            <div className="flex flex-col gap-6">
                <Alert data-plan-notice="lapsed">
                    <AlertTitle>The family’s plan ended on {formatDay(state.endedAt)}</AlertTitle>
                    <AlertDescription>
                        {emptyPool
                            ? 'Nobody can upload to the family folders, and nobody new can join, until it’s renewed. Until then, everyone’s own files count against their own storage.'
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
        <div>
            <Alert data-plan-notice="none">
                <AlertTitle>No family plan right now</AlertTitle>
                <AlertDescription>
                    {emptyPool
                        ? `Nobody new can join ${family}, and nothing can be added to the family folders, until there’s a plan.`
                        : `Nobody new can join ${family} until there’s a plan.`}{' '}
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

/*
 * The payer's portal, where Polar may retry a failed payment or resume a paused plan. Outline:
 * choosing a plan (the one blue button) leads, since the portal may not take the payment.
 */
function PortalButton({ groupId, label }: { groupId: string; label: string }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    usePageRestored(() => setBusy(false));
    async function open() {
        setBusy(true);
        setError('');
        try {
            const { url } = await groupBillingApi.portal(groupId);
            window.location.assign(url);
        } catch (cause) {
            cue('error');
            setError(authError(cause));
            setBusy(false);
        }
    }
    return (
        <div className="flex flex-col gap-1">
            <Button
                variant="outline"
                className="w-fit"
                disabled={busy}
                onClick={() => void open()}
                data-family-portal
            >
                {busy ? 'Opening' : label}
                <ArrowUpRightIcon />
            </Button>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
        </div>
    );
}

/* The plans, monthly or yearly, in the visitor's currency as the pricing page picks it. */
function ChoosePlan({
    userId,
    groupId,
    family,
    summary,
    members,
    renewing,
}: Inner & { renewing?: boolean }) {
    // Only you in it so far (a new family): said. Others already in it (a plan that never
    // started, members kept from before): the sentence would be false, so it goes.
    const alone = !members?.some((member) => member.state === 'active' && member.userId !== userId);
    // A personal plan the person pays for ends when the family's plan starts, with the unused
    // days refunded (docs/families-shared-pool.md 3.3): said before they pay.
    const personal = useQuery(billingQueryOptions).data?.subscription;
    const ownPlan = personalPlanEnding(personal, 'the family’s plan starts');
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
    // Only while every tier's year is at most ten of its months, in this currency.
    const saving = twoMonthsFree(familyPairs(plans, currency));
    const shown = plans.filter((plan) => plan.interval === period);
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState('');
    // A plan Polar still holds that gives nothing ends when another is chosen: asked first.
    const [confirming, setConfirming] = useState<{ plan: FamilyPlan; words: string } | null>(null);
    usePageRestored(() => setBusy(null));
    const lapsed = summary.lapsedPlan ?? null;
    const lapsedName = lapsed ? tierName({ name: lapsed.productName }) : null;

    async function choose(plan: FamilyPlan, endLapsed = false) {
        // Ending it can't be taken back, and happens whether or not the checkout is finished.
        if (!endLapsed && lapsed && lapsedName) {
            setConfirming({
                plan,
                words: `This ends ${lapsedName} now, even if you don’t finish the checkout. ${lapsed.standing === 'paused' ? 'It is paused.' : 'Its payment didn’t go through.'} Then Polar’s checkout opens.`,
            });
            return;
        }
        setBusy(plan.id);
        setError('');
        try {
            // Exactly the plans the page showed: the server ends them only if they are the family's.
            const { url } = await groupBillingApi.checkout(
                groupId,
                plan.id,
                currency,
                endLapsed ? (lapsed?.ids ?? []) : undefined,
            );
            window.location.assign(url);
        } catch (cause) {
            setBusy(null);
            // One the page didn't know of (its payment failed since it loaded, or another): the
            // page reads the family's plan again and asks, with the server's words.
            if ((cause as { code?: string }).code === 'ends-lapsed') {
                await queryClient.invalidateQueries({
                    queryKey: familyBillingQueryOptions(userId, groupId).queryKey,
                });
                setConfirming({ plan, words: (cause as Error).message });
                return;
            }
            cue('error');
            setError(authError(cause));
        }
    }

    // The recommended tier leads; with none marked, the middle one does. One blue button.
    const lead = shown.find((plan) => plan.recommended) ?? shown[Math.floor(shown.length / 2)];

    return (
        <section
            id="choose-plan"
            aria-labelledby={`${groupId}-choose`}
            data-choose-plan
            className="flex scroll-mt-4 flex-col gap-4"
        >
            <div className="flex min-w-0 flex-col gap-0.5 border-b border-rule pb-3">
                <h2 id={`${groupId}-choose`} className="text-lg font-bold tracking-[-0.01em]">
                    Choose a plan
                </h2>
                {!renewing && (
                    <p className="max-w-[43em] text-sm text-muted-foreground">
                        Choose a plan before you invite anyone to {family} or make family folders.
                        {alone && ' Until then, only you are in it.'}
                    </p>
                )}
                {ownPlan && (
                    <p className="max-w-[43em] text-sm" data-personal-plan-ends>
                        {ownPlan} From then on your files use the family’s storage.
                    </p>
                )}
            </div>
            {intervals.size > 1 && (
                <Segmented
                    label="Billed"
                    options={[
                        { value: 'month', label: 'Monthly' },
                        { value: 'year', label: saving ? 'Yearly · 2 months free' : 'Yearly' },
                    ]}
                    value={period}
                    onChange={setPeriod}
                />
            )}
            {shown.length ? (
                <ul className="grid gap-3 lg:grid-cols-3">
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
                                    <span className="font-semibold text-foreground tabular-nums">
                                        {formatMoney(price.base, price.currency)}{' '}
                                        {per[plan.interval]}
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
                                    variant={plan === lead ? 'default' : 'outline'}
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
            <Dialog
                open={confirming !== null}
                onOpenChange={(open) => !open && busy === null && setConfirming(null)}
            >
                <DialogContent className="sm:max-w-[480px]" data-ends-lapsed>
                    {confirming && (
                        <>
                            <DialogHeader>
                                <DialogTitle>Choose {tierName(confirming.plan)}?</DialogTitle>
                                <DialogDescription>{confirming.words}</DialogDescription>
                            </DialogHeader>
                            <DialogFooter>
                                <Button
                                    variant="outline"
                                    disabled={busy !== null}
                                    onClick={() => setConfirming(null)}
                                >
                                    Not now
                                </Button>
                                <Button
                                    disabled={busy !== null}
                                    onClick={() => {
                                        const plan = confirming.plan;
                                        setConfirming(null);
                                        void choose(plan, true);
                                    }}
                                >
                                    {lapsedName ? `End ${lapsedName} and continue` : 'Continue'}
                                </Button>
                            </DialogFooter>
                        </>
                    )}
                </DialogContent>
            </Dialog>
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
    const [changing, setChanging] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const [busy, setBusy] = useState<'portal' | 'keep' | 'tier' | 'resume' | null>(null);
    const [error, setError] = useState('');
    usePageRestored(() => setBusy(null));
    if (state.kind !== 'live') return null;
    const live = state.subscription;
    const ends = formatDay(live.currentPeriodEnd);
    const name = `${tierName({ name: live.productName })} · ${formatQuota(live.quotaBytes)}`;
    const moving = pendingTier(summary);

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
            toast.add({ type: 'success', title: `The family’s plan keeps ${places(live.units)}` });
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setBusy(null);
        }
    }

    async function keepTier() {
        setBusy('tier');
        setError('');
        try {
            const result = await groupBillingApi.changePlan(groupId, live.productId);
            settle(result.billing);
            cue('success');
            toast.add({
                type: 'success',
                title: `The family’s plan stays on ${tierName({ name: live.productName })}`,
            });
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setBusy(null);
        }
    }

    async function resume() {
        setBusy('resume');
        setError('');
        try {
            const result = await groupBillingApi.resume(groupId);
            settle(result.billing);
            cue('success');
            toast.add({
                type: 'success',
                title: `The family’s plan renews on ${ends}`,
            });
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

    const anyChange =
        actions.changePlan ||
        actions.keepTier ||
        actions.addPlaces ||
        actions.removePlaces ||
        actions.keepPlaces;

    return (
        <SettingsGroup
            title="Billing"
            description={
                access === 'billing'
                    ? 'Only the person who pays for the plan can change it.'
                    : undefined
            }
        >
            <div data-family-plan="billing" id="billing" className="flex scroll-mt-4 flex-col">
                <Setting label="Plan">
                    <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="font-semibold">{name}</span>
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
                        {moving && !state.ending && (
                            <span className="text-sm" data-tier-move={moving.tier ?? moving.id}>
                                Changes to {tierName(moving)} · {formatQuota(moving.quotaBytes)} on{' '}
                                {ends}
                            </span>
                        )}
                    </span>
                </Setting>
                <Setting label="Places">
                    <Figure>
                        {summary.seats.used} of {summary.seats.limit} taken · {live.includedMembers}{' '}
                        included
                    </Figure>
                    {live.pendingUnits !== null && live.pendingUnits < live.units && (
                        <span className="block text-sm text-muted-foreground">
                            {places(live.units)} paid for until {ends}
                        </span>
                    )}
                    {live.paidUnits < live.units && (
                        <span className="block text-sm text-muted-foreground">
                            {places(live.units - live.paidUnits)} wait for the bank
                        </span>
                    )}
                </Setting>
                {charge && (
                    <Setting
                        label="Next charge"
                        below={
                            <p className="text-[13px] text-muted-foreground">{TAX_ON_CHARGES}</p>
                        }
                    >
                        <Figure>
                            {formatMoney(charge.amount, charge.currency)} on {formatDay(charge.on)}
                        </Figure>
                    </Setting>
                )}
                {payerName && (
                    <Setting
                        label="Paid by"
                        action={
                            actions.portal &&
                            // A failed renewal the payer must fix: the portal is the step, so a
                            // blue button. Otherwise a link: it opens Polar's page and changes
                            // nothing on the plan, beside Change plan and Add places.
                            (paymentNeedsYou(summary) ? (
                                <Button disabled={busy !== null} onClick={() => void portal()}>
                                    {busy === 'portal' ? 'Opening' : 'Card and invoices'}
                                    <ArrowUpRightIcon />
                                </Button>
                            ) : (
                                <PortalLink
                                    busy={busy === 'portal'}
                                    disabled={busy !== null}
                                    onOpen={() => void portal()}
                                />
                            ))
                        }
                    >
                        {payerName}
                    </Setting>
                )}
                {(anyChange || actions.cancel || actions.resume) && (
                    // One row: the changes first, Cancel plan last and quiet, at the row's end.
                    <div className="flex flex-wrap items-center gap-2 py-4">
                        {actions.changePlan && (
                            <Button
                                variant="outline"
                                disabled={busy !== null}
                                onClick={() => setChanging(true)}
                            >
                                Change plan
                            </Button>
                        )}
                        {actions.keepTier && (
                            <Button
                                variant="outline"
                                disabled={busy !== null}
                                onClick={() => void keepTier()}
                            >
                                {busy === 'tier'
                                    ? 'Keeping…'
                                    : `Keep ${tierName({ name: live.productName })}`}
                            </Button>
                        )}
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
                        {actions.resume && (
                            <Button
                                variant="outline"
                                disabled={busy !== null}
                                onClick={() => void resume()}
                            >
                                {busy === 'resume' ? 'Resuming…' : 'Resume plan'}
                            </Button>
                        )}
                        {actions.cancel && (
                            // Asked once, in a dialog; quiet here so it never outweighs the plan.
                            <Button
                                variant="destructive-ghost"
                                disabled={busy !== null}
                                onClick={() => setCancelling(true)}
                                // At the row's end, its words line up with the column's edge, as the outline buttons' do.
                                className={cn(anyChange && 'sm:-mr-3.5 sm:ml-auto')}
                            >
                                Cancel plan
                            </Button>
                        )}
                    </div>
                )}
                {error && (
                    <p role="alert" className="pb-4 text-sm text-destructive">
                        {error}
                    </p>
                )}
            </div>
            {actions.addPlaces && (
                <AddPlacesDialog
                    {...props}
                    open={adding}
                    onOpenChange={setAdding}
                    onDone={settle}
                />
            )}
            {actions.changePlan && (
                <ChangePlanDialog
                    {...props}
                    open={changing}
                    onOpenChange={setChanging}
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
            {actions.cancel && (
                <CancelFamilyPlanDialog
                    groupId={groupId}
                    family={family}
                    planName={tierName({ name: live.productName })}
                    quotaBytes={live.quotaBytes}
                    ends={ends}
                    open={cancelling}
                    onOpenChange={setCancelling}
                    onDone={(next) => {
                        settle(next);
                        setCancelling(false);
                        toast.add({ type: 'success', title: `The family’s plan ends on ${ends}` });
                    }}
                />
            )}
        </SettingsGroup>
    );
}

const reasonItems = [
    { value: '', label: 'Prefer not to say' },
    ...CANCELLATION_REASONS.map((value) => ({ value, label: cancellationReasonLabels[value] })),
];

/*
 * Cancelling the family's plan, here as a person cancels their own: what the family keeps and
 * until when, then why (the reason goes to Polar with it). It ends at the period's end, and
 * Resume plan takes it back until then.
 */
function CancelFamilyPlanDialog({
    groupId,
    family,
    planName,
    quotaBytes,
    ends,
    open,
    onOpenChange,
    onDone,
}: {
    groupId: string;
    family: string;
    planName: string;
    quotaBytes: string;
    ends: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onDone: (billing: FamilyBilling) => void;
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
            const result = await groupBillingApi.cancel(groupId, {
                reason: reason || undefined,
                comment: comment.trim() || undefined,
            });
            cue('success');
            onDone(result.billing);
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="sm:max-w-[480px]" data-cancel-family-plan>
                <DialogHeader>
                    <DialogTitle>Cancel the plan for {family}?</DialogTitle>
                    <DialogDescription>
                        The family keeps {planName} and {formatQuota(quotaBytes)} until {ends}.
                        After that, nothing new can be added to the family folders, and everyone’s
                        own files count against their own storage again. Nothing is deleted, and you
                        can resume the plan until then.
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
                        Keep the plan
                    </Button>
                    <Button variant="destructive" disabled={pending} onClick={() => void submit()}>
                        {pending ? 'Cancelling…' : 'Cancel plan'}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
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
 * "Change plan": the other tiers billed the same way. A bigger one starts now
 * and the difference for the rest of the period is charged at once; a smaller
 * one starts at the renewal, only once the family folders fit in it, and
 * refunds nothing. Places stay as they are.
 */
function ChangePlanDialog({ groupId, summary, open, onOpenChange, onDone }: DialogProps) {
    const id = useId();
    const moves = tierMoves(summary);
    const live = summary.subscription;
    const current = currentPlan(summary);
    const [choice, setChoice] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
    if (!live || !current || !moves.length) return null;
    const ends = formatDay(live.currentPeriodEnd);
    const interval = intervalOf(live.recurringInterval);
    // First open: the next tier up, else the next one down.
    const chosen =
        moves.find((move) => move.plan.id === choice) ??
        moves.find((move) => move.direction === 'up') ??
        moves.at(-1)!;
    const priceOf = (move: TierMove | null) => {
        const amount = renewalAmount(summary, live.pendingUnits ?? live.units, move?.plan);
        return amount ? `${formatMoney(amount.amount, amount.currency)} ${per[interval]}` : '';
    };
    const options = [...moves, null]
        .map((move) => ({ move, plan: move?.plan ?? current }))
        .sort((a, b) => Number(BigInt(a.plan.quotaBytes) - BigInt(b.plan.quotaBytes)));

    async function change() {
        setBusy(true);
        setError('');
        try {
            const result = await groupBillingApi.changePlan(groupId, chosen.plan.id);
            onDone(result.billing);
            if (result.confirmPayment && result.url) {
                setConfirmUrl(result.url);
                return;
            }
            cue('success');
            toast.add({
                type: 'success',
                title:
                    result.when === 'renewal'
                        ? `The family’s plan moves to ${tierName(chosen.plan)} on ${ends}`
                        : `The family’s plan is ${tierName(chosen.plan)} now`,
            });
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
                    setChoice(null);
                }
            }}
        >
            <DialogContent className="sm:max-w-[480px]">
                <DialogHeader>
                    <DialogTitle>Change plan</DialogTitle>
                    <DialogDescription>
                        A bigger plan starts now. A smaller one starts when the plan renews on{' '}
                        {ends}, and nothing is refunded. Places stay as they are.
                    </DialogDescription>
                </DialogHeader>
                <RadioGroup
                    value={chosen.plan.id}
                    onValueChange={(value) => setChoice(String(value))}
                    aria-label="Plan"
                    className="flex-col items-stretch gap-1"
                    disabled={busy || confirmUrl !== null}
                >
                    {options.map(({ move, plan }) => {
                        const selected = move !== null && move === chosen;
                        return (
                            <label
                                key={plan.id}
                                htmlFor={`${id}-${plan.id}`}
                                data-tier-option={plan.tier ?? plan.id}
                                className={cn(
                                    'flex items-start gap-3 rounded-md px-3 py-2.5',
                                    move === null
                                        ? 'cursor-default'
                                        : selected
                                          ? 'cursor-pointer bg-accent'
                                          : 'cursor-pointer hover:bg-muted',
                                )}
                            >
                                <RadioGroupItem
                                    id={`${id}-${plan.id}`}
                                    value={plan.id}
                                    disabled={move === null}
                                    className="mt-0.5"
                                />
                                <span className="flex min-w-0 flex-1 flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                                    <span className="text-sm font-semibold">
                                        {tierName(plan)} · {formatQuota(plan.quotaBytes)}
                                    </span>
                                    <span className="text-[13px] text-muted-foreground tabular-nums">
                                        {move === null ? 'Your plan' : priceOf(move)}
                                    </span>
                                </span>
                            </label>
                        );
                    })}
                </RadioGroup>
                <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
                    {chosen.direction === 'up' ? (
                        <>
                            {chosen.now && (
                                <Fact label="Charged now">
                                    About {formatMoney(chosen.now.amount, chosen.now.currency)}
                                </Fact>
                            )}
                            {chosen.renews && (
                                <Fact label="Then">
                                    {formatMoney(chosen.renews.amount, chosen.renews.currency)}{' '}
                                    {per[interval]} from {ends}
                                </Fact>
                            )}
                        </>
                    ) : (
                        <>
                            <Fact label="Until then">
                                {tierName(current)} · {formatQuota(current.quotaBytes)}
                            </Fact>
                            {chosen.renews && (
                                <Fact label={`From ${ends}`}>
                                    {formatMoney(chosen.renews.amount, chosen.renews.currency)}{' '}
                                    {per[interval]}
                                </Fact>
                            )}
                        </>
                    )}
                </dl>
                {chosen.over > 0n && summary.storage && (
                    <Alert variant="warning" data-tier-over>
                        <AlertDescription>
                            Your family stores {spaceOf(BigInt(summary.storage.usedBytes))}, more
                            than {tierName(chosen.plan)}’s {spaceOf(BigInt(chosen.plan.quotaBytes))}
                            . Free at least {spaceOf(chosen.over, 'up')} before changing to it.
                        </AlertDescription>
                    </Alert>
                )}
                <p className="text-[13px] text-muted-foreground">
                    {chosen.direction === 'up'
                        ? `The difference for the rest of this period is charged to the family’s card now. ${TAX_ON_CHARGES}`
                        : TAX_ON_CHARGES}
                </p>
                {confirmUrl && (
                    <Alert variant="warning">
                        <AlertDescription>
                            Your bank wants you to confirm this payment. The plan changes once you
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
                        <Button disabled={busy || chosen.over > 0n} onClick={() => void change()}>
                            {busy
                                ? 'Changing…'
                                : chosen.direction === 'up'
                                  ? `Change to ${tierName(chosen.plan)}`
                                  : `Change on ${ends}`}
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
function RemovePlacesDialog({ groupId, summary, open, onOpenChange, onDone }: DialogProps) {
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
            toast.add({
                type: 'success',
                title: `The family’s plan has ${places(value)} from ${ends}`,
            });
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
                        From {ends}, the family’s plan has fewer places. Nothing is refunded and
                        nobody is removed. Nobody new can take the places you remove, starting now.
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
    // Set to end: the payer resumes it here first.
    else if (reason === 'canceling' && payerYou)
        body = <p>Resume the plan under Billing first; then they can join.</p>;
    // A declined or unconfirmed charge is fixed with the card: the portal is the step, a button.
    else if ((reason === 'declined' || reason === 'confirm') && payerYou)
        body = (
            <Button variant="outline" disabled={busy} onClick={() => void portal()}>
                {busy ? 'Opening' : 'Card and invoices'}
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

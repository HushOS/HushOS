import type { AffiliateInput, AffiliateView } from '@hushos/billing/api';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { CopyValue } from '@/components/copy-value';
import { DriveShell } from '@/components/drive/drive-shell';
import { FormActions, FormNote, FormRow, FormTable } from '@/components/form-rows';
import { PendingLabel, Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { formatWhen } from '@/lib/drive';
import { affiliatesQueryOptions, describeCommission, describeDiscount } from '@/lib/growth';
import { growthApi } from '@/lib/growth-api';
import { money } from '@/routes/_authenticated/app/referrals';

/*
 * The operator's affiliates: creators with a code, a page, a discount and a
 * commission. Enrolling one registers the discount with the payment provider;
 * earnings accrue per paid order and are marked paid here once settled.
 */
export const Route = createFileRoute('/_authenticated/app/admin/affiliates')({
    beforeLoad: ({ context }) => {
        if (context.user.role !== 'admin') throw redirect({ to: '/app' });
    },
    head: () => ({ meta: [{ title: 'Affiliates · HushOS' }] }),
    component: AffiliatesPage,
});

function AffiliatesPage() {
    const { user } = Route.useRouteContext();
    return (
        <DriveShell user={user}>
            <Affiliates />
        </DriveShell>
    );
}

const field = 'h-12 w-full border-0 bg-transparent px-4 font-mono text-sm focus-visible:ring-0';

function message(error: unknown) {
    return error instanceof Error ? error.message : 'Please try again.';
}

function Affiliates() {
    const queryClient = useQueryClient();
    const list = useQuery(affiliatesQueryOptions);
    const [busy, setBusy] = useState<string | null>(null);
    async function act(id: string, run: () => Promise<unknown>, done: string) {
        setBusy(id);
        try {
            await run();
            await queryClient.invalidateQueries({ queryKey: affiliatesQueryOptions.queryKey });
            toast.add({ type: 'success', title: done });
        } catch (error) {
            toast.add({ type: 'error', title: 'That did not work', description: message(error) });
        } finally {
            setBusy(null);
        }
    }
    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                eyebrow="Operator"
                title="Affiliates"
                description="Creators with a code and a page. Their discount is registered with the payment provider when you enrol them; their commission accrues on every paid order from people who signed up through them, and you mark it paid once you have sent it. A discount you create at Polar yourself has a page as well, at /go/<code>, with no commission attached."
            />
            <div className="flex flex-col gap-8 px-5 py-6 sm:px-8 sm:py-8">
                <NewAffiliate
                    onCreated={() =>
                        queryClient.invalidateQueries({ queryKey: affiliatesQueryOptions.queryKey })
                    }
                />
                {list.isPending ? (
                    <div className="flex items-center justify-center py-10 text-muted-foreground">
                        <Spinner />
                    </div>
                ) : list.isError ? (
                    <FormNote tone="destructive">{message(list.error)}</FormNote>
                ) : list.data.length === 0 ? (
                    <p className="font-mono text-xs text-muted-foreground">No affiliates yet.</p>
                ) : (
                    <ul className="flex flex-col gap-6">
                        {list.data.map((affiliate) => (
                            <AffiliateCard
                                key={affiliate.id}
                                affiliate={affiliate}
                                busy={busy === affiliate.id}
                                onToggle={() =>
                                    void act(
                                        affiliate.id,
                                        () =>
                                            growthApi.updateAffiliate(affiliate.id, {
                                                active: !affiliate.active,
                                            }),
                                        affiliate.active ? 'Affiliate paused' : 'Affiliate active',
                                    )
                                }
                                onPaid={() =>
                                    void act(
                                        affiliate.id,
                                        () => growthApi.markAffiliatePaid(affiliate.id),
                                        'Marked as paid',
                                    )
                                }
                            />
                        ))}
                    </ul>
                )}
            </div>
        </div>
    );
}

function AffiliateCard({
    affiliate,
    busy,
    onToggle,
    onPaid,
}: {
    affiliate: AffiliateView;
    busy: boolean;
    onToggle: () => void;
    onPaid: () => void;
}) {
    const owed = money(affiliate.stats.earnings, 'unpaid');
    return (
        <li className="border bg-card" data-affiliate={affiliate.slug}>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
                <div className="min-w-0">
                    <p className="text-base font-medium tracking-tight">{affiliate.name}</p>
                    <p className="font-mono text-xs text-muted-foreground">
                        {describeDiscount(affiliate)} ·{' '}
                        {describeCommission(affiliate.commissionBps)} commission · enrolled{' '}
                        {formatWhen(affiliate.createdAt)}
                        {affiliate.active ? '' : ' · paused'}
                    </p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={busy} onClick={onToggle}>
                        {affiliate.active ? 'Pause' : 'Resume'}
                    </Button>
                    <Button size="sm" disabled={busy || owed === '–'} onClick={onPaid}>
                        Mark paid
                    </Button>
                </div>
            </div>
            <div className="grid sm:grid-cols-2">
                <div className="border-b px-4 py-3 sm:border-r sm:border-b-0">
                    <p className="eyebrow text-muted-foreground">Page</p>
                    <CopyValue
                        value={affiliate.url}
                        label="Copy affiliate page"
                        wrap
                        className="mt-1"
                    />
                </div>
                <div className="border-b px-4 py-3 sm:border-b-0">
                    <p className="eyebrow text-muted-foreground">Code</p>
                    <CopyValue value={affiliate.code} label="Copy code" className="mt-1" />
                </div>
            </div>
            <dl className="grid border-t font-mono text-sm sm:grid-cols-4">
                {[
                    ['Sign-ups', String(affiliate.stats.signups)],
                    ['Paid orders', String(affiliate.stats.orders)],
                    ['Owed', owed],
                    ['Paid out', money(affiliate.stats.earnings, 'paid')],
                ].map(([label, value]) => (
                    <div
                        key={label}
                        className="flex flex-col gap-1 border-b px-4 py-3 last:border-b-0 sm:border-r sm:border-b-0 sm:last:border-r-0"
                    >
                        <dt className="eyebrow text-muted-foreground">{label}</dt>
                        <dd className="tabular-nums">{value}</dd>
                    </div>
                ))}
            </dl>
            {affiliate.notes && (
                <p className="border-t px-4 py-3 font-mono text-xs text-muted-foreground">
                    {affiliate.notes}
                </p>
            )}
            {!affiliate.providerDiscountId && (
                <p className="border-t px-4 py-3 font-mono text-xs text-destructive">
                    No discount is registered with the payment provider, so the code cannot be
                    applied at checkout.
                </p>
            )}
        </li>
    );
}

const DURATIONS: { value: AffiliateInput['duration']; label: string }[] = [
    { value: 'forever', label: 'For as long as they stay' },
    { value: 'once', label: 'First payment only' },
    { value: 'repeating', label: 'A number of months' },
];

const empty: AffiliateInput = {
    name: '',
    slug: '',
    code: '',
    percentOff: 20,
    duration: 'forever',
    durationMonths: 3,
    commissionBps: 2000,
    userEmail: '',
    notes: '',
};

function NewAffiliate({ onCreated }: { onCreated: () => Promise<unknown> }) {
    const id = useId();
    const [form, setForm] = useState<AffiliateInput>(empty);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const set = <K extends keyof AffiliateInput>(key: K, value: AffiliateInput[K]) =>
        setForm((current) => ({ ...current, [key]: value }));
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setPending(true);
        setError('');
        try {
            const created = await growthApi.createAffiliate({
                ...form,
                userEmail: form.userEmail?.trim() || null,
                notes: form.notes?.trim() || null,
                durationMonths: form.duration === 'repeating' ? form.durationMonths : null,
            });
            setForm(empty);
            toast.add({
                type: 'success',
                title: `${created.name} enrolled`,
                description: created.url,
            });
            await onCreated();
        } catch (cause) {
            setError(message(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-3">
            <p className="eyebrow text-muted-foreground">Enrol a creator</p>
            <FormTable>
                <FormRow label="Name" htmlFor={`${id}-name`}>
                    <Input
                        id={`${id}-name`}
                        className={field}
                        value={form.name}
                        onChange={(event) => set('name', event.target.value)}
                        placeholder="Ada on YouTube"
                        required
                        maxLength={100}
                    />
                </FormRow>
                <FormRow label="Page slug" htmlFor={`${id}-slug`}>
                    <Input
                        id={`${id}-slug`}
                        className={field}
                        value={form.slug}
                        onChange={(event) => set('slug', event.target.value)}
                        placeholder="ada"
                        required
                        maxLength={40}
                        pattern="[A-Za-z0-9-]+"
                    />
                </FormRow>
                <FormRow label="Code" htmlFor={`${id}-code`}>
                    <Input
                        id={`${id}-code`}
                        className={`${field} uppercase`}
                        value={form.code}
                        onChange={(event) => set('code', event.target.value)}
                        placeholder="ADA20"
                        required
                        minLength={3}
                        maxLength={32}
                        pattern="[A-Za-z0-9]+"
                    />
                </FormRow>
                <FormRow label="Percent off" htmlFor={`${id}-percent`}>
                    <Input
                        id={`${id}-percent`}
                        className={field}
                        type="number"
                        min={1}
                        max={100}
                        value={form.percentOff}
                        onChange={(event) => set('percentOff', Number(event.target.value))}
                        required
                    />
                </FormRow>
                <FormRow label="Lasts" htmlFor={`${id}-duration`}>
                    <div className="flex flex-wrap items-center gap-3 px-4 py-2">
                        <Select
                            value={form.duration}
                            onValueChange={(value) =>
                                set('duration', value as AffiliateInput['duration'])
                            }
                            items={DURATIONS}
                        >
                            <SelectTrigger
                                id={`${id}-duration`}
                                aria-label="Lasts"
                                className="h-9 w-full bg-card sm:w-64"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {DURATIONS.map((entry) => (
                                    <SelectItem key={entry.value} value={entry.value}>
                                        {entry.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        {form.duration === 'repeating' && (
                            <Input
                                aria-label="Months"
                                className="h-9 w-20 font-mono text-sm"
                                type="number"
                                min={1}
                                max={36}
                                value={form.durationMonths ?? 3}
                                onChange={(event) =>
                                    set('durationMonths', Number(event.target.value))
                                }
                            />
                        )}
                    </div>
                </FormRow>
                <FormRow label="Commission" htmlFor={`${id}-commission`}>
                    <div className="flex flex-wrap items-center gap-3 px-4 py-2">
                        <Input
                            id={`${id}-commission`}
                            className="h-9 w-28 font-mono text-sm"
                            type="number"
                            min={0}
                            max={100}
                            step={0.25}
                            value={form.commissionBps / 100}
                            onChange={(event) =>
                                set('commissionBps', Math.round(Number(event.target.value) * 100))
                            }
                            required
                        />
                        <span className="font-mono text-xs text-muted-foreground">
                            % of each paid order, net of tax
                        </span>
                    </div>
                </FormRow>
                <FormRow label="Their account" htmlFor={`${id}-email`}>
                    <Input
                        id={`${id}-email`}
                        className={field}
                        type="email"
                        value={form.userEmail ?? ''}
                        onChange={(event) => set('userEmail', event.target.value)}
                        placeholder="Optional: the email of their HushOS account, to show earnings in their Drive"
                    />
                </FormRow>
                <FormRow label="Notes" htmlFor={`${id}-notes`}>
                    <Input
                        id={`${id}-notes`}
                        className={field}
                        value={form.notes ?? ''}
                        onChange={(event) => set('notes', event.target.value)}
                        placeholder="How to pay them, agreed terms"
                        maxLength={2000}
                    />
                </FormRow>
                {error && <FormNote tone="destructive">{error}</FormNote>}
                <FormActions
                    action={
                        <Button type="submit" disabled={pending}>
                            <PendingLabel pending={pending} idle="Enrol" busy="Enrolling" />
                        </Button>
                    }
                >
                    The discount is created at the payment provider first.
                </FormActions>
            </FormTable>
        </form>
    );
}

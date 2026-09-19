import type { AffiliateInput, AffiliateView } from '@hushos/billing/api';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { CopyValue } from '@/components/copy-value';
import { FormActions, FormNote, FormRow, FormTable } from '@/components/form-rows';
import { PendingLabel, Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
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
import { money } from '@/routes/_authenticated/app/_drive/referrals';

/*
 * The operator's affiliates: creators with a code, a page, a discount and a
 * commission. Enrolling one registers the discount with the payment provider;
 * earnings accrue per paid order and are marked paid here once settled.
 */
export const Route = createFileRoute('/_authenticated/app/_drive/admin/affiliates')({
    beforeLoad: ({ context }) => {
        if (context.user.role !== 'admin') throw redirect({ to: '/app/drive' });
    },
    head: () => ({ meta: [{ title: 'Affiliates · HushOS' }] }),
    component: AffiliatesPage,
});

function AffiliatesPage() {
    return (
        <>
            <Affiliates />
        </>
    );
}

const field = 'w-full';

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
                description="Creators with a code and a page. Their discount is registered with the payment provider when you enrol them; their commission accrues on every paid order from people who signed up through them, and you mark it paid once you have sent it. An affiliate need not be a person: a campaign with a code and a page, and no commission, works the same way. A discount you create at Polar yourself has a page as well, at /go/<code>."
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
                    <p className="text-sm text-muted-foreground">No affiliates yet.</p>
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
                                onDelete={() =>
                                    void act(
                                        affiliate.id,
                                        () => growthApi.deleteAffiliate(affiliate.id),
                                        `${affiliate.name} removed`,
                                    )
                                }
                                onSaved={() =>
                                    queryClient.invalidateQueries({
                                        queryKey: affiliatesQueryOptions.queryKey,
                                    })
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
    onDelete,
    onSaved,
}: {
    affiliate: AffiliateView;
    busy: boolean;
    onToggle: () => void;
    onPaid: () => void;
    onDelete: () => void;
    onSaved: () => Promise<unknown>;
}) {
    const owed = money(affiliate.stats.earnings, 'unpaid');
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    return (
        <li
            className="divide-y divide-rule rounded-md border border-rule"
            data-affiliate={affiliate.slug}
        >
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-2 text-base font-bold tracking-tight">
                        {affiliate.name}
                        <Badge variant={affiliate.active ? 'success' : 'warning'}>
                            {affiliate.active ? 'active' : 'paused'}
                        </Badge>
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                        {describeDiscount(affiliate)} ·{' '}
                        {describeCommission(affiliate.commissionBps)} commission · enrolled{' '}
                        {formatWhen(affiliate.createdAt)}
                    </p>
                </div>
                <div className="flex flex-wrap gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        aria-pressed={editing}
                        disabled={busy}
                        onClick={() => setEditing((on) => !on)}
                    >
                        Edit
                    </Button>
                    <Button variant="outline" size="sm" disabled={busy} onClick={onToggle}>
                        {affiliate.active ? 'Pause' : 'Resume'}
                    </Button>
                    <Button
                        variant="destructive-outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => setDeleting(true)}
                    >
                        Delete
                    </Button>
                    <Button size="sm" disabled={busy || owed === '–'} onClick={onPaid}>
                        Mark paid
                    </Button>
                </div>
            </div>
            <AlertDialog open={deleting} onOpenChange={setDeleting}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove {affiliate.name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {owed === '–'
                                ? `Their page and code stop working, the discount is removed at the payment provider, and the record of what they were paid goes with them. People who signed up through them keep their accounts.`
                                : `They are still owed ${owed}. Mark it paid first, or pause them instead.`}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep them</AlertDialogCancel>
                        <AlertDialogAction
                            disabled={owed !== '–'}
                            onClick={() => {
                                setDeleting(false);
                                onDelete();
                            }}
                        >
                            Remove
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
            {editing && (
                <EditAffiliate
                    affiliate={affiliate}
                    onCancel={() => setEditing(false)}
                    onSaved={async () => {
                        await onSaved();
                        setEditing(false);
                    }}
                />
            )}
            <div className="grid gap-y-3 px-4 py-3 sm:grid-cols-2 sm:gap-x-6">
                <div className="min-w-0">
                    <p className="eyebrow text-muted-foreground">Page</p>
                    <CopyValue
                        value={affiliate.url}
                        label="Copy affiliate page"
                        wrap
                        className="mt-1"
                    />
                </div>
                <div className="min-w-0">
                    <p className="eyebrow text-muted-foreground">Code</p>
                    <CopyValue value={affiliate.code} label="Copy code" className="mt-1" />
                </div>
            </div>
            <dl className="grid grid-cols-2 gap-y-3 px-4 py-3 text-sm sm:grid-cols-4">
                {[
                    ['Sign-ups', String(affiliate.stats.signups)],
                    ['Paid orders', String(affiliate.stats.orders)],
                    ['Owed', owed],
                    ['Paid out', money(affiliate.stats.earnings, 'paid')],
                ].map(([label, value]) => (
                    <div key={label} className="flex flex-col gap-1">
                        <dt className="eyebrow text-muted-foreground">{label}</dt>
                        <dd className="text-base font-bold tabular-nums">{value}</dd>
                    </div>
                ))}
            </dl>
            {affiliate.notes && (
                <p className="px-4 py-3 text-sm leading-relaxed text-muted-foreground">
                    {affiliate.notes}
                </p>
            )}
            {!affiliate.providerDiscountId && (
                <p className="rounded-b-md bg-destructive-soft px-4 py-3 text-sm leading-relaxed text-destructive">
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
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setPending(true);
        setError('');
        try {
            const created = await growthApi.createAffiliate(toInput(form));
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
            <h2 className="text-lg font-bold">Enrol a creator</h2>
            <FormTable>
                <AffiliateFields id={id} form={form} onChange={setForm} />
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

/* The card's own form: the same rows as enrolment, filled in, saved as one change. */
function EditAffiliate({
    affiliate,
    onCancel,
    onSaved,
}: {
    affiliate: AffiliateView;
    onCancel: () => void;
    onSaved: () => Promise<unknown>;
}) {
    const id = useId();
    const [form, setForm] = useState<AffiliateInput>({
        name: affiliate.name,
        slug: affiliate.slug,
        code: affiliate.code,
        percentOff: affiliate.percentOff,
        duration: affiliate.duration,
        durationMonths: affiliate.durationMonths ?? 3,
        commissionBps: affiliate.commissionBps,
        // The account is shown by its id only; leaving the field empty keeps it, and a new email replaces it.
        userEmail: '',
        notes: affiliate.notes ?? '',
    });
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setPending(true);
        setError('');
        try {
            const input = toInput(form);
            await growthApi.updateAffiliate(affiliate.id, {
                ...input,
                ...(input.userEmail ? { userEmail: input.userEmail } : {}),
            });
            toast.add({ type: 'success', title: `${input.name} updated` });
            await onSaved();
        } catch (cause) {
            setError(message(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <form
            onSubmit={(event) => void submit(event)}
            className="flex flex-col gap-3 px-4 py-4"
            aria-label={`Edit ${affiliate.name}`}
        >
            <FormTable>
                <AffiliateFields
                    id={id}
                    form={form}
                    onChange={setForm}
                    accountPlaceholder={
                        affiliate.userId
                            ? 'Linked to an account. Enter another email to change it.'
                            : 'Optional: the email of their HushOS account, to show earnings in their Drive'
                    }
                />
                {error && <FormNote tone="destructive">{error}</FormNote>}
                <FormActions
                    action={
                        <Button type="submit" disabled={pending}>
                            <PendingLabel pending={pending} idle="Save" busy="Saving" />
                        </Button>
                    }
                >
                    <button type="button" className="text-link cursor-pointer" onClick={onCancel}>
                        Cancel
                    </button>
                    A changed code or discount is changed at the payment provider first.
                </FormActions>
            </FormTable>
        </form>
    );
}

/* What the server wants: trimmed optionals as null, and months only for a repeating discount. */
function toInput(form: AffiliateInput): AffiliateInput {
    return {
        ...form,
        userEmail: form.userEmail?.trim() || null,
        notes: form.notes?.trim() || null,
        durationMonths: form.duration === 'repeating' ? form.durationMonths : null,
    };
}

function AffiliateFields({
    id,
    form,
    onChange,
    accountPlaceholder = 'Optional: the email of their HushOS account, to show earnings in their Drive',
}: {
    id: string;
    form: AffiliateInput;
    onChange: React.Dispatch<React.SetStateAction<AffiliateInput>>;
    accountPlaceholder?: string;
}) {
    const set = <K extends keyof AffiliateInput>(key: K, value: AffiliateInput[K]) =>
        onChange((current) => ({ ...current, [key]: value }));
    return (
        <>
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
                    className={`${field} font-mono`}
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
                    className={`${field} font-mono uppercase`}
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
                <div className="flex flex-wrap items-center gap-3">
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
                            className="w-full sm:w-64"
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
                            className="w-20 tabular-nums"
                            type="number"
                            min={1}
                            max={36}
                            value={form.durationMonths ?? 3}
                            onChange={(event) => set('durationMonths', Number(event.target.value))}
                        />
                    )}
                </div>
            </FormRow>
            <FormRow label="Commission" htmlFor={`${id}-commission`}>
                <div className="flex flex-wrap items-center gap-3">
                    <Input
                        id={`${id}-commission`}
                        className="w-28 tabular-nums"
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
                    <span className="text-sm text-muted-foreground">
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
                    placeholder={accountPlaceholder}
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
        </>
    );
}

import type { AffiliateInput, AffiliateView } from '@hushos/billing/api';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { cn } from 'cn';
import { PlusIcon } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { CopyValue } from '@/components/copy-value';
import { Spinner } from '@/components/motion';
import { OperatorHeader, OperatorTable, td, th } from '@/components/operator';
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

function message(error: unknown) {
    return error instanceof Error ? error.message : 'Please try again.';
}

function Affiliates() {
    const queryClient = useQueryClient();
    const list = useQuery(affiliatesQueryOptions);
    const [busy, setBusy] = useState<string | null>(null);
    const [adding, setAdding] = useState(false);
    async function act(id: string, run: () => Promise<unknown>, done: string) {
        setBusy(id);
        try {
            await run();
            await queryClient.invalidateQueries({ queryKey: affiliatesQueryOptions.queryKey });
            toast.add({ type: 'success', title: done });
        } catch (error) {
            toast.add({ type: 'error', title: 'That didn’t work', description: message(error) });
        } finally {
            setBusy(null);
        }
    }
    return (
        <div className="flex flex-1 flex-col pb-10">
            <OperatorHeader
                title="Affiliates"
                description="Creators who bring people in for a discount and a commission. Enrolling one registers the discount with the payment provider; their commission accrues on each paid order, and you mark it paid once you have sent it. A discount made at Polar directly has a page too, at /go/<code>."
            >
                <Button size="sm" onClick={() => setAdding(true)}>
                    <PlusIcon />
                    Add affiliate
                </Button>
            </OperatorHeader>
            <AffiliateDialog
                open={adding}
                onOpenChange={setAdding}
                onSaved={() =>
                    queryClient.invalidateQueries({ queryKey: affiliatesQueryOptions.queryKey })
                }
            />
            <div className="flex flex-col gap-6 px-5 sm:px-8">
                {list.isPending ? (
                    <div className="flex items-center justify-center py-10 text-muted-foreground">
                        <Spinner />
                    </div>
                ) : list.isError ? (
                    <p
                        role="alert"
                        className="rounded-md bg-destructive-soft px-4 py-3 text-sm text-destructive"
                    >
                        {message(list.error)}
                    </p>
                ) : list.data.length === 0 ? (
                    <p className="py-12 text-center text-sm text-muted-foreground">
                        No affiliates yet.
                    </p>
                ) : (
                    <OperatorTable>
                        <thead>
                            <tr>
                                <th className={th}>Creator</th>
                                <th className={th}>Code</th>
                                <th className={th}>Status</th>
                                <th className={cn(th, 'text-right')}>Sign-ups</th>
                                <th className={cn(th, 'text-right')}>Paid orders</th>
                                <th className={cn(th, 'text-right')}>Owed</th>
                                <th className={cn(th, 'text-right')}>Paid out</th>
                                <th className={th}>
                                    <span className="sr-only">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {list.data.map((affiliate) => (
                                <AffiliateRow
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
                                            affiliate.active
                                                ? `${affiliate.name} paused`
                                                : `${affiliate.name} resumed`,
                                        )
                                    }
                                    onPaid={(owed) =>
                                        void act(
                                            affiliate.id,
                                            () => growthApi.markAffiliatePaid(affiliate.id),
                                            `${owed} marked paid to ${affiliate.name}`,
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
                        </tbody>
                    </OperatorTable>
                )}
            </div>
        </div>
    );
}

/* One creator: a row of numbers and actions; Edit opens their fields underneath. */
function AffiliateRow({
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
    onPaid: (owed: string) => void;
    onDelete: () => void;
    onSaved: () => Promise<unknown>;
}) {
    const owed = money(affiliate.stats.earnings, 'unpaid');
    const [editing, setEditing] = useState(false);
    const [deleting, setDeleting] = useState(false);
    return (
        <>
            <tr data-affiliate={affiliate.slug} className="hover:bg-muted">
                <td className={cn(td, 'max-w-[260px]')}>
                    <span className="block truncate pt-1 font-semibold">{affiliate.name}</span>
                    <span className="block truncate pb-1 text-xs text-muted-foreground">
                        {describeDiscount(affiliate)} ·{' '}
                        {describeCommission(affiliate.commissionBps)} commission
                    </span>
                </td>
                <td className={cn(td, 'font-mono')}>
                    <CopyValue value={affiliate.code} label="Code" />
                </td>
                <td className={cn(td, 'whitespace-nowrap')}>
                    {!affiliate.providerDiscountId ? (
                        <span
                            className="font-semibold text-destructive"
                            title="No discount is registered with the payment provider, so the code can’t be applied at checkout."
                        >
                            No discount
                        </span>
                    ) : affiliate.active ? (
                        'Active'
                    ) : (
                        <span className="text-muted-foreground">Paused</span>
                    )}
                </td>
                <td className={cn(td, 'text-right font-mono tabular-nums')}>
                    {affiliate.stats.signups}
                </td>
                <td className={cn(td, 'text-right font-mono tabular-nums')}>
                    {affiliate.stats.orders}
                </td>
                <td
                    className={cn(
                        td,
                        'text-right font-mono tabular-nums',
                        owed !== '–' && 'font-semibold',
                    )}
                >
                    {owed}
                </td>
                <td className={cn(td, 'text-right font-mono tabular-nums')}>
                    {money(affiliate.stats.earnings, 'paid')}
                </td>
                <td className={cn(td, 'text-right whitespace-nowrap')}>
                    <span className="inline-flex gap-1">
                        <Button
                            variant="ghost"
                            size="xs"
                            aria-label={`Edit ${affiliate.name}`}
                            disabled={busy}
                            onClick={() => setEditing(true)}
                        >
                            Edit
                        </Button>
                        <Button
                            variant="ghost"
                            size="xs"
                            aria-label={`${affiliate.active ? 'Pause' : 'Resume'} ${affiliate.name}`}
                            disabled={busy}
                            onClick={onToggle}
                        >
                            {affiliate.active ? 'Pause' : 'Resume'}
                        </Button>
                        {owed !== '–' && (
                            <Button
                                variant="ghost"
                                size="xs"
                                aria-label={`Mark ${owed} paid to ${affiliate.name}`}
                                disabled={busy}
                                onClick={() => onPaid(owed)}
                            >
                                Mark paid
                            </Button>
                        )}
                        <Button
                            variant="ghost"
                            size="xs"
                            aria-label={`Remove ${affiliate.name}`}
                            className="text-destructive hover:bg-destructive-soft hover:text-destructive"
                            disabled={busy}
                            onClick={() => setDeleting(true)}
                        >
                            Remove
                        </Button>
                    </span>
                    <AlertDialog open={deleting} onOpenChange={setDeleting}>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>Remove {affiliate.name}?</AlertDialogTitle>
                                <AlertDialogDescription>
                                    {owed === '–'
                                        ? 'Their page and code stop working, the discount is removed at the payment provider, and the record of what they were paid goes with them. People who signed up through them keep their accounts.'
                                        : `They are still owed ${owed}. Mark it paid first, or pause them instead.`}
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>Keep them</AlertDialogCancel>
                                {owed === '–' && (
                                    <AlertDialogAction
                                        variant="destructive"
                                        onClick={() => {
                                            setDeleting(false);
                                            onDelete();
                                        }}
                                    >
                                        Remove
                                    </AlertDialogAction>
                                )}
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                </td>
            </tr>
            <AffiliateDialog
                affiliate={affiliate}
                open={editing}
                onOpenChange={setEditing}
                onSaved={onSaved}
            />
        </>
    );
}

const DURATIONS: { value: AffiliateInput['duration']; label: string }[] = [
    { value: 'forever', label: 'Always' },
    { value: 'once', label: 'First payment' },
    { value: 'repeating', label: 'Some months' },
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

/*
 * Enrol a creator, or change one: the same fields either way, in a dialog. A
 * change to the code or the discount is made at the payment provider first.
 */
function AffiliateDialog({
    affiliate,
    open,
    onOpenChange,
    onSaved,
}: {
    affiliate?: AffiliateView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSaved: () => Promise<unknown>;
}) {
    const id = useId();
    const initial = (): AffiliateInput =>
        affiliate
            ? {
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
              }
            : empty;
    const [form, setForm] = useState<AffiliateInput>(initial);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setPending(true);
        setError('');
        try {
            const input = toInput(form);
            if (affiliate) {
                await growthApi.updateAffiliate(affiliate.id, {
                    ...input,
                    ...(input.userEmail ? { userEmail: input.userEmail } : {}),
                });
                toast.add({ type: 'success', title: `${input.name} updated` });
            } else {
                const created = await growthApi.createAffiliate(input);
                toast.add({
                    type: 'success',
                    title: `${created.name} enrolled`,
                    description: created.url,
                });
            }
            await onSaved();
            onOpenChange(false);
        } catch (cause) {
            setError(message(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (pending) return;
                // Every opening starts from the creator as saved, or from empty.
                if (next) {
                    setForm(initial());
                    setError('');
                }
                onOpenChange(next);
            }}
        >
            <DialogContent className="sm:max-w-[560px]">
                <form onSubmit={(event) => void submit(event)} className="contents" noValidate>
                    <DialogHeader>
                        <DialogTitle>
                            {affiliate ? `Edit ${affiliate.name}` : 'Add an affiliate'}
                        </DialogTitle>
                        <DialogDescription>
                            {affiliate ? (
                                <>
                                    Their page is <span className="font-mono">{affiliate.url}</span>
                                    , enrolled {formatWhen(affiliate.createdAt, { lower: true })}. A
                                    changed code or discount is changed at the payment provider
                                    first.
                                </>
                            ) : (
                                'A creator, or a campaign, with a code and a page. The discount is created at the payment provider first.'
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <AffiliateFields
                        id={id}
                        form={form}
                        onChange={setForm}
                        accountPlaceholder={
                            affiliate?.userId
                                ? 'Linked. Another email changes it.'
                                : 'Optional: shows their earnings in their Drive'
                        }
                    />
                    {error && (
                        <p role="alert" className="text-[13px] text-destructive">
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            disabled={pending}
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={pending}>
                            {pending
                                ? affiliate
                                    ? 'Saving…'
                                    : 'Adding…'
                                : affiliate
                                  ? 'Save'
                                  : 'Add affiliate'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
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

function Field({
    id,
    label,
    wide,
    children,
}: {
    id: string;
    label: string;
    wide?: boolean;
    children: React.ReactNode;
}) {
    return (
        <div className={cn('flex min-w-0 flex-col gap-1.5', wide && 'sm:col-span-2')}>
            <label htmlFor={id} className="text-[13px] font-semibold">
                {label}
            </label>
            {children}
        </div>
    );
}

const small = 'text-[15px]';

/* Every field of a creator in a compact grid: one row on a wide screen, stacked on a phone. */
function AffiliateFields({
    id,
    form,
    onChange,
    accountPlaceholder = 'Optional',
}: {
    id: string;
    form: AffiliateInput;
    onChange: React.Dispatch<React.SetStateAction<AffiliateInput>>;
    accountPlaceholder?: string;
}) {
    const set = <K extends keyof AffiliateInput>(key: K, value: AffiliateInput[K]) =>
        onChange((current) => ({ ...current, [key]: value }));
    return (
        <div className="grid gap-4 sm:grid-cols-2">
            <Field id={`${id}-name`} label="Name" wide>
                <Input
                    id={`${id}-name`}
                    className={small}
                    value={form.name}
                    onChange={(event) => set('name', event.target.value)}
                    placeholder="Ada on YouTube"
                    required
                    maxLength={100}
                />
            </Field>
            <Field id={`${id}-slug`} label="Page slug">
                <Input
                    id={`${id}-slug`}
                    className={cn(small, 'font-mono')}
                    value={form.slug}
                    onChange={(event) => set('slug', event.target.value)}
                    placeholder="ada"
                    required
                    maxLength={40}
                    pattern="[A-Za-z0-9-]+"
                />
            </Field>
            <Field id={`${id}-code`} label="Code">
                <Input
                    id={`${id}-code`}
                    className={cn(small, 'font-mono uppercase')}
                    value={form.code}
                    onChange={(event) => set('code', event.target.value)}
                    placeholder="ADA20"
                    required
                    minLength={3}
                    maxLength={32}
                    pattern="[A-Za-z0-9]+"
                />
            </Field>
            <Field id={`${id}-percent`} label="Percent off">
                <Input
                    id={`${id}-percent`}
                    className={cn(small, 'tabular-nums')}
                    type="number"
                    min={1}
                    max={100}
                    value={form.percentOff}
                    onChange={(event) => set('percentOff', Number(event.target.value))}
                    required
                />
            </Field>
            <Field id={`${id}-commission`} label="Commission %">
                <Input
                    id={`${id}-commission`}
                    className={cn(small, 'tabular-nums')}
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
            </Field>
            <Field id={`${id}-duration`} label="Discount lasts" wide>
                <div className="flex gap-1">
                    <Select
                        value={form.duration}
                        onValueChange={(value) =>
                            set('duration', value as AffiliateInput['duration'])
                        }
                        items={DURATIONS}
                    >
                        <SelectTrigger
                            id={`${id}-duration`}
                            className={cn(small, 'min-w-0 flex-1')}
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
                            className={cn(small, 'w-20 tabular-nums')}
                            type="number"
                            min={1}
                            max={36}
                            value={form.durationMonths ?? 3}
                            onChange={(event) => set('durationMonths', Number(event.target.value))}
                        />
                    )}
                </div>
            </Field>
            <Field id={`${id}-email`} label="Their account" wide>
                <Input
                    id={`${id}-email`}
                    className={small}
                    type="email"
                    value={form.userEmail ?? ''}
                    onChange={(event) => set('userEmail', event.target.value)}
                    placeholder={accountPlaceholder}
                />
            </Field>
            <Field id={`${id}-notes`} label="Notes" wide>
                <Input
                    id={`${id}-notes`}
                    className={small}
                    value={form.notes ?? ''}
                    onChange={(event) => set('notes', event.target.value)}
                    placeholder="How to pay them, agreed terms"
                    maxLength={2000}
                />
            </Field>
        </div>
    );
}

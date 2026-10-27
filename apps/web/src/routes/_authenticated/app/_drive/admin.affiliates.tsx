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
import {
    Autocomplete,
    AutocompleteContent,
    AutocompleteInput,
    AutocompleteItem,
    AutocompleteList,
} from '@/components/ui/autocomplete';
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
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui/toast';
import { adminAccountsQueryOptions } from '@/lib/admin';
import {
    type AffiliateDraft,
    type DraftField,
    draftFrom,
    editPatch,
    emptyDraft,
    readDraft,
} from '@/lib/affiliate-form';
import { formatWhen } from '@/lib/drive';
import { affiliatesQueryOptions, describeCommission, describeDiscount } from '@/lib/growth';
import { growthApi } from '@/lib/growth-api';
import { useDebouncedValue } from '@/lib/use-debounced-value';
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
    const initial = () => (affiliate ? draftFrom(affiliate) : emptyDraft);
    const [form, setForm] = useState<AffiliateDraft>(initial);
    // A field's error shows once it has been left, or once save was tried.
    const [left, setLeft] = useState<ReadonlySet<DraftField>>(new Set());
    const [tried, setTried] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    // Every opening starts from the creator as saved, or from empty. The page opens the
    // dialog through `open`, which never calls onOpenChange, so the reset is keyed to it.
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
        setWasOpen(open);
        if (open) {
            setForm(initial());
            setLeft(new Set());
            setTried(false);
            setError('');
        }
    }
    const reading = readDraft(form);
    const fieldError = (field: DraftField) =>
        tried || left.has(field) ? reading.errors[field] : undefined;
    const leave = (field: DraftField) => setLeft((current) => new Set(current).add(field));
    async function submit(event: React.FormEvent) {
        event.preventDefault();
        setTried(true);
        if (!reading.ok) return;
        const input = reading.input;
        setPending(true);
        setError('');
        try {
            if (affiliate) {
                await growthApi.updateAffiliate(affiliate.id, editPatch(input));
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
                if (!pending) onOpenChange(next);
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
                        affiliate={affiliate}
                        fieldError={fieldError}
                        onLeave={leave}
                        onSaved={onSaved}
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

/* A label above, the control, and one line below: the error when there is one, else the hint. */
function Field({
    id,
    label,
    wide,
    hint,
    error,
    action,
    children,
}: {
    id: string;
    label: string;
    wide?: boolean;
    hint?: string;
    error?: string;
    /* A quiet control at the end of the label's line. */
    action?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <div className={cn('flex min-w-0 flex-col gap-1.5', wide && 'sm:col-span-2')}>
            <div className="flex items-baseline justify-between gap-3">
                <label htmlFor={id} className="text-[13px] font-semibold">
                    {label}
                </label>
                {action}
            </div>
            {children}
            {error ? (
                <p id={`${id}-note`} role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            ) : hint ? (
                <p id={`${id}-note`} className="text-[13px] text-muted-foreground">
                    {hint}
                </p>
            ) : null}
        </div>
    );
}

/* What a control under Field needs to point at its line, and to show it is wrong. */
const described = (id: string, note: string | undefined) =>
    note ? { 'aria-describedby': `${id}-note`, 'aria-invalid': true as const } : {};

// 16px on phones (iOS zooms a smaller field on focus), 15px from sm.
const small = 'sm:text-[15px]';

/*
 * Whether a slug or code typed here is another affiliate's, asked once the
 * typing pauses. A convenience only: saving checks the same rule on the
 * server, and that answer is the one that counts. An answer for anything but
 * what the field holds now is never shown.
 */
function useHandleTaken(value: string, except: string | undefined) {
    const typed = value.trim();
    const settled = useDebouncedValue(typed, 300);
    const current = settled === typed && typed.length > 0;
    const check = useQuery({
        queryKey: ['growth', 'affiliate-handle', settled.toLowerCase(), except ?? null],
        queryFn: ({ signal }) => growthApi.affiliateHandle(settled, except, signal),
        enabled: current,
        staleTime: 5_000,
        retry: false,
    });
    return current && check.data?.free === false;
}

const TAKEN = 'Taken by another affiliate';

/* An account by name or email, or any email: one with no account yet is linked when that person signs up. */
function AccountField({
    id,
    value,
    onChange,
    onBlur,
    error,
    placeholder,
    action,
}: {
    id: string;
    value: string;
    onChange: (value: string) => void;
    onBlur: () => void;
    error?: string;
    placeholder: string;
    action?: React.ReactNode;
}) {
    const [open, setOpen] = useState(false);
    const typed = value.trim();
    const query = useDebouncedValue(typed, 300);
    const search = useQuery({
        ...adminAccountsQueryOptions({ q: query }),
        enabled: open && query.length >= 2,
    });
    // Only the answer for what the field holds now: a list for an earlier search could be
    // picked with Enter before the new one arrives, and fill in someone else's email.
    const accounts =
        typed.length >= 2 && query === typed && !search.isPlaceholderData
            ? (search.data?.accounts.slice(0, 6) ?? [])
            : [];
    return (
        <Field
            id={id}
            label="Their account"
            wide
            hint="An email with no account yet is linked when that person signs up."
            error={error}
            action={action}
        >
            <Autocomplete
                items={accounts}
                filter={null}
                value={value}
                onValueChange={(next) => onChange(next)}
                itemToStringValue={(account) => account.email}
                open={open && accounts.length > 0}
                onOpenChange={setOpen}
            >
                <AutocompleteInput
                    id={id}
                    className={small}
                    // Text, not email: the list's Home and End keys set the caret, which an
                    // email input refuses with an error.
                    type="text"
                    inputMode="email"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={placeholder}
                    onFocus={() => setOpen(true)}
                    // Closed with the field: a search still on its way must not open the list
                    // over whatever has focus now.
                    onBlur={() => {
                        setOpen(false);
                        onBlur();
                    }}
                    // The line below is always there: the hint, or the error in its place.
                    aria-describedby={`${id}-note`}
                    aria-invalid={error ? true : undefined}
                />
                <AutocompleteContent aria-busy={search.isFetching || undefined}>
                    <AutocompleteList>
                        {(account: (typeof accounts)[number]) => (
                            <AutocompleteItem key={account.id} value={account}>
                                <span className="flex min-w-0 flex-col">
                                    <span className="truncate font-semibold">{account.name}</span>
                                    <span className="truncate text-[13px] text-muted-foreground">
                                        {account.email}
                                    </span>
                                </span>
                            </AutocompleteItem>
                        )}
                    </AutocompleteList>
                </AutocompleteContent>
            </Autocomplete>
        </Field>
    );
}

/*
 * Takes the creator's account away, at once and apart from Save: "Unlink" for
 * a linked account, after asking, since its email may not be at hand to link
 * it again; "Cancel" for an email still waiting for its account, which is shown.
 */
function AccountUnlink({
    affiliate,
    onSaved,
}: {
    affiliate: AffiliateView;
    onSaved: () => Promise<unknown>;
}) {
    const [asking, setAsking] = useState(false);
    const [busy, setBusy] = useState(false);
    const linked = Boolean(affiliate.userId);
    async function unlink() {
        setBusy(true);
        try {
            await growthApi.updateAffiliate(affiliate.id, { userEmail: null });
            await onSaved();
            toast.add({
                type: 'success',
                title: linked ? 'Account unlinked' : 'No longer waiting for that email',
            });
        } catch (error) {
            toast.add({ type: 'error', title: 'That didn’t work', description: message(error) });
        } finally {
            setBusy(false);
            setAsking(false);
        }
    }
    return (
        <>
            <Button
                type="button"
                variant="link"
                className="text-[13px] text-muted-foreground hover:text-foreground pointer-coarse:-my-3 pointer-coarse:py-3"
                disabled={busy}
                aria-label={
                    linked ? 'Unlink their account' : `Cancel linking ${affiliate.pendingEmail}`
                }
                onClick={() => (linked ? setAsking(true) : void unlink())}
            >
                {linked ? 'Unlink' : 'Cancel'}
            </Button>
            <AlertDialog open={asking} onOpenChange={(next) => !busy && setAsking(next)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Unlink their account?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {affiliate.name} stops seeing their code and earnings in their Drive.
                            You can link an account again by its email.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={busy}
                            onClick={() => void unlink()}
                        >
                            {busy ? 'Unlinking…' : 'Unlink'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

/* Every field of a creator in a compact grid: one row on a wide screen, stacked on a phone. */
function AffiliateFields({
    id,
    form,
    onChange,
    affiliate,
    fieldError,
    onLeave,
    onSaved,
}: {
    id: string;
    form: AffiliateDraft;
    onChange: React.Dispatch<React.SetStateAction<AffiliateDraft>>;
    affiliate?: AffiliateView;
    fieldError: (field: DraftField) => string | undefined;
    onLeave: (field: DraftField) => void;
    onSaved: () => Promise<unknown>;
}) {
    const set = <K extends keyof AffiliateDraft>(key: K, value: AffiliateDraft[K]) =>
        onChange((current) => ({ ...current, [key]: value }));
    const slugTaken = useHandleTaken(form.slug, affiliate?.id);
    const codeTaken = useHandleTaken(form.code, affiliate?.id);
    const percentError = fieldError('percentOff');
    const commissionError = fieldError('commission');
    const monthsError = fieldError('durationMonths');
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
            <Field id={`${id}-slug`} label="Page slug" error={slugTaken ? TAKEN : undefined}>
                <Input
                    id={`${id}-slug`}
                    className={cn(small, 'font-mono')}
                    value={form.slug}
                    onChange={(event) => set('slug', event.target.value)}
                    placeholder="ada"
                    required
                    maxLength={40}
                    autoCapitalize="none"
                    spellCheck={false}
                    pattern="[A-Za-z0-9-]+"
                    {...described(`${id}-slug`, slugTaken ? TAKEN : undefined)}
                />
            </Field>
            <Field id={`${id}-code`} label="Code" error={codeTaken ? TAKEN : undefined}>
                <Input
                    id={`${id}-code`}
                    className={cn(small, 'font-mono uppercase')}
                    value={form.code}
                    onChange={(event) => set('code', event.target.value)}
                    placeholder="ADA20"
                    required
                    minLength={3}
                    maxLength={32}
                    autoCapitalize="characters"
                    spellCheck={false}
                    pattern="[A-Za-z0-9]+"
                    {...described(`${id}-code`, codeTaken ? TAKEN : undefined)}
                />
            </Field>
            <Field id={`${id}-percent`} label="Percent off" error={percentError}>
                <Input
                    id={`${id}-percent`}
                    className={cn(small, 'tabular-nums')}
                    inputMode="numeric"
                    autoComplete="off"
                    value={form.percentOff}
                    onChange={(event) => set('percentOff', event.target.value)}
                    onBlur={() => onLeave('percentOff')}
                    required
                    {...described(`${id}-percent`, percentError)}
                />
            </Field>
            <Field id={`${id}-commission`} label="Commission %" error={commissionError}>
                <Input
                    id={`${id}-commission`}
                    className={cn(small, 'tabular-nums')}
                    inputMode="decimal"
                    autoComplete="off"
                    value={form.commission}
                    onChange={(event) => set('commission', event.target.value)}
                    onBlur={() => onLeave('commission')}
                    required
                    {...described(`${id}-commission`, commissionError)}
                />
            </Field>
            <Field id={`${id}-duration`} label="Discount lasts" wide error={monthsError}>
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
                            inputMode="numeric"
                            autoComplete="off"
                            value={form.durationMonths}
                            onChange={(event) => set('durationMonths', event.target.value)}
                            onBlur={() => onLeave('durationMonths')}
                            {...described(`${id}-duration`, monthsError)}
                        />
                    )}
                </div>
            </Field>
            <AccountField
                id={`${id}-email`}
                value={form.userEmail}
                onChange={(value) => set('userEmail', value)}
                onBlur={() => onLeave('userEmail')}
                error={fieldError('userEmail')}
                placeholder={
                    affiliate?.pendingEmail
                        ? `Waiting for ${affiliate.pendingEmail} to sign up`
                        : affiliate?.userId
                          ? 'Linked. Another email changes it.'
                          : 'Optional: name or email'
                }
                action={
                    affiliate && (affiliate.userId || affiliate.pendingEmail) ? (
                        <AccountUnlink affiliate={affiliate} onSaved={onSaved} />
                    ) : undefined
                }
            />
            <Field id={`${id}-notes`} label="Notes" wide>
                <Textarea
                    id={`${id}-notes`}
                    className={cn(small, 'min-h-0 resize-y')}
                    rows={3}
                    value={form.notes}
                    onChange={(event) => set('notes', event.target.value)}
                    placeholder="How to pay them, agreed terms"
                    maxLength={2000}
                />
            </Field>
        </div>
    );
}

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { cn } from 'cn';
import { Fragment, useId, useState, type ReactNode } from 'react';
import { CopyValue } from '@/components/copy-value';
import { PendingLabel, Spinner } from '@/components/motion';
import { OperatorPage, OperatorTable, td, th } from '@/components/operator';
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
import {
    adminAccountQueryOptions,
    grantAccountStorage,
    revokeAccountStorage,
    setAccountSuspended,
} from '@/lib/admin';
import { formatBytes, formatDay, formatWhen } from '@/lib/drive';
import { formatQuota } from '@/lib/queries';

/*
 * One account, as an operator needs it to answer a question or act on a
 * report: who it is, when it was last used, how its space is made up, and
 * how many reports name it. What they keep is not shown, not even file names.
 */

export const Route = createFileRoute('/_authenticated/app/admin/accounts/$accountId')({
    beforeLoad: ({ context }) => {
        if (context.user.role !== 'admin') throw redirect({ to: '/app/drive' });
    },
    head: () => ({ meta: [{ title: 'Account · HushOS' }] }),
    component: AccountPage,
});

/* What a grant of extra space came from, in an operator's words. */
function sourceLabel(source: string) {
    if (source === 'referral') return 'Invite bonus';
    if (source === 'polar') return 'Plan';
    if (source === 'admin') return 'Operator';
    return source;
}

function grantState(grant: {
    startsAt: string;
    expiresAt: string | null;
    revokedAt: string | null;
}) {
    const now = Date.now();
    if (grant.revokedAt) return { label: 'Revoked', on: false };
    if (Date.parse(grant.startsAt) > now) return { label: 'Not started', on: false };
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= now) return { label: 'Ended', on: false };
    return { label: 'In force', on: true };
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
    return (
        <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 rounded-xl border border-rule px-3 py-1">
            {rows.map(([label, value]) => (
                <div key={label} className="contents">
                    <dt className="border-b border-rule py-2 text-[13px] text-muted-foreground last-of-type:border-0">
                        {label}
                    </dt>
                    <dd className="min-w-0 border-b border-rule py-2 font-mono text-[13px] wrap-anywhere">
                        {value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}

/*
 * Asks once before suspending or reinstating. Suspending signs the person out
 * everywhere and refuses sign-in; their files stay as they are, and anything
 * they shared stays shared.
 */
function SuspendDialog({
    account,
    open,
    onOpenChange,
}: {
    account: { id: string; email: string; suspendedAt: string | null };
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const suspending = !account.suspendedAt;
    async function confirm() {
        setPending(true);
        setError(null);
        try {
            await setAccountSuspended(account.id, suspending);
            await queryClient.invalidateQueries({ queryKey: ['admin'] });
            toast.add({
                type: 'success',
                title: suspending ? 'Account suspended' : 'Account reinstated',
            });
            onOpenChange(false);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'That didn’t work. Try again.');
        } finally {
            setPending(false);
        }
    }
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (pending) return;
                setError(null);
                onOpenChange(next);
            }}
        >
            <DialogContent className="sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle>
                        {suspending ? 'Suspend this account?' : 'Reinstate this account?'}
                    </DialogTitle>
                    <DialogDescription>
                        {suspending ? (
                            <>
                                <span className="font-semibold text-foreground">
                                    {account.email}
                                </span>{' '}
                                is signed out everywhere and can’t sign in again until you reinstate
                                them. Their files and what they shared stay as they are.
                            </>
                        ) : (
                            <>
                                <span className="font-semibold text-foreground">
                                    {account.email}
                                </span>{' '}
                                can sign in again. They’ll need their password; nothing else
                                changes.
                            </>
                        )}
                    </DialogDescription>
                </DialogHeader>
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button
                        variant={suspending ? 'destructive' : 'default'}
                        disabled={pending}
                        onClick={() => void confirm()}
                    >
                        <PendingLabel
                            pending={pending}
                            idle={suspending ? 'Suspend' : 'Reinstate'}
                            busy={suspending ? 'Suspending…' : 'Reinstating…'}
                        />
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/* Space is counted in 1024s and labelled GB and TB, as everywhere else in the app. */
const GB = 1024n ** 3n;
const TB = 1024n * GB;
const MAX_GRANT = 100n * TB;
const AMOUNTS = [
    { value: '10', label: '10 GB', bytes: 10n * GB },
    { value: '100', label: '100 GB', bytes: 100n * GB },
    { value: '1024', label: '1 TB', bytes: TB },
    { value: 'custom', label: 'Custom', bytes: null },
] as const;
const ENDS = [
    { value: '', label: 'Never' },
    { value: '30', label: '30 days' },
    { value: '365', label: 'A year' },
    { value: 'date', label: 'On a date' },
] as const;

/* A typed amount in bytes: whole or up to three decimals, or null when it is not one. */
function customBytes(amount: string, unit: 'GB' | 'TB') {
    const text = amount.trim();
    if (!/^[0-9]{1,6}(\.[0-9]{1,3})?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    const thousandths = BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, '0'));
    return (thousandths * (unit === 'TB' ? TB : GB)) / 1000n;
}

/* A day as the date field writes it, where the operator is. */
function localDay(date: Date) {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/* The end of the chosen day, where the operator is, so "until the 3rd" includes the 3rd. */
function endOfDay(date: string) {
    const [year, month, day] = date.split('-').map(Number);
    return new Date(year!, month! - 1, day!, 23, 59, 59);
}

/* When the grant ends, from the choice made: none, days from now, or the end of a chosen day. */
function endsAt(ends: (typeof ENDS)[number]['value'], date: string) {
    if (ends === '') return null;
    if (ends === 'date') return endOfDay(date);
    return new Date(Date.now() + Number(ends) * 24 * 3600 * 1000);
}

/*
 * Adds space to the account at once, for good or until a date. Shown as one
 * more row under Space, with who added it; only these rows can be revoked here.
 */
function AddStorageDialog({
    account,
    open,
    onOpenChange,
}: {
    account: { id: string; email: string; quotaBytes: string | null };
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const id = useId();
    const [amount, setAmount] = useState<(typeof AMOUNTS)[number]['value']>('100');
    const [custom, setCustom] = useState('');
    const [unit, setUnit] = useState<'GB' | 'TB'>('GB');
    const [ends, setEnds] = useState<(typeof ENDS)[number]['value']>('');
    const [date, setDate] = useState('');
    const [note, setNote] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const bytes =
        amount === 'custom'
            ? customBytes(custom, unit)
            : AMOUNTS.find((option) => option.value === amount)!.bytes;
    // Today where the operator is, for the date field; the server checks the date again.
    const [today] = useState(() => localDay(new Date()));
    const amountProblem =
        amount === 'custom' && custom.trim() && (bytes === null || bytes <= 0n)
            ? 'Enter a number of GB or TB.'
            : bytes !== null && bytes > MAX_GRANT
              ? 'Add up to 100 TB at a time.'
              : null;
    const dateProblem = ends === 'date' && date && date <= today ? 'Pick a day after today.' : null;
    const ready =
        bytes !== null &&
        bytes > 0n &&
        !amountProblem &&
        (ends !== 'date' || Boolean(date)) &&
        !dateProblem;
    const current = account.quotaBytes ? BigInt(account.quotaBytes) : 0n;

    function reset() {
        setAmount('100');
        setCustom('');
        setUnit('GB');
        setEnds('');
        setDate('');
        setNote('');
        setError(null);
    }

    async function confirm() {
        if (!ready || bytes === null) return;
        setPending(true);
        setError(null);
        try {
            const expiresAt = endsAt(ends, date);
            const result = await grantAccountStorage(account.id, {
                quotaBytes: bytes.toString(),
                expiresAt: expiresAt ? expiresAt.toISOString() : null,
                note: note.trim() || null,
            });
            await queryClient.invalidateQueries({ queryKey: ['admin'] });
            toast.add({
                type: 'success',
                title: 'Storage added',
                description: `The allowance is now ${formatQuota(result.quotaBytes)}.`,
            });
            reset();
            onOpenChange(false);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'That didn’t work. Try again.');
        } finally {
            setPending(false);
        }
    }

    const segment = (selected: boolean) =>
        cn(
            'flex h-9 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-sm px-2 text-sm whitespace-nowrap outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring pointer-coarse:h-11',
            selected
                ? 'bg-accent font-semibold text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground',
        );

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (pending) return;
                if (!next) reset();
                onOpenChange(next);
            }}
        >
            <DialogContent className="sm:max-w-[480px]">
                <form
                    noValidate
                    className="contents"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void confirm();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Add storage</DialogTitle>
                        <DialogDescription>
                            For{' '}
                            <span className="font-semibold text-foreground">{account.email}</span>.
                            It counts at once, on top of their plan and bonuses.
                        </DialogDescription>
                    </DialogHeader>
                    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
                        <legend className="mb-1.5 text-[13px] font-semibold">Amount</legend>
                        <div className="flex rounded-md border border-input bg-card p-0.5">
                            {AMOUNTS.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    aria-pressed={amount === option.value}
                                    onClick={() => setAmount(option.value)}
                                    className={segment(amount === option.value)}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                        {amount === 'custom' && (
                            <div className="flex gap-2 pt-1">
                                <Input
                                    id={`${id}-custom`}
                                    aria-label="Amount"
                                    inputMode="decimal"
                                    autoComplete="off"
                                    placeholder="250"
                                    value={custom}
                                    onChange={(event) => setCustom(event.target.value)}
                                    className="min-w-0 flex-1 font-mono tabular-nums"
                                />
                                <fieldset className="m-0 flex w-28 shrink-0 rounded-md border border-input bg-card p-0.5">
                                    <legend className="sr-only">Unit</legend>
                                    {(['GB', 'TB'] as const).map((value) => (
                                        <button
                                            key={value}
                                            type="button"
                                            aria-pressed={unit === value}
                                            onClick={() => setUnit(value)}
                                            className={segment(unit === value)}
                                        >
                                            {value}
                                        </button>
                                    ))}
                                </fieldset>
                            </div>
                        )}
                        {amountProblem && (
                            <p className="text-[13px] text-destructive">{amountProblem}</p>
                        )}
                    </fieldset>
                    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
                        <legend className="mb-1.5 text-[13px] font-semibold">Ends</legend>
                        <div className="flex rounded-md border border-input bg-card p-0.5">
                            {ENDS.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    aria-pressed={ends === option.value}
                                    onClick={() => setEnds(option.value)}
                                    className={segment(ends === option.value)}
                                >
                                    {option.label}
                                </button>
                            ))}
                        </div>
                        {ends === 'date' && (
                            <Input
                                type="date"
                                aria-label="End date"
                                min={today}
                                value={date}
                                onChange={(event) => setDate(event.target.value)}
                                className="mt-1"
                            />
                        )}
                        {dateProblem && (
                            <p className="text-[13px] text-destructive">{dateProblem}</p>
                        )}
                    </fieldset>
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor={`${id}-note`} className="text-[13px] font-semibold">
                            Note
                        </label>
                        <Input
                            id={`${id}-note`}
                            value={note}
                            maxLength={500}
                            placeholder="Optional. Why, for the next operator"
                            onChange={(event) => setNote(event.target.value)}
                        />
                    </div>
                    {ready && bytes !== null && (
                        <p className="font-mono text-[13px] text-muted-foreground tabular-nums">
                            {account.quotaBytes ? formatQuota(account.quotaBytes) : '0 GB'} +{' '}
                            {formatQuota(bytes.toString())} ={' '}
                            <span className="font-semibold text-foreground">
                                {formatQuota((current + bytes).toString())}
                            </span>
                            {ends === 'date'
                                ? ` until ${formatDay(endOfDay(date).toISOString())}`
                                : ends
                                  ? ` for ${ENDS.find((option) => option.value === ends)!.label.toLowerCase()}`
                                  : ''}
                        </p>
                    )}
                    {error && (
                        <p role="alert" className="text-sm text-destructive">
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
                        <Button type="submit" disabled={pending || !ready}>
                            <PendingLabel pending={pending} idle="Add storage" busy="Adding…" />
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/*
 * Ends space an operator added. Files already stored stay; while they take
 * more than the allowance, uploads are refused until there is room.
 */
function RevokeStorageDialog({
    account,
    grant,
    onOpenChange,
}: {
    account: { id: string; quotaBytes: string | null };
    grant: { id: string; quotaBytes: string; counted: boolean } | null;
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const after =
        grant && account.quotaBytes
            ? BigInt(account.quotaBytes) - (grant.counted ? BigInt(grant.quotaBytes) : 0n)
            : null;
    async function confirm() {
        if (!grant) return;
        setPending(true);
        setError(null);
        try {
            const result = await revokeAccountStorage(account.id, grant.id);
            await queryClient.invalidateQueries({ queryKey: ['admin'] });
            toast.add({
                type: 'success',
                title: 'Storage revoked',
                description: `The allowance is now ${formatQuota(result.quotaBytes)}.`,
            });
            onOpenChange(false);
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : 'That didn’t work. Try again.');
        } finally {
            setPending(false);
        }
    }
    return (
        <Dialog
            open={grant !== null}
            onOpenChange={(next) => {
                if (pending) return;
                setError(null);
                onOpenChange(next);
            }}
        >
            <DialogContent className="sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle>
                        Revoke {grant ? formatQuota(grant.quotaBytes) : 'this storage'}?
                    </DialogTitle>
                    <DialogDescription>
                        {after !== null && (
                            <>
                                The allowance becomes{' '}
                                <span className="font-semibold text-foreground">
                                    {formatQuota(after.toString())}
                                </span>{' '}
                                now.{' '}
                            </>
                        )}
                        Files already stored stay. While they take more than the allowance, uploads
                        are refused.
                    </DialogDescription>
                </DialogHeader>
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                <DialogFooter>
                    <Button
                        variant="outline"
                        disabled={pending}
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button variant="destructive" disabled={pending} onClick={() => void confirm()}>
                        <PendingLabel pending={pending} idle="Revoke" busy="Revoking…" />
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

function AccountPage() {
    const { accountId } = Route.useParams();
    const { user } = Route.useRouteContext();
    const [suspendOpen, setSuspendOpen] = useState(false);
    const [addOpen, setAddOpen] = useState(false);
    const [revoking, setRevoking] = useState<{
        id: string;
        quotaBytes: string;
        counted: boolean;
    } | null>(null);
    const account = useQuery(adminAccountQueryOptions(accountId));
    if (account.isPending)
        return (
            <OperatorPage title="Account">
                <div className="flex justify-center py-16 text-muted-foreground">
                    <Spinner />
                </div>
            </OperatorPage>
        );
    if (account.isError || !account.data)
        return (
            <OperatorPage title="Account">
                <p
                    role="alert"
                    className="rounded-md bg-destructive-soft px-4 py-3 text-sm text-destructive"
                >
                    {account.error instanceof Error
                        ? account.error.message
                        : 'This account didn’t load.'}
                </p>
            </OperatorPage>
        );
    const data = account.data;
    const used = Number(data.usedBytes ?? 0);
    const quota = Number(data.quotaBytes ?? 0);
    return (
        <OperatorPage
            title={data.name}
            description={
                <>
                    {data.email} ·{' '}
                    {data.suspendedAt ? (
                        <span className="font-semibold text-destructive">
                            suspended {formatWhen(data.suspendedAt, { lower: true })}
                        </span>
                    ) : (
                        'active'
                    )}
                </>
            }
            actions={
                <>
                    <Link
                        to="/app/admin/accounts"
                        className="text-[13px] font-semibold text-primary underline underline-offset-2"
                    >
                        All accounts
                    </Link>
                    {/* Admins lose the role from the command line before they can be suspended. */}
                    {data.id !== user.id && (data.role !== 'admin' || data.suspendedAt) && (
                        <Button
                            variant="outline"
                            size="sm"
                            className={cn(!data.suspendedAt && 'text-destructive')}
                            onClick={() => setSuspendOpen(true)}
                        >
                            {data.suspendedAt ? 'Reinstate' : 'Suspend account'}
                        </Button>
                    )}
                    <SuspendDialog
                        account={data}
                        open={suspendOpen}
                        onOpenChange={setSuspendOpen}
                    />
                </>
            }
        >
            <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <section aria-labelledby="who" className="flex flex-col gap-2">
                    <h2 id="who" className="text-[15px] font-bold">
                        Account
                    </h2>
                    <Facts
                        rows={[
                            [
                                'Account ID',
                                <CopyValue key="id" value={data.id} label="Account ID" />,
                            ],
                            [
                                'Workspace',
                                data.workspaceId ? (
                                    <CopyValue
                                        key="ws"
                                        value={data.workspaceId}
                                        label="Workspace ID"
                                    />
                                ) : (
                                    '–'
                                ),
                            ],
                            ['Role', data.role === 'admin' ? 'Admin' : 'Member'],
                            ['Joined', formatWhen(data.createdAt)],
                            [
                                'Email confirmed',
                                data.emailVerifiedAt ? formatWhen(data.emailVerifiedAt) : '–',
                            ],
                            ['Last seen', data.lastSeenAt ? formatWhen(data.lastSeenAt) : '–'],
                            [
                                'Signed in on',
                                `${data.activeSessions} ${data.activeSessions === 1 ? 'browser' : 'browsers'}`,
                            ],
                            [
                                'Reports',
                                data.reports.total === 0
                                    ? 'None name this account'
                                    : `${data.reports.total} name this account, ${data.reports.open} open`,
                            ],
                        ]}
                    />
                </section>
                <section aria-labelledby="space" className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-3">
                        <h2 id="space" className="text-[15px] font-bold">
                            Space
                        </h2>
                        {data.workspaceId && (
                            <Button variant="outline" onClick={() => setAddOpen(true)}>
                                Add storage
                            </Button>
                        )}
                    </div>
                    <AddStorageDialog account={data} open={addOpen} onOpenChange={setAddOpen} />
                    <RevokeStorageDialog
                        account={data}
                        grant={revoking}
                        onOpenChange={(next) => {
                            if (!next) setRevoking(null);
                        }}
                    />
                    <div className="flex flex-col gap-2 rounded-xl border border-rule p-3">
                        <p className="font-mono text-[13px] tabular-nums">
                            <span className="text-xl font-semibold">{formatBytes(used)}</span>
                            {data.quotaBytes && (
                                <span className="text-muted-foreground">
                                    {' '}
                                    of {formatQuota(data.quotaBytes)}
                                </span>
                            )}
                        </p>
                        {quota > 0 && (
                            <span
                                aria-hidden="true"
                                className="flex h-1.5 overflow-hidden rounded-full bg-rule"
                            >
                                <span
                                    className={cn(
                                        'rounded-full',
                                        used / quota >= 0.95 ? 'bg-destructive' : 'bg-primary',
                                    )}
                                    style={{ width: `${Math.min(100, (used / quota) * 100)}%` }}
                                />
                            </span>
                        )}
                        <p className="font-mono text-xs text-muted-foreground tabular-nums">
                            {formatBytes(data.reservedBytes ?? 0)} held for uploads in progress ·{' '}
                            {data.objects.ready.toLocaleString()} objects
                            {data.objects.missing > 0 && (
                                <span className="font-semibold text-destructive">
                                    {' '}
                                    · {data.objects.missing} missing
                                </span>
                            )}
                        </p>
                    </div>
                    <OperatorTable>
                        <thead>
                            <tr>
                                <th className={th}>Space from</th>
                                <th className={cn(th, 'text-right')}>Amount</th>
                                <th className={th}>From</th>
                                <th className={th}>Until</th>
                                <th className={th}>State</th>
                                <th className={th}>
                                    <span className="sr-only">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td className={cn(td, 'whitespace-nowrap')}>Base allowance</td>
                                <td className={cn(td, 'text-right font-mono tabular-nums')}>
                                    {data.baseQuotaBytes ? formatQuota(data.baseQuotaBytes) : '–'}
                                </td>
                                <td className={cn(td, 'whitespace-nowrap')}>
                                    {formatWhen(data.createdAt)}
                                </td>
                                <td className={td}>–</td>
                                <td className={cn(td, 'whitespace-nowrap')}>In force</td>
                                <td className={td}>
                                    <span className="sr-only">None</span>
                                </td>
                            </tr>
                            {data.grants.map((grant) => {
                                const state = grantState(grant);
                                // Who added it and why, on a line of its own under the row.
                                const detail =
                                    grant.source === 'admin'
                                        ? [
                                              grant.grantedByEmail &&
                                                  `Added by ${grant.grantedByEmail}`,
                                              grant.note,
                                          ]
                                              .filter(Boolean)
                                              .join(' · ')
                                        : '';
                                const cell = cn(td, detail && 'border-b-0');
                                return (
                                    <Fragment key={grant.id}>
                                        <tr className={cn(!state.on && 'text-muted-foreground')}>
                                            <td className={cn(cell, 'whitespace-nowrap')}>
                                                {sourceLabel(grant.source)}
                                            </td>
                                            <td
                                                className={cn(
                                                    cell,
                                                    'text-right font-mono tabular-nums',
                                                )}
                                            >
                                                {formatQuota(grant.quotaBytes)}
                                            </td>
                                            <td className={cn(cell, 'whitespace-nowrap')}>
                                                {formatWhen(grant.startsAt)}
                                            </td>
                                            <td className={cn(cell, 'whitespace-nowrap')}>
                                                {grant.expiresAt
                                                    ? formatWhen(grant.expiresAt)
                                                    : '–'}
                                            </td>
                                            <td className={cn(cell, 'whitespace-nowrap')}>
                                                {state.label}
                                            </td>
                                            <td className={cn(cell, 'py-0 text-right')}>
                                                {grant.source === 'admin' && !grant.revokedAt && (
                                                    <Button
                                                        variant="ghost"
                                                        className="text-destructive"
                                                        onClick={() =>
                                                            setRevoking({
                                                                id: grant.id,
                                                                quotaBytes: grant.quotaBytes,
                                                                counted: state.on,
                                                            })
                                                        }
                                                    >
                                                        Revoke
                                                    </Button>
                                                )}
                                            </td>
                                        </tr>
                                        {detail && (
                                            <tr>
                                                <td
                                                    colSpan={6}
                                                    className="border-b border-rule px-2 pb-2 text-xs text-muted-foreground wrap-anywhere"
                                                >
                                                    {detail}
                                                </td>
                                            </tr>
                                        )}
                                    </Fragment>
                                );
                            })}
                        </tbody>
                    </OperatorTable>
                </section>
            </div>
        </OperatorPage>
    );
}

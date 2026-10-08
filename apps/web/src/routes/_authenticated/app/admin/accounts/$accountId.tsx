import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { cn } from 'cn';
import { useState, type ReactNode } from 'react';
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
import { toast } from '@/components/ui/toast';
import { adminAccountQueryOptions, setAccountSuspended } from '@/lib/admin';
import { formatBytes, formatWhen } from '@/lib/drive';
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

function AccountPage() {
    const { accountId } = Route.useParams();
    const { user } = Route.useRouteContext();
    const [suspendOpen, setSuspendOpen] = useState(false);
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
                    <h2 id="space" className="text-[15px] font-bold">
                        Space
                    </h2>
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
                            </tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td className={td}>Base allowance</td>
                                <td className={cn(td, 'text-right font-mono tabular-nums')}>
                                    {data.baseQuotaBytes ? formatQuota(data.baseQuotaBytes) : '–'}
                                </td>
                                <td className={td}>{formatWhen(data.createdAt)}</td>
                                <td className={td}>–</td>
                                <td className={td}>In force</td>
                            </tr>
                            {data.grants.map((grant, index) => {
                                const state = grantState(grant);
                                return (
                                    <tr
                                        key={index}
                                        className={cn(!state.on && 'text-muted-foreground')}
                                    >
                                        <td className={td}>{sourceLabel(grant.source)}</td>
                                        <td className={cn(td, 'text-right font-mono tabular-nums')}>
                                            {formatQuota(grant.quotaBytes)}
                                        </td>
                                        <td className={cn(td, 'whitespace-nowrap')}>
                                            {formatWhen(grant.startsAt)}
                                        </td>
                                        <td className={cn(td, 'whitespace-nowrap')}>
                                            {grant.expiresAt ? formatWhen(grant.expiresAt) : '–'}
                                        </td>
                                        <td className={td}>{state.label}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </OperatorTable>
                </section>
            </div>
        </OperatorPage>
    );
}

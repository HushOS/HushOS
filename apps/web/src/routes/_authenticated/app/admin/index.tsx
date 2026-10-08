import { cn } from 'cn';
import { ArrowRightIcon } from 'lucide-react';
import { Spinner } from '@/components/motion';
import { OperatorPage, OperatorTable, td, th } from '@/components/operator';
import { buttonVariants } from '@/components/ui/button';
import { adminOverviewQueryOptions } from '@/lib/admin';
import { formatBytes, formatWhen } from '@/lib/drive';
import { useBillingEnabled } from '@/lib/queries';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';

/*
 * The management area's first page: what the instance holds and what the
 * store audit found. Each count with a list behind it opens that list; no
 * page here shows a file's name or content. A member who types the address
 * is sent to Drive; the API answers a member with 404 regardless.
 */
export const Route = createFileRoute('/_authenticated/app/admin/')({
    beforeLoad: ({ context }) => {
        if (context.user.role !== 'admin') throw redirect({ to: '/app/drive' });
    },
    head: () => ({ meta: [{ title: 'Management · HushOS' }] }),
    component: AdminPage,
});

type Stat = {
    label: string;
    value: string;
    tone?: 'danger';
    /* Where the count opens: the list behind it, or the table below. */
    to?: {
        to: '/app/admin/accounts' | '/app/admin/workspaces' | '/app/admin/reports';
        search?: Record<string, string>;
    };
    anchor?: string;
};

function StatGrid({ stats }: { stats: Stat[] }) {
    return (
        <dl className="grid shrink-0 grid-cols-2 overflow-hidden rounded-xl border border-rule sm:grid-cols-3 lg:grid-cols-5">
            {stats.map((stat) => {
                const body = (
                    <>
                        <dt className="text-xs text-muted-foreground">{stat.label}</dt>
                        <dd
                            className={cn(
                                'font-mono text-xl font-semibold tabular-nums',
                                stat.tone === 'danger' && 'text-destructive',
                            )}
                        >
                            {stat.value}
                        </dd>
                    </>
                );
                const box =
                    '-mt-px -ml-px flex flex-col gap-1 border-t border-l border-rule px-3 py-2.5';
                if (stat.to)
                    return (
                        <Link
                            key={stat.label}
                            to={stat.to.to}
                            search={stat.to.search}
                            className={cn(box, 'group hover:bg-muted')}
                        >
                            {body}
                            <span className="sr-only">, open the list</span>
                        </Link>
                    );
                if (stat.anchor)
                    return (
                        <a
                            key={stat.label}
                            href={stat.anchor}
                            className={cn(box, 'hover:bg-muted')}
                        >
                            {body}
                        </a>
                    );
                return (
                    <div key={stat.label} className={box}>
                        {body}
                    </div>
                );
            })}
        </dl>
    );
}

const count = (value: number) => value.toLocaleString();

function AdminPage() {
    const overview = useQuery(adminOverviewQueryOptions);
    const billing = useBillingEnabled();
    const data = overview.data;
    return (
        <OperatorPage
            title="Management"
            description="Counts for this instance, refreshed when you open the page. Choose a count to see what is behind it."
            actions={
                <>
                    <Link
                        to="/app/admin/reports"
                        className={buttonVariants({ variant: 'outline', size: 'sm' })}
                    >
                        Reports
                        <ArrowRightIcon />
                    </Link>
                    {billing && (
                        <Link
                            to="/app/admin/affiliates"
                            className={buttonVariants({ variant: 'outline', size: 'sm' })}
                        >
                            Affiliates
                            <ArrowRightIcon />
                        </Link>
                    )}
                </>
            }
        >
            {overview.isPending && (
                <div className="flex flex-1 items-center justify-center py-24 text-muted-foreground">
                    <Spinner />
                </div>
            )}
            {overview.isError && (
                <p
                    role="alert"
                    className="rounded-md bg-destructive-soft px-4 py-3 text-sm text-destructive"
                >
                    The counts didn’t load.{' '}
                    {overview.error instanceof Error ? overview.error.message : 'Try again.'}
                </p>
            )}
            {data && (
                <>
                    <StatGrid
                        stats={[
                            {
                                label: 'Accounts',
                                value: count(data.people.total),
                                to: { to: '/app/admin/accounts' },
                            },
                            {
                                label: 'Admins',
                                value: count(data.people.admins),
                                to: { to: '/app/admin/accounts', search: { role: 'admin' } },
                            },
                            {
                                label: 'Workspaces',
                                value: count(data.workspaces.total),
                                to: { to: '/app/admin/workspaces', search: { sort: 'created' } },
                            },
                            {
                                label: 'Stored',
                                value: formatBytes(data.workspaces.usedBytes),
                                to: { to: '/app/admin/workspaces' },
                            },
                            { label: 'Objects ready', value: count(data.objects.ready) },
                            {
                                label: 'Objects missing',
                                value: count(data.objects.missing),
                                tone: data.objects.missing > 0 ? 'danger' : undefined,
                                anchor: '#missing-objects',
                            },
                            { label: 'Awaiting replica', value: count(data.objects.unreplicated) },
                            { label: 'Deletions queued', value: count(data.outbox.pending) },
                            {
                                label: 'Open reports',
                                value: count(data.reports.open),
                                tone: data.reports.open > 0 ? 'danger' : undefined,
                                to: { to: '/app/admin/reports' },
                            },
                            {
                                label: 'On hold',
                                value: count(data.reports.held),
                                to: { to: '/app/admin/reports', search: { status: 'held' } },
                            },
                        ]}
                    />
                    <p className="pt-3 font-mono text-xs text-muted-foreground tabular-nums">
                        Last store audit{' '}
                        {data.objects.lastAuditedAt
                            ? formatWhen(data.objects.lastAuditedAt)
                            : 'has not run yet'}
                        . {count(data.objects.cold)} objects in the cold class,{' '}
                        {count(data.objects.pending)} still uploading.
                    </p>
                    <h2
                        id="missing-objects"
                        className="scroll-mt-20 pt-6 pb-2 text-[15px] font-bold"
                    >
                        Missing objects
                    </h2>
                    {data.missing.length === 0 ? (
                        <p className="rounded-md bg-success-soft px-4 py-3 text-sm text-success">
                            None. Every audited object was found at the store with its recorded
                            size.
                        </p>
                    ) : (
                        <OperatorTable>
                            <thead>
                                <tr>
                                    <th className={th}>Object</th>
                                    <th className={th}>Workspace</th>
                                    <th className={cn(th, 'text-right')}>Size</th>
                                    <th className={th}>Replica</th>
                                    <th className={th}>Audited</th>
                                </tr>
                            </thead>
                            <tbody className="font-mono">
                                {data.missing.map((row) => (
                                    <tr key={row.objectId} className="hover:bg-muted">
                                        <td className={td}>{row.objectId}</td>
                                        <td className={td}>{row.workspaceId}</td>
                                        <td className={cn(td, 'text-right tabular-nums')}>
                                            {formatBytes(row.ciphertextSize)}
                                        </td>
                                        <td
                                            className={cn(
                                                td,
                                                !row.replicatedAt &&
                                                    'font-semibold text-destructive',
                                            )}
                                        >
                                            {row.replicatedAt ? 'present' : 'absent'}
                                        </td>
                                        <td className={cn(td, 'tabular-nums')}>
                                            {row.auditedAt ? formatWhen(row.auditedAt) : '–'}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </OperatorTable>
                    )}
                    <p className="max-w-2xl pt-3 text-[13px] text-muted-foreground">
                        A missing object is one the audit couldn’t find at the primary store with
                        its recorded size. When a replica holds a copy, the next audit copies it
                        back. Otherwise the file shows as unavailable to its owner until it is
                        recovered by hand.
                    </p>
                </>
            )}
        </OperatorPage>
    );
}

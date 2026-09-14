import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { adminOverviewQueryOptions } from '@/lib/admin';
import { formatBytes, formatWhen } from '@/lib/drive';

/*
 * The management area's first page: what the instance holds and what the
 * store audit found. Numbers only, never names or content. A member who types
 * the address is sent to Drive; the API answers a member with 404 regardless.
 */
export const Route = createFileRoute('/_authenticated/app/admin/')({
    beforeLoad: ({ context }) => {
        if (context.user.role !== 'admin') throw redirect({ to: '/app' });
    },
    head: () => ({ meta: [{ title: 'Management · HushOS' }] }),
    component: AdminPage,
});

const cell = 'px-4 py-2.5 font-mono text-xs';

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
    return (
        <div className="flex flex-col gap-1 border-b px-4 py-3 sm:border-r sm:last:border-r-0">
            <span className="eyebrow text-muted-foreground">{label}</span>
            <span
                className={`font-mono text-lg tabular-nums ${tone === 'bad' ? 'text-destructive' : ''}`}
            >
                {value}
            </span>
        </div>
    );
}

function AdminPage() {
    const overview = useQuery(adminOverviewQueryOptions);
    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                eyebrow="Operator"
                title="Management"
                description="Counts and bytes across this instance, and what the nightly store audit found. Names and content are never visible here."
            />
            {overview.isPending && (
                <div className="flex flex-1 items-center justify-center py-24 text-muted-foreground">
                    <Spinner />
                </div>
            )}
            {overview.isError && (
                <div className="px-5 py-6 sm:px-8">
                    <Alert variant="destructive">
                        <AlertTitle>Could not load</AlertTitle>
                        <AlertDescription>
                            {overview.error instanceof Error
                                ? overview.error.message
                                : 'Please try again.'}
                        </AlertDescription>
                    </Alert>
                </div>
            )}
            {overview.data && (
                <div className="flex flex-col gap-8 px-5 py-6 sm:px-8 sm:py-8">
                    <section className="grid border bg-card sm:grid-cols-4">
                        <Stat label="Accounts" value={String(overview.data.people.total)} />
                        <Stat label="Admins" value={String(overview.data.people.admins)} />
                        <Stat label="Workspaces" value={String(overview.data.workspaces.total)} />
                        <Stat
                            label="Stored"
                            value={formatBytes(overview.data.workspaces.usedBytes)}
                        />
                    </section>
                    <section className="grid border bg-card sm:grid-cols-4">
                        <Stat label="Objects ready" value={String(overview.data.objects.ready)} />
                        <Stat
                            label="Objects missing"
                            value={String(overview.data.objects.missing)}
                            tone={overview.data.objects.missing > 0 ? 'bad' : undefined}
                        />
                        <Stat
                            label="Awaiting replica"
                            value={String(overview.data.objects.unreplicated)}
                        />
                        <Stat
                            label="Deletions queued"
                            value={String(overview.data.outbox.pending)}
                        />
                    </section>
                    <section className="grid border bg-card sm:grid-cols-4">
                        <Stat
                            label="Open reports"
                            value={String(overview.data.reports.open)}
                            tone={overview.data.reports.open > 0 ? 'bad' : undefined}
                        />
                        <Stat label="On hold" value={String(overview.data.reports.held)} />
                        <div className="flex items-center gap-5 px-4 py-3 sm:col-span-2">
                            <Link to="/app/admin/reports" className="text-link font-mono text-xs">
                                Open the reports queue
                            </Link>
                            <Link
                                to="/app/admin/affiliates"
                                className="text-link font-mono text-xs"
                            >
                                Affiliates
                            </Link>
                        </div>
                    </section>
                    <p className="font-mono text-[11px] text-muted-foreground">
                        Last store audit{' '}
                        {overview.data.objects.lastAuditedAt
                            ? formatWhen(overview.data.objects.lastAuditedAt)
                            : 'has not run yet'}
                        . {overview.data.objects.cold} objects in the cold class,{' '}
                        {overview.data.objects.pending} still uploading.
                    </p>
                    <section className="flex flex-col gap-3">
                        <h2 className="eyebrow text-muted-foreground">Missing objects</h2>
                        {overview.data.missing.length === 0 ? (
                            <p className="border bg-card px-4 py-3.5 font-mono text-xs text-muted-foreground">
                                None. Every audited object was found at the store with its recorded
                                size.
                            </p>
                        ) : (
                            <div className="overflow-x-auto border bg-card">
                                <table className="w-full border-collapse">
                                    <thead>
                                        <tr className="border-b">
                                            <th
                                                className={`${cell} eyebrow text-left font-medium text-muted-foreground`}
                                            >
                                                Object
                                            </th>
                                            <th
                                                className={`${cell} eyebrow text-left font-medium text-muted-foreground`}
                                            >
                                                Workspace
                                            </th>
                                            <th
                                                className={`${cell} eyebrow text-right font-medium text-muted-foreground`}
                                            >
                                                Size
                                            </th>
                                            <th
                                                className={`${cell} eyebrow text-left font-medium text-muted-foreground`}
                                            >
                                                Replica
                                            </th>
                                            <th
                                                className={`${cell} eyebrow text-left font-medium text-muted-foreground`}
                                            >
                                                Audited
                                            </th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {overview.data.missing.map((row) => (
                                            <tr
                                                key={row.objectId}
                                                className="border-b last:border-b-0"
                                            >
                                                <td className={cell}>{row.objectId}</td>
                                                <td className={cell}>{row.workspaceId}</td>
                                                <td className={`${cell} text-right tabular-nums`}>
                                                    {formatBytes(row.ciphertextSize)}
                                                </td>
                                                <td className={cell}>
                                                    {row.replicatedAt ? 'holds a copy' : 'no copy'}
                                                </td>
                                                <td className={cell}>
                                                    {row.auditedAt
                                                        ? formatWhen(row.auditedAt)
                                                        : '—'}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )}
                        <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                            A missing object is one the audit could not find at the primary store
                            with its recorded size. When a replica holds a copy, the next audit pass
                            copies it back. Otherwise the file shows as unavailable to its owner
                            until it is recovered by hand.
                        </p>
                    </section>
                </div>
            )}
        </div>
    );
}

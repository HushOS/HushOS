import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { formatWhen } from '@/lib/drive';
import {
    CATEGORIES,
    categoryLabel,
    describeDue,
    reportsQueryOptions,
    STATUS_LABELS,
} from '@/lib/reports';
import type { ReportCategory, ReportStatus } from '@hushos/drive/api';
import { REPORT_CATEGORIES } from '@hushos/drive/api';
import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';

/*
 * The reports queue: what people reported, oldest first, with the clock each
 * category runs on. Names and content stay sealed until an operator opens a
 * report; this page shows only what the reporter and the server put on record.
 */
export const Route = createFileRoute('/_authenticated/app/admin/reports/')({
    beforeLoad: ({ context }) => {
        if (context.user.role !== 'admin') throw redirect({ to: '/app' });
    },
    validateSearch: (
        search: Record<string, unknown>,
    ): { status?: 'all'; category?: ReportCategory } => ({
        ...(search.status === 'all' ? { status: 'all' as const } : {}),
        ...((REPORT_CATEGORIES as readonly string[]).includes(String(search.category))
            ? { category: search.category as ReportCategory }
            : {}),
    }),
    head: () => ({ meta: [{ title: 'Reports · HushOS' }] }),
    component: ReportsPage,
});

const cell = 'px-4 py-2.5 font-mono text-xs';
const head = `${cell} eyebrow text-left font-medium text-muted-foreground`;

function ReportsPage() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const status: ReportStatus | 'all' = search.status ?? 'open';
    const reports = useQuery(reportsQueryOptions({ status, category: search.category }));
    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                eyebrow="Operator"
                title="Reports"
                description="What people reported through a link or a share. Opening one hands you its key, sealed to you by the reporter's device, and puts the look on the record."
            >
                <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto">
                    <div role="tablist" aria-label="Status" className="flex h-10 border bg-card">
                        <Link
                            to="/app/admin/reports"
                            search={{ category: search.category }}
                            role="tab"
                            aria-selected={status === 'open'}
                            className={`eyebrow flex items-center px-4 ${status === 'open' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                        >
                            Open
                        </Link>
                        <Link
                            to="/app/admin/reports"
                            search={{ status: 'all', category: search.category }}
                            role="tab"
                            aria-selected={status === 'all'}
                            className={`eyebrow flex items-center border-l px-4 ${status === 'all' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                        >
                            All
                        </Link>
                    </div>
                    <Select
                        value={search.category ?? 'any'}
                        onValueChange={(value) =>
                            void navigate({
                                search: {
                                    ...(status === 'all' ? { status: 'all' as const } : {}),
                                    ...(value && value !== 'any'
                                        ? { category: value as ReportCategory }
                                        : {}),
                                },
                            })
                        }
                        items={[{ value: 'any', label: 'Every category' }, ...CATEGORIES]}
                    >
                        <SelectTrigger
                            aria-label="Category"
                            className="h-10 w-full bg-card sm:w-64"
                        >
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="any">Every category</SelectItem>
                            {CATEGORIES.map((entry) => (
                                <SelectItem key={entry.value} value={entry.value}>
                                    {entry.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </PageHeader>
            {reports.isPending && (
                <div className="flex flex-1 items-center justify-center py-24 text-muted-foreground">
                    <Spinner />
                </div>
            )}
            {reports.isError && (
                <div className="px-5 py-6 sm:px-8">
                    <Alert variant="destructive">
                        <AlertTitle>Could not load</AlertTitle>
                        <AlertDescription>
                            {reports.error instanceof Error
                                ? reports.error.message
                                : 'Please try again.'}
                        </AlertDescription>
                    </Alert>
                </div>
            )}
            {reports.data && (
                <div className="flex flex-col gap-4 px-5 py-6 sm:px-8 sm:py-8">
                    <p className="font-mono text-[11px] text-muted-foreground">
                        {reports.data.counts.open} open · {reports.data.counts.held} on hold ·{' '}
                        {reports.data.counts.total} ever filed.
                    </p>
                    {reports.data.reports.length === 0 ? (
                        <p className="border bg-card px-4 py-3.5 font-mono text-xs text-muted-foreground">
                            {status === 'open' ? 'Nothing open.' : 'No reports match.'}
                        </p>
                    ) : (
                        <div className="overflow-x-auto border bg-card">
                            <table className="w-full border-collapse">
                                <thead>
                                    <tr className="border-b">
                                        <th className={head}>Category</th>
                                        <th className={head}>Reported</th>
                                        <th className={head}>Clock</th>
                                        <th className={head}>Item</th>
                                        <th className={head}>Uploader</th>
                                        <th className={head}>Evidence</th>
                                        <th className={head}>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {reports.data.reports.map((report) => {
                                        const due = describeDue(report);
                                        return (
                                            <tr
                                                key={report.id}
                                                data-report-id={report.id}
                                                className="border-b last:border-b-0 hover:bg-muted/60"
                                            >
                                                <td className={cell}>
                                                    <Link
                                                        to="/app/admin/reports/$reportId"
                                                        params={{ reportId: report.id }}
                                                        className="text-link"
                                                    >
                                                        {categoryLabel(report.category)}
                                                    </Link>
                                                </td>
                                                <td className={cell}>
                                                    {formatWhen(report.createdAt)}
                                                </td>
                                                <td
                                                    className={`${cell} ${due?.overdue ? 'text-destructive' : ''}`}
                                                >
                                                    {due?.label ?? '-'}
                                                </td>
                                                <td className={cell}>
                                                    {report.nodeKind === 'folder'
                                                        ? `folder · ${report.itemCount - 1} inside`
                                                        : 'file'}
                                                    {report.itemsTruncated ? ' (partial)' : ''} ·
                                                    via {report.via}
                                                </td>
                                                <td className={cell}>
                                                    {report.uploader.email ?? '-'}
                                                </td>
                                                <td className={cell}>{report.evidenceStatus}</td>
                                                <td className={cell}>
                                                    {STATUS_LABELS[report.status]}
                                                    {report.heldAt ? ' · held' : ''}
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

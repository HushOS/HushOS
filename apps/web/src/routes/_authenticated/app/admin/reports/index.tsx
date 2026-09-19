import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
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
        if (context.user.role !== 'admin') throw redirect({ to: '/app/drive' });
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

const cell = 'px-4 py-2.5 text-sm';
const head = `${cell} eyebrow text-left text-muted-foreground`;

/* A small segmented control: the chosen filter takes the sheet's colour in a quiet tray. */
const tab = 'flex h-8 items-center rounded-xs px-3.5 text-[13px] font-semibold transition-colors';
const tabChosen = 'bg-card text-foreground';
const tabIdle = 'text-muted-foreground hover:text-foreground';

const statusTone = {
    open: 'warning',
    dismissed: 'outline',
    removed: 'destructive',
    filed: 'default',
} as const satisfies Record<ReportStatus, string>;

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
                    <div
                        role="tablist"
                        aria-label="Status"
                        className="flex rounded-md bg-muted p-0.5"
                    >
                        <Link
                            to="/app/admin/reports"
                            search={{ category: search.category }}
                            role="tab"
                            aria-selected={status === 'open'}
                            className={`${tab} ${status === 'open' ? tabChosen : tabIdle}`}
                        >
                            Open
                        </Link>
                        <Link
                            to="/app/admin/reports"
                            search={{ status: 'all', category: search.category }}
                            role="tab"
                            aria-selected={status === 'all'}
                            className={`${tab} ${status === 'all' ? tabChosen : tabIdle}`}
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
                        <SelectTrigger aria-label="Category" className="w-full sm:w-64">
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
                    <p className="text-sm text-muted-foreground tabular-nums">
                        {reports.data.counts.open} open · {reports.data.counts.held} on hold ·{' '}
                        {reports.data.counts.total} ever filed.
                    </p>
                    {reports.data.reports.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {status === 'open' ? 'Nothing open.' : 'No reports match.'}
                        </p>
                    ) : (
                        <div className="overflow-x-auto rounded-md border border-rule">
                            <table className="w-full border-collapse">
                                <thead>
                                    <tr className="border-b border-rule">
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
                                                className="border-b border-rule last:border-b-0 hover:bg-muted"
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
                                                <td className={`${cell} tabular-nums`}>
                                                    {formatWhen(report.createdAt)}
                                                </td>
                                                <td
                                                    className={`${cell} tabular-nums ${due?.overdue ? 'font-semibold text-destructive' : ''}`}
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
                                                    <Badge variant={statusTone[report.status]}>
                                                        {STATUS_LABELS[report.status]}
                                                        {report.heldAt ? ' · held' : ''}
                                                    </Badge>
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

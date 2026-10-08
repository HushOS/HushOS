import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { cn } from 'cn';
import { Spinner } from '@/components/motion';
import { FilterTabs, OperatorPage, OperatorTable, Pager, td, th } from '@/components/operator';
import { adminWorkspacesQueryOptions } from '@/lib/admin';
import { formatBytes, formatWhen } from '@/lib/drive';
import { formatQuota } from '@/lib/queries';

/*
 * Every workspace and where the space goes: who it belongs to, how much it
 * holds of its allowance, and any objects the audit couldn't find. Numbers
 * only; what a workspace holds stays sealed.
 */

type Search = { sort?: 'created'; offset?: number };

export const Route = createFileRoute('/_authenticated/app/admin/workspaces')({
    beforeLoad: ({ context }) => {
        if (context.user.role !== 'admin') throw redirect({ to: '/app/drive' });
    },
    validateSearch: (search: Record<string, unknown>): Search => ({
        ...(search.sort === 'created' ? { sort: 'created' as const } : {}),
        ...(Number.isInteger(Number(search.offset)) && Number(search.offset) > 0
            ? { offset: Number(search.offset) }
            : {}),
    }),
    head: () => ({ meta: [{ title: 'Workspaces · HushOS' }] }),
    component: WorkspacesPage,
});

function WorkspacesPage() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const offset = search.offset ?? 0;
    const list = useQuery({
        ...adminWorkspacesQueryOptions({ sort: search.sort ?? 'stored', offset }),
        placeholderData: keepPreviousData,
    });
    const data = list.data;
    return (
        <OperatorPage
            title="Workspaces"
            description="Each account has one. Choose an owner to see how their space is made up."
            actions={
                <FilterTabs
                    label="Order"
                    value={search.sort ?? 'stored'}
                    onChange={(sort) =>
                        void navigate({
                            search: { sort: sort === 'created' ? 'created' : undefined },
                        })
                    }
                    options={[
                        { value: 'stored', label: 'Most stored' },
                        { value: 'created', label: 'Newest' },
                    ]}
                />
            }
        >
            {list.isPending ? (
                <div className="flex justify-center py-16 text-muted-foreground">
                    <Spinner />
                </div>
            ) : list.isError ? (
                <p
                    role="alert"
                    className="rounded-md bg-destructive-soft px-4 py-3 text-sm text-destructive"
                >
                    The workspaces didn’t load.{' '}
                    {list.error instanceof Error ? list.error.message : 'Try again.'}
                </p>
            ) : (
                data && (
                    <>
                        <OperatorTable>
                            <thead>
                                <tr>
                                    <th className={th}>Workspace</th>
                                    <th className={th}>Owner</th>
                                    <th className={cn(th, 'text-right')}>Stored</th>
                                    <th className={cn(th, 'text-right')}>Allowance</th>
                                    <th className={cn(th, 'text-right')}>Missing</th>
                                    <th className={th}>Created</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.workspaces.map((workspace) => (
                                    <tr key={workspace.id} className="hover:bg-muted">
                                        <td className={cn(td, 'font-mono text-xs')}>
                                            {workspace.id}
                                        </td>
                                        <td className={cn(td, 'max-w-[260px] truncate')}>
                                            {workspace.ownerId ? (
                                                <Link
                                                    to="/app/admin/accounts/$accountId"
                                                    params={{ accountId: workspace.ownerId }}
                                                    className="hover:underline"
                                                >
                                                    {workspace.ownerEmail}
                                                </Link>
                                            ) : (
                                                <span className="text-muted-foreground">
                                                    No owner
                                                </span>
                                            )}
                                        </td>
                                        <td className={cn(td, 'text-right font-mono tabular-nums')}>
                                            {formatBytes(workspace.usedBytes)}
                                        </td>
                                        <td
                                            className={cn(
                                                td,
                                                'text-right font-mono tabular-nums text-muted-foreground',
                                            )}
                                        >
                                            {workspace.quotaBytes
                                                ? formatQuota(workspace.quotaBytes)
                                                : '–'}
                                        </td>
                                        <td
                                            className={cn(
                                                td,
                                                'text-right font-mono tabular-nums',
                                                workspace.missing > 0 &&
                                                    'font-semibold text-destructive',
                                            )}
                                        >
                                            {workspace.missing}
                                        </td>
                                        <td className={cn(td, 'whitespace-nowrap tabular-nums')}>
                                            {formatWhen(workspace.createdAt)}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </OperatorTable>
                        <Pager
                            offset={offset}
                            pageSize={data.pageSize}
                            total={data.total}
                            onOffset={(next) =>
                                void navigate({
                                    search: (previous) => ({
                                        ...previous,
                                        offset: next || undefined,
                                    }),
                                })
                            }
                        />
                    </>
                )
            )}
        </OperatorPage>
    );
}

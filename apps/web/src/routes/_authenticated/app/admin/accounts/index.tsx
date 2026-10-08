import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { cn } from 'cn';
import { SearchIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Spinner } from '@/components/motion';
import { FilterTabs, OperatorPage, OperatorTable, Pager, td, th } from '@/components/operator';
import { Input } from '@/components/ui/input';
import { adminAccountsQueryOptions } from '@/lib/admin';
import { formatBytes, formatWhen } from '@/lib/drive';
import { formatQuota } from '@/lib/queries';

/*
 * Every account, for an operator who needs to find someone: their name and
 * email, role, when they joined and were last seen, and how much of their
 * space they use. Nothing they keep, and no file names, is shown here.
 */

type Search = { role?: 'admin' | 'member'; q?: string; sort?: 'stored'; offset?: number };

export const Route = createFileRoute('/_authenticated/app/admin/accounts/')({
    beforeLoad: ({ context }) => {
        if (context.user.role !== 'admin') throw redirect({ to: '/app/drive' });
    },
    validateSearch: (search: Record<string, unknown>): Search => ({
        ...(search.role === 'admin' || search.role === 'member' ? { role: search.role } : {}),
        ...(typeof search.q === 'string' && search.q.trim()
            ? { q: search.q.trim().slice(0, 254) }
            : {}),
        ...(search.sort === 'stored' ? { sort: 'stored' as const } : {}),
        ...(Number.isInteger(Number(search.offset)) && Number(search.offset) > 0
            ? { offset: Number(search.offset) }
            : {}),
    }),
    head: () => ({ meta: [{ title: 'Accounts · HushOS' }] }),
    component: AccountsPage,
});

function AccountsPage() {
    const search = Route.useSearch();
    const navigate = Route.useNavigate();
    const offset = search.offset ?? 0;
    const accounts = useQuery({
        ...adminAccountsQueryOptions({
            role: search.role,
            q: search.q,
            sort: search.sort ?? 'joined',
            offset,
        }),
        placeholderData: keepPreviousData,
    });
    // The box writes to the address after a pause, so typing doesn't fetch every letter.
    const [typed, setTyped] = useState(search.q ?? '');
    useEffect(() => {
        const next = typed.trim() || undefined;
        if (next === search.q) return;
        const timer = setTimeout(
            () =>
                void navigate({
                    search: (previous) => ({ ...previous, q: next, offset: undefined }),
                    replace: true,
                }),
            300,
        );
        return () => clearTimeout(timer);
    }, [typed, search.q, navigate]);
    const data = accounts.data;
    return (
        <OperatorPage
            title={search.role === 'admin' ? 'Admins' : 'Accounts'}
            description="Find a person by their email or name. Their files and file names are never shown here."
            actions={
                <>
                    <FilterTabs
                        label="Role"
                        value={search.role ?? 'all'}
                        onChange={(role) =>
                            void navigate({
                                search: (previous) => ({
                                    ...previous,
                                    role: role === 'all' ? undefined : role,
                                    offset: undefined,
                                }),
                            })
                        }
                        options={[
                            { value: 'all', label: 'Everyone' },
                            { value: 'admin', label: 'Admins' },
                            { value: 'member', label: 'Members' },
                        ]}
                    />
                    <FilterTabs
                        label="Order"
                        value={search.sort ?? 'joined'}
                        onChange={(sort) =>
                            void navigate({
                                search: (previous) => ({
                                    ...previous,
                                    sort: sort === 'stored' ? 'stored' : undefined,
                                    offset: undefined,
                                }),
                            })
                        }
                        options={[
                            { value: 'joined', label: 'Newest' },
                            { value: 'stored', label: 'Most stored' },
                        ]}
                    />
                </>
            }
        >
            <div className="relative mb-3 max-w-md">
                <SearchIcon
                    className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden="true"
                />
                <Input
                    type="search"
                    aria-label="Search by email or name"
                    placeholder="Search by email or name"
                    value={typed}
                    onChange={(event) => setTyped(event.target.value)}
                    className="h-9 pl-9 text-sm"
                />
            </div>
            {accounts.isPending ? (
                <div className="flex justify-center py-16 text-muted-foreground">
                    <Spinner />
                </div>
            ) : accounts.isError ? (
                <p
                    role="alert"
                    className="rounded-md bg-destructive-soft px-4 py-3 text-sm text-destructive"
                >
                    The accounts didn’t load.{' '}
                    {accounts.error instanceof Error ? accounts.error.message : 'Try again.'}
                </p>
            ) : data && data.accounts.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">
                    {search.q ? `No account matches “${search.q}”.` : 'No accounts.'}
                </p>
            ) : (
                data && (
                    <>
                        <OperatorTable>
                            <thead>
                                <tr>
                                    <th className={th}>Account</th>
                                    <th className={th}>Role</th>
                                    <th className={th}>Joined</th>
                                    <th className={th}>Last seen</th>
                                    <th className={cn(th, 'text-right')}>Stored</th>
                                    <th className={th}>Status</th>
                                </tr>
                            </thead>
                            <tbody>
                                {data.accounts.map((account) => (
                                    <tr
                                        key={account.id}
                                        data-account={account.email}
                                        className="hover:bg-muted"
                                    >
                                        <td className={cn(td, 'max-w-[320px]')}>
                                            <Link
                                                to="/app/admin/accounts/$accountId"
                                                params={{ accountId: account.id }}
                                                className="block truncate pt-1 font-semibold hover:underline"
                                            >
                                                {account.name}
                                            </Link>
                                            <div className="truncate pb-1 text-xs text-muted-foreground">
                                                {account.email}
                                            </div>
                                        </td>
                                        <td className={td}>
                                            {account.role === 'admin' ? 'Admin' : 'Member'}
                                        </td>
                                        <td className={cn(td, 'whitespace-nowrap tabular-nums')}>
                                            {formatWhen(account.createdAt)}
                                        </td>
                                        <td className={cn(td, 'whitespace-nowrap tabular-nums')}>
                                            {account.lastSeenAt
                                                ? formatWhen(account.lastSeenAt)
                                                : '–'}
                                        </td>
                                        <td
                                            className={cn(
                                                td,
                                                'text-right font-mono whitespace-nowrap tabular-nums',
                                            )}
                                        >
                                            {formatBytes(account.usedBytes)}
                                            {account.quotaBytes && (
                                                <span className="text-muted-foreground">
                                                    {' '}
                                                    of {formatQuota(account.quotaBytes)}
                                                </span>
                                            )}
                                        </td>
                                        <td className={td}>
                                            {account.suspendedAt ? (
                                                <span className="font-semibold text-destructive">
                                                    Suspended
                                                </span>
                                            ) : (
                                                <span className="text-muted-foreground">
                                                    Active
                                                </span>
                                            )}
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

import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronRightIcon, RotateCcwIcon, TriangleAlertIcon, UsersIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { useDrive } from '@/components/drive/drive-shell';
import { CreateFamilyDialog } from '@/components/families/create-family-dialog';
import { NoticeList } from '@/components/families/family-alerts';
import { ServerKnowsLine } from '@/components/families/server-knows';
import { PageHeader } from '@/components/page-header';
import { PersonAvatar } from '@/components/person-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { familiesQueryOptions, rolesLine, useFamiliesSync } from '@/lib/families';
import { errorCopy } from '@/lib/groups/copy';

export const Route = createFileRoute('/_authenticated/app/_drive/families/')({
    head: () => ({ meta: [{ title: 'Families · HushOS' }] }),
    component: Families,
});

/*
 * The account's families (route 2), each synced on this device after the
 * outbox is sent again. A family you accepted but are not in yet leads to the
 * join screen; one whose member list was shown differently says so on its row.
 */
function Families() {
    const { userId } = useDrive();
    const families = useQuery(familiesQueryOptions(userId));
    const sync = useFamiliesSync(userId, families.data);
    const [creating, setCreating] = useState(false);
    const nameOf = (groupId: string) => families.data?.find((at) => at.id === groupId)?.name;

    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                title="Families"
                description="People in a family share its folders. Everyone is checked before they join."
            >
                <Button onClick={() => setCreating(true)}>Create a family</Button>
            </PageHeader>
            {sync.data && sync.data.notices.length > 0 && (
                <div className="px-5 pb-4 sm:px-8">
                    <NoticeList notices={sync.data.notices} nameOf={nameOf} />
                </div>
            )}
            {families.isPending && <SkeletonRows rows={2} />}
            {families.isError && (
                <EmptyState
                    icon={TriangleAlertIcon}
                    tone="danger"
                    title="Your families couldn’t be opened"
                    body={errorCopy(families.error)}
                >
                    <Button variant="outline" onClick={() => void families.refetch()}>
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </EmptyState>
            )}
            {families.data?.length === 0 && (
                <div className="flex h-14 items-center gap-3 border-y border-rule px-5 sm:px-8">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <UsersIcon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                        <span className="text-[15px] font-medium">No families yet</span>
                        <span className="text-[13px] text-muted-foreground">
                            Create one, or accept an invitation from someone else’s.
                        </span>
                    </span>
                </div>
            )}
            {families.data && families.data.length > 0 && (
                <ul className="flex flex-col border-t border-rule">
                    {families.data.map((family) => {
                        const synced = sync.data?.results.get(family.id);
                        const waiting = family.state === 'accepted';
                        return (
                            <li key={family.id} data-family={family.name}>
                                <Link
                                    to={
                                        waiting
                                            ? '/app/families/$groupId/join'
                                            : '/app/families/$groupId'
                                    }
                                    params={{ groupId: family.id }}
                                    className="flex h-14 items-center gap-3 border-b border-rule pr-4 pl-5 outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:pr-6 sm:pl-8"
                                >
                                    <PersonAvatar name={family.name} seed={family.id} />
                                    <span className="flex min-w-0 flex-1 flex-col">
                                        <span className="truncate text-[15px] font-medium">
                                            {family.name}
                                        </span>
                                        <span className="truncate text-[13px] text-muted-foreground">
                                            {waiting ? 'Waiting to join' : rolesLine(family.roles)}
                                        </span>
                                    </span>
                                    {synced?.status === 'fork' && (
                                        <Badge variant="destructive">Shown differently</Badge>
                                    )}
                                    {synced?.status === 'failed' && (
                                        <Badge variant="warning">Couldn’t check</Badge>
                                    )}
                                    <ChevronRightIcon
                                        className="size-4 shrink-0 text-muted-foreground"
                                        aria-hidden="true"
                                    />
                                </Link>
                            </li>
                        );
                    })}
                </ul>
            )}
            <ServerKnowsLine className="mt-auto" />
            <CreateFamilyDialog userId={userId} open={creating} onOpenChange={setCreating} />
        </div>
    );
}

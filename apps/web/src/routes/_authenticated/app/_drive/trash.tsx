import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { useEffect } from 'react';
import { useDrive } from '@/components/drive/drive-shell';
import { SkeletonRows } from '@/components/drive/file-list';
import { TrashView } from '@/components/drive/trash-view';
import { FamilySpaceScope } from '@/components/families/family-space';
import { FamilyTrashView, PrefetchFamilyTrash } from '@/components/families/family-trash';
import { trashQueryOptions } from '@/lib/drive';
import { activeFamily, familiesQueryOptions, useGroupsEnabled } from '@/lib/families-shell';

export const Route = createFileRoute('/_authenticated/app/_drive/trash')({
    validateSearch: (search: Record<string, unknown>): { view?: 'family' } =>
        search.view === 'family' ? { view: 'family' } : {},
    head: () => ({ meta: [{ title: 'Trash · HushOS' }] }),
    component: DriveTrashPage,
});

/*
 * Trash: My files', and for someone in a family the family folders' as a tab of its own
 * beside it (docs/families-shared-pool.md 7.1), as Shared has With me and By me. Each tab is
 * a whole Trash with its own rules: My files' is yours alone; the family folders' is
 * everyone's in the family. The other tab's list is read alongside the open one, so
 * switching shows it at once. Someone in no family sees one Trash and no tabs.
 */
function DriveTrashPage() {
    const { userId } = useDrive();
    const { view } = Route.useSearch();
    const queryClient = useQueryClient();
    const groups = useGroupsEnabled();
    const families = useQuery({ ...familiesQueryOptions(userId), enabled: groups });
    const family = groups ? activeFamily(families.data) : undefined;
    const familyTab = view === 'family' && family !== undefined;
    useEffect(() => {
        if (familyTab) void queryClient.prefetchQuery(trashQueryOptions);
    }, [queryClient, familyTab]);
    // Come for the family's tab: wait for the families rather than show My files' first.
    if (view === 'family' && groups && families.isPending) return <SkeletonRows rows={3} />;
    if (!family) return <TrashView />;

    const tab = (on: boolean) =>
        cn(
            'flex h-8 items-center rounded-sm px-4 text-sm font-semibold whitespace-nowrap transition-colors outline-none focus-visible:outline-2 focus-visible:outline-ring',
            on
                ? 'bg-card text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
        );
    const tabs = (
        <div className="px-5 pb-4 sm:px-8">
            <div
                role="tablist"
                aria-label="Whose Trash"
                className="inline-flex max-w-full rounded-md bg-muted p-1"
            >
                <Link
                    to="/app/trash"
                    search={{}}
                    role="tab"
                    aria-selected={!familyTab}
                    className={tab(!familyTab)}
                >
                    My files
                </Link>
                <Link
                    to="/app/trash"
                    search={{ view: 'family' }}
                    role="tab"
                    aria-selected={familyTab}
                    className={cn(tab(familyTab), 'min-w-0')}
                >
                    <span className="truncate">{family.name.trim() || 'Family'}</span>
                </Link>
            </div>
        </div>
    );

    return familyTab ? (
        <FamilySpaceScope groupId={family.id} joinScreen={false}>
            <FamilyTrashView tabs={tabs} />
        </FamilySpaceScope>
    ) : (
        <>
            <TrashView tabs={tabs} />
            <div hidden>
                <FamilySpaceScope groupId={family.id} joinScreen={false}>
                    <PrefetchFamilyTrash />
                </FamilySpaceScope>
            </div>
        </>
    );
}

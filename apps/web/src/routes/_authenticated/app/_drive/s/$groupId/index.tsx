import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronRightIcon, FolderPlusIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/drive/file-list';
import { FINISHING_KEY_CHANGE } from '@/components/drive/family-area';
import { NewFamilyFolderDialog } from '@/components/families/new-folder-dialog';
import { ServerKnowsLine } from '@/components/families/server-knows';
import { FolderMark } from '@/components/folder-mark';
import { PageHeader } from '@/components/page-header';
import { Button, buttonVariants } from '@/components/ui/button';
import type { AreaState } from '@/lib/groups/sync';
import { useFamilySpace } from '@/lib/spaces';

export const Route = createFileRoute('/_authenticated/app/_drive/s/$groupId/')({
    component: FamilySpacePage,
});

/* What a folder's row says under its name: plainly, whether things can be added to it here. */
function areaLine(area: AreaState) {
    if (!area.opened || !area.view.root) return 'Couldn’t check this folder’s keys';
    if (area.write === 'read-only') return 'Open only: its keys couldn’t be checked here';
    if (area.write === 'keys-changed') return 'Its keys changed. Open it to check again.';
    if (area.view.rotation) return FINISHING_KEY_CHANGE;
    return 'Everyone in the family can open it';
}

/*
 * The family's folders, as folder rows: each opens as its own Drive. Those
 * who manage the family make new ones; who is in it is on the family's page.
 */
function FamilySpacePage() {
    const space = useFamilySpace();
    const [creating, setCreating] = useState(false);
    // A folder whose root did not open has no name to show; it is listed by what it is.
    const rows = [...space.areas].sort((a, b) =>
        (a.name ?? '').localeCompare(b.name ?? '', undefined, { numeric: true }),
    );
    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                title={space.family}
                description="Family folders. Everyone in the family can open what’s in them."
            >
                <Link
                    to="/app/families/$groupId"
                    params={{ groupId: space.groupId }}
                    className={buttonVariants({ variant: 'outline' })}
                >
                    Members
                </Link>
                <Link
                    to="/app/s/$groupId/trash"
                    params={{ groupId: space.groupId }}
                    className={buttonVariants({ variant: 'outline' })}
                >
                    Trash
                </Link>
                {space.manager && (
                    <Button onClick={() => setCreating(true)}>
                        <FolderPlusIcon />
                        New family folder
                    </Button>
                )}
            </PageHeader>
            {rows.length === 0 ? (
                <EmptyState
                    icon={FolderPlusIcon}
                    title="No family folders yet"
                    body={
                        space.manager
                            ? 'Make one, and everyone in the family can open it.'
                            : 'Someone who manages the family can make one.'
                    }
                />
            ) : (
                <ul aria-label="Family folders" className="flex flex-col border-t border-rule">
                    {rows.map((area) => {
                        const root = area.view.root;
                        const name = area.name ?? 'Family folder';
                        const body = (
                            <>
                                <FolderMark box={36} />
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate text-[15px] font-medium">{name}</span>
                                    <span className="truncate text-[13px] text-muted-foreground">
                                        {areaLine(area)}
                                    </span>
                                </span>
                            </>
                        );
                        return (
                            <li
                                key={area.workspaceId}
                                data-area={name}
                                data-area-write={area.write}
                            >
                                {root && area.opened ? (
                                    <Link
                                        to="/app/s/$groupId/f/$folderId"
                                        params={{ groupId: space.groupId, folderId: root.id }}
                                        className="flex h-14 items-center gap-3 border-b border-rule pr-4 pl-5 outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:pr-6 sm:pl-8"
                                    >
                                        {body}
                                        <ChevronRightIcon
                                            className="size-4 shrink-0 text-muted-foreground"
                                            aria-hidden="true"
                                        />
                                    </Link>
                                ) : (
                                    <div className="flex h-14 items-center gap-3 border-b border-rule pr-4 pl-5 sm:pr-6 sm:pl-8">
                                        {body}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            <ServerKnowsLine className="mt-auto" />
            {space.manager && (
                <NewFamilyFolderDialog
                    userId={space.userId}
                    groupId={space.groupId}
                    family={space.family}
                    open={creating}
                    onOpenChange={setCreating}
                />
            )}
        </div>
    );
}

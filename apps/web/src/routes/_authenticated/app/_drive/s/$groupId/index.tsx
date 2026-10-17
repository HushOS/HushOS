import { createFileRoute, Link } from '@tanstack/react-router';
import { ChevronRightIcon, EllipsisIcon, FolderPlusIcon } from 'lucide-react';
import { useState } from 'react';
import { EmptyState, RowMenuButton } from '@/components/drive/file-list';
import { FINISHING_KEY_CHANGE } from '@/components/drive/family-area';
import { useFamilyPlanGate } from '@/components/families/family-billing';
import { DeleteFamilyFolderDialog } from '@/components/families/delete-folder-dialog';
import { NewFamilyFolderDialog } from '@/components/families/new-folder-dialog';
import { ServerKnowsLine } from '@/components/families/server-knows';
import { FolderMark } from '@/components/folder-mark';
import { PageHeader } from '@/components/page-header';
import { Button, buttonVariants } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
 * who manage the family make new ones and delete them (each row's menu); who
 * is in it is on the family's page.
 */
function FamilySpacePage() {
    const space = useFamilySpace();
    const [creating, setCreating] = useState(false);
    // Where plans are sold, a family folder waits for one: the pool is empty until it is paid.
    // Making and deleting family folders follow the same gate.
    const plan = useFamilyPlanGate(space.userId, space.groupId);
    const canChange = space.manager && !plan.waiting;
    const [deleting, setDeleting] = useState<{ workspaceId: string; name: string } | null>(null);
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
                {canChange && (
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
                        canChange
                            ? 'Make one, and everyone in the family can open it.'
                            : plan.waiting && plan.summary
                              ? `Family folders wait for ${space.family} to have a plan.`
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
                                className="flex items-center border-b border-rule hover:bg-muted"
                            >
                                {root && area.opened ? (
                                    <Link
                                        to="/app/s/$groupId/f/$folderId"
                                        params={{ groupId: space.groupId, folderId: root.id }}
                                        className="flex h-14 min-w-0 flex-1 items-center gap-3 pr-4 pl-5 outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:pr-6 sm:pl-8"
                                    >
                                        {body}
                                        <ChevronRightIcon
                                            className="size-4 shrink-0 text-muted-foreground"
                                            aria-hidden="true"
                                        />
                                    </Link>
                                ) : (
                                    <div className="flex h-14 min-w-0 flex-1 items-center gap-3 pr-4 pl-5 sm:pr-6 sm:pl-8">
                                        {body}
                                    </div>
                                )}
                                {canChange && (
                                    <div className="shrink-0 pr-3 sm:pr-5">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger
                                                render={
                                                    <RowMenuButton
                                                        aria-label={`More for ${name}`}
                                                    />
                                                }
                                            >
                                                <EllipsisIcon
                                                    className="size-5"
                                                    aria-hidden="true"
                                                />
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" className="w-56">
                                                <DropdownMenuItem
                                                    variant="destructive"
                                                    onClick={() =>
                                                        setDeleting({
                                                            workspaceId: area.workspaceId,
                                                            name,
                                                        })
                                                    }
                                                >
                                                    Delete family folder
                                                </DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
            <ServerKnowsLine className="mt-auto" />
            {canChange && (
                <NewFamilyFolderDialog
                    userId={space.userId}
                    groupId={space.groupId}
                    family={space.family}
                    open={creating}
                    onOpenChange={setCreating}
                />
            )}
            {canChange && (
                <DeleteFamilyFolderDialog
                    userId={space.userId}
                    groupId={space.groupId}
                    family={space.family}
                    folder={deleting}
                    onOpenChange={(open) => !open && setDeleting(null)}
                    onDeleted={space.recheck}
                />
            )}
        </div>
    );
}

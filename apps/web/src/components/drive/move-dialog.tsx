import type { DriveNode } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRightIcon } from 'lucide-react';
import { useState } from 'react';
import { useDrive } from '@/components/drive/drive-shell';
import { FileMark } from '@/components/drive/file-mark';
import { PendingLabel, Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    clientFor,
    copyInto,
    displayName,
    driveError,
    folderQueryOptions,
    invalidateFolders,
    mySharingQueryOptions,
    refuseWrite,
    sortNodes,
} from '@/lib/drive';
import { activeFamily, familiesQueryOptions, useGroupsEnabled } from '@/lib/families-shell';
import { storageQueryOptions } from '@/lib/queries';
import { cue } from '@/lib/sounds';

/*
 * A folder picker that browses from the root, for moving or copying. A move
 * offers neither the item itself nor its current folder; the server refuses a
 * move into a descendant anyway, and reports it as a cycle if a person gets
 * there. A copy may land in the same folder, under a "(copy)" name.
 *
 * A move also reaches the person's other places: My files and each of their
 * family's folders, under Places. Moving between them is a re-encryption on
 * this device (lib/move-across.ts), and the dialog says what that loses and
 * costs before it starts (docs/families-shared-pool.md 3.8).
 */
export function MoveDialog({
    nodes,
    rootId,
    mode = 'move',
    open,
    onOpenChange,
}: {
    nodes: DriveNode[];
    rootId: string;
    mode?: 'move' | 'copy';
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[520px]">
                <MovePicker nodes={nodes} rootId={rootId} mode={mode} onOpenChange={onOpenChange} />
            </DialogContent>
        </Dialog>
    );
}

/* Where the picker is: a folder of one place, or the list of places itself. */
type At = { folderId: string; workspaceId: string | null } | null;

const counted = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;

function MovePicker({
    nodes,
    rootId,
    mode,
    onOpenChange,
}: {
    nodes: DriveNode[];
    rootId: string;
    mode: 'move' | 'copy';
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const { userId } = useDrive();
    const groups = useGroupsEnabled();
    const sourceWorkspace = nodes[0]?.workspaceId ?? null;
    const [at, setAt] = useState<At>({ folderId: rootId, workspaceId: sourceWorkspace });
    const [pending, setPending] = useState(false);
    const [progress, setProgress] = useState(0);
    const [error, setError] = useState('');
    // My files and the family's folders, for a move by someone in a family: loaded with the
    // families layer, and only then.
    const families = useQuery({
        ...familiesQueryOptions(userId),
        enabled: mode === 'move' && groups,
    });
    const places = useQuery({
        queryKey: ['drive', 'move-places', userId],
        queryFn: async () => (await import('@/lib/move-across')).movePlaces(queryClient, userId),
        enabled: mode === 'move' && groups && activeFamily(families.data) !== undefined,
        staleTime: 60_000,
    });
    const reachable = places.data && places.data.length > 1 ? places.data : null;
    // A family folder's items move within it, listed by its own client.
    const listing = useQuery({
        ...folderQueryOptions(at?.folderId ?? rootId, at?.workspaceId ?? sourceWorkspace),
        enabled: at !== null,
    });
    const storage = useQuery({ ...storageQueryOptions, enabled: reachable !== null });
    const sharing = useQuery({ ...mySharingQueryOptions, enabled: reachable !== null });
    const moving = new Set(nodes.map((node) => node.id));
    const currentParent = nodes[0]?.parentId ?? null;
    const sameParent = nodes.every((node) => node.parentId === currentParent);
    const destination = at !== null ? listing.data?.folder : undefined;
    const across =
        mode === 'move' && destination !== undefined && destination.workspaceId !== sourceWorkspace;
    const placeOf = (workspaceId: string | null | undefined) =>
        reachable?.find((place) => place.workspaceId === workspaceId);
    const family = placeOf(destination?.workspaceId)?.family ?? placeOf(sourceWorkspace)?.family;
    // One pool: the person's own files draw from their family's, whose plan is live. Only what
    // the dialog says rests on it; the server decides how the move goes (`not-pooled`).
    const pooled =
        across &&
        family !== undefined &&
        family !== null &&
        storage.data?.pool?.groupId === family.groupId;
    const disabled =
        !destination ||
        moving.has(destination.id) ||
        (mode === 'move' && sameParent && destination.id === currentParent);

    async function submit() {
        if (!destination) return;
        setPending(true);
        setProgress(0);
        setError('');
        try {
            if (mode === 'copy') await copyInto(queryClient, nodes, destination, setProgress);
            else {
                const refused = refuseWrite(destination);
                if (refused) throw new Error(refused);
                if (across) {
                    const { moveAcross } = await import('@/lib/move-across');
                    await moveAcross(queryClient, nodes, destination, { onProgress: setProgress });
                } else
                    for (const node of nodes)
                        await clientFor(node.workspaceId).move(node, destination);
                await invalidateFolders(queryClient, currentParent, destination.id);
            }
            cue('success');
            onOpenChange(false);
        } catch (error) {
            cue('error');
            setError(driveError(error));
            await invalidateFolders(queryClient, currentParent, destination.id);
        } finally {
            setPending(false);
        }
    }

    const verb = mode === 'copy' ? 'Copy' : 'Move';
    const label = nodes.length === 1 ? `“${nodes[0]!.name}”` : `${nodes.length} items`;
    const placeName = (folder: DriveNode) => displayName(folder);
    const already = mode === 'move' && sameParent && destination?.id === currentParent;
    const trail =
        at !== null && listing.data ? [...listing.data.ancestors, listing.data.folder] : [];

    // What a move to another place loses, said before it starts (docs/families-shared-pool.md
    // 3.8): earlier versions, shares and links on what moves, and a family folder's writers.
    const revoked = (() => {
        if (!across || !sharing.data) return null;
        const inside = (nodeId: string) =>
            moving.has(nodeId) ||
            clientFor(sourceWorkspace)
                .ancestorsOf(nodeId)
                .some((node) => moving.has(node.id));
        const shares = sharing.data.shares.filter((share) => inside(share.node.id)).length;
        const links = sharing.data.links.filter((link) => inside(link.node.id)).length;
        if (shares === 0 && links === 0) return null;
        const parts = [
            ...(shares ? [counted(shares, 'share', 'shares')] : []),
            ...(links ? [counted(links, 'link', 'links')] : []),
        ];
        return `Moving revokes ${parts.join(' and ')}.`;
    })();
    const outOfFamily = across && placeOf(sourceWorkspace)?.family != null;

    return (
        <>
            <DialogHeader>
                <DialogTitle>
                    {verb} {label}
                </DialogTitle>
                <DialogDescription render={<nav aria-label="Location" />}>
                    <span className="flex flex-wrap items-center gap-1">
                        {reachable &&
                            (at === null ? (
                                <span
                                    aria-current="location"
                                    className="font-semibold text-foreground"
                                >
                                    Places
                                </span>
                            ) : (
                                <button
                                    type="button"
                                    className="cursor-pointer font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                                    onClick={() => setAt(null)}
                                >
                                    Places
                                </button>
                            ))}
                        {at !== null && trail.length === 0 && '…'}
                        {trail.map((crumb, index) => (
                            <span key={crumb.id} className="flex items-center gap-1">
                                {(index > 0 || reachable) && (
                                    <ChevronRightIcon className="size-3.5" aria-hidden="true" />
                                )}
                                {index === trail.length - 1 ? (
                                    <span
                                        aria-current="location"
                                        className="font-semibold text-foreground"
                                    >
                                        {placeName(crumb)}
                                    </span>
                                ) : (
                                    <button
                                        type="button"
                                        className="cursor-pointer font-semibold text-primary underline underline-offset-2 hover:text-primary-hover"
                                        onClick={() =>
                                            setAt({
                                                folderId: crumb.id,
                                                workspaceId: crumb.workspaceId,
                                            })
                                        }
                                    >
                                        {placeName(crumb)}
                                    </button>
                                )}
                            </span>
                        ))}
                    </span>
                </DialogDescription>
            </DialogHeader>
            <div className="flex h-[260px] flex-col overflow-y-auto rounded-xl border border-rule">
                {at === null &&
                    reachable?.map((place) => (
                        <button
                            key={place.workspaceId}
                            type="button"
                            onClick={() =>
                                setAt({ folderId: place.rootId, workspaceId: place.workspaceId })
                            }
                            className="flex h-14 w-full shrink-0 cursor-pointer items-center gap-3 border-b border-rule px-3 text-left last:border-0 hover:bg-muted"
                        >
                            <FileMark kind="folder" name={place.name} />
                            <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                                {place.name}
                            </span>
                            <ChevronRightIcon
                                className="size-4 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                            />
                        </button>
                    ))}
                {at !== null && listing.isPending && (
                    <div className="m-auto text-muted-foreground">
                        <Spinner />
                    </div>
                )}
                {at !== null && listing.isError && (
                    <p className="m-auto px-4 text-center text-sm text-destructive">
                        {driveError(listing.error)}
                    </p>
                )}
                {at !== null &&
                    listing.data &&
                    (() => {
                        const folders = sortNodes(listing.data.children).filter(
                            (child) => child.kind === 'folder',
                        );
                        if (!folders.length)
                            return (
                                <p className="m-auto text-sm text-muted-foreground">
                                    No folders in here.
                                </p>
                            );
                        return folders.map((folder) => {
                            const blocked = moving.has(folder.id);
                            return (
                                <button
                                    key={folder.id}
                                    type="button"
                                    disabled={blocked}
                                    title={
                                        blocked
                                            ? `${verb === 'Move' ? 'Moving' : 'Copying'} this one`
                                            : undefined
                                    }
                                    onClick={() =>
                                        setAt({
                                            folderId: folder.id,
                                            workspaceId: folder.workspaceId,
                                        })
                                    }
                                    className="flex h-14 w-full shrink-0 cursor-pointer items-center gap-3 border-b border-rule px-3 text-left last:border-0 hover:bg-muted disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
                                >
                                    <FileMark kind="folder" name={folder.name} />
                                    <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                                        {folder.name}
                                    </span>
                                    <ChevronRightIcon
                                        className="size-4 shrink-0 text-muted-foreground"
                                        aria-hidden="true"
                                    />
                                </button>
                            );
                        });
                    })()}
            </div>
            {across && (
                <div
                    data-move-across
                    className="flex flex-col gap-1.5 text-[13px] text-muted-foreground"
                >
                    <p>
                        Moving to another place copies each file on this device under that place’s
                        keys, then removes the original. Only the current version of each file
                        moves; earlier versions are deleted.
                    </p>
                    {revoked && <p>{revoked}</p>}
                    {outOfFamily && (
                        <p>
                            Each file is signed as yours from now on, in place of whoever added it.
                        </p>
                    )}
                    <p>
                        {pooled
                            ? `It uses no more of ${family!.name}’s storage.`
                            : `It needs free space in ${placeName(destination!)}: the copy is made there before the original is deleted.`}
                    </p>
                </div>
            )}
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            )}
            <DialogFooter>
                {mode === 'copy' && (
                    <p className="mr-auto text-[13px] text-muted-foreground max-sm:order-last">
                        Copies count towards your storage.
                    </p>
                )}
                <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
                    Cancel
                </Button>
                <Button onClick={() => void submit()} disabled={pending || disabled}>
                    <PendingLabel
                        pending={pending}
                        idle={already ? 'Already here' : `${verb} here`}
                        busy={
                            mode === 'copy' || across
                                ? progress > 0
                                    ? `${mode === 'copy' ? 'Copying' : 'Moving'}… ${progress}`
                                    : `${mode === 'copy' ? 'Copying' : 'Moving'}…`
                                : 'Moving…'
                        }
                    />
                </Button>
            </DialogFooter>
        </>
    );
}

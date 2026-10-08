import {
    recolourTag,
    removeTag,
    renameTag,
    tagsOf,
    type DriveNode,
    type TagColour,
} from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { PaletteIcon, PencilIcon, TagIcon, Trash2Icon } from 'lucide-react';
import { useId, useState } from 'react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { FileMark } from '@/components/drive/file-mark';
import { Swatch, TagColourPicker } from '@/components/drive/tag-colour';
import { TagDialog } from '@/components/drive/tag-dialog';
import { TagStamp, TagStamps } from '@/components/drive/tag-stamp';
import { PendingLabel } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
    displayName,
    driveClient,
    driveError,
    formatBytes,
    formatWhen,
    nodeSize,
    useCatalogueState,
} from '@/lib/drive';
import { useOpenNode } from '@/lib/open-node';
import { cue } from '@/lib/sounds';
import { invalidateTags, tagsQueryOptions } from '@/lib/tags';

/*
 * Everything carrying one tag, across every folder, from the catalogue on
 * this device. The tag itself is edited here: its name, its colour, and its
 * removal, which takes it off every item first so nothing is left pointing
 * at a tag that is gone.
 */
export function TagView({ tagId }: { tagId: string }) {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const catalogue = useCatalogueState();
    const registry = useQuery(tagsQueryOptions);
    const { folderLink } = useOpenNode();
    const [renaming, setRenaming] = useState(false);
    const [tagging, setTagging] = useState<DriveNode[] | null>(null);
    const [removing, setRemoving] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const tag = registry.data?.tags.find((entry) => entry.id === tagId) ?? null;
    // Read beside the catalogue state, so the list follows the build and the feed.
    const items: DriveNode[] =
        catalogue.phase === 'ready' || catalogue.phase === 'opening'
            ? driveClient
                  .byTags([tagId])
                  .sort((a, b) =>
                      a.kind === b.kind
                          ? a.name.localeCompare(b.name)
                          : a.kind === 'folder'
                            ? -1
                            : 1,
                  )
            : [];
    const building = catalogue.phase === 'pulling' || catalogue.phase === 'opening';

    async function recolour(colour: TagColour) {
        if (!registry.data || !tag) return;
        setBusy('colour');
        try {
            await driveClient.saveTags(recolourTag(registry.data, tag.id, colour));
            await invalidateTags(queryClient);
            cue('success', { volume: 0.4 });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t change the colour',
                description: driveError(error),
            });
        } finally {
            setBusy(null);
        }
    }

    /* The tag and its memberships leave the registry together; no item is touched. */
    async function remove() {
        if (!registry.data || !tag) return;
        setBusy('remove');
        try {
            await driveClient.saveTags(removeTag(registry.data, tag.id));
            await invalidateTags(queryClient);
            cue('droplet');
            toast.add({ type: 'success', title: `Tag “${tag.name}” removed` });
            await navigate({ to: '/app/drive' });
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t remove the tag',
                description: driveError(error),
            });
        } finally {
            setBusy(null);
            setRemoving(false);
        }
    }

    return (
        <div className="flex flex-col">
            <PageHeader
                title={
                    tag ? (
                        <span className="flex items-center gap-3">
                            <Swatch colour={tag.colour} className="size-3.5 rounded-full" />
                            {tag.name}
                        </span>
                    ) : registry.isPending ? (
                        '…'
                    ) : (
                        'No such tag'
                    )
                }
                description={
                    tag
                        ? `${items.length} ${items.length === 1 ? 'item has' : 'items have'} this tag.${building ? ' Search is still getting ready, so this may grow.' : ''}`
                        : 'This tag isn’t in your list any more.'
                }
            >
                {tag && (
                    <>
                        <Button variant="outline" onClick={() => setRenaming(true)}>
                            <PencilIcon />
                            Rename tag
                        </Button>
                        <DropdownMenu>
                            <DropdownMenuTrigger
                                render={<Button variant="outline" disabled={busy !== null} />}
                            >
                                <PaletteIcon />
                                Change colour
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-auto p-3">
                                <TagColourPicker
                                    value={tag.colour}
                                    onChange={(colour) => void recolour(colour)}
                                    disabled={busy !== null}
                                />
                            </DropdownMenuContent>
                        </DropdownMenu>
                        <Button
                            variant="ghost"
                            disabled={busy !== null}
                            onClick={() => setRemoving(true)}
                        >
                            <Trash2Icon />
                            Remove tag
                        </Button>
                    </>
                )}
            </PageHeader>
            {tag && items.length === 0 && (
                <EmptyState
                    icon={TagIcon}
                    title={building ? 'Nothing yet' : 'Nothing has this tag'}
                    body={
                        building
                            ? 'Search is still getting ready, so tagged items may still appear.'
                            : 'Select items in a folder and press T to tag them.'
                    }
                />
            )}
            {registry.isPending && <SkeletonRows rows={4} />}
            {tag && items.length > 0 && (
                <table
                    aria-label={`Items tagged ${tag.name}`}
                    className="w-full table-fixed border-collapse"
                >
                    <thead>
                        <tr className="h-10 border-b border-rule text-xs font-semibold text-muted-foreground">
                            <th scope="col" className="pl-5 text-left sm:pl-8">
                                Name
                            </th>
                            <th scope="col" className="hidden w-40 text-left sm:table-cell">
                                Changed
                            </th>
                            <th scope="col" className="w-28 pr-5 text-right sm:pr-8">
                                Size
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {items.map((node) => {
                            const size = nodeSize(node);
                            const path = driveClient.ancestorsOf(node.id).map(displayName);
                            const target =
                                node.kind === 'folder'
                                    ? folderLink(node.id)
                                    : node.parentId
                                      ? {
                                            ...folderLink(node.parentId),
                                            search: { preview: node.id },
                                        }
                                      : { to: '/app/drive' as const };
                            const others = registry.data
                                ? tagsOf(registry.data, node.id).filter((id) => id !== tag.id)
                                : [];
                            return (
                                <tr
                                    key={node.id}
                                    data-node-id={node.id}
                                    className="h-14 border-b border-rule hover:bg-muted"
                                >
                                    <td className="min-w-0 pl-5 sm:pl-8">
                                        <span className="flex min-w-0 items-center gap-4">
                                            <Link
                                                {...target}
                                                className="flex min-w-0 items-center gap-4 text-[15px] font-medium hover:[&>span>span:first-child]:underline"
                                            >
                                                <FileMark node={node} size="list" />
                                                <span className="flex min-w-0 flex-col">
                                                    <span className="truncate">{node.name}</span>
                                                    <span className="truncate text-[13px] font-normal text-muted-foreground">
                                                        {path.join(' › ')}
                                                    </span>
                                                </span>
                                            </Link>
                                            <TagStamps
                                                tagIds={others}
                                                registry={registry.data}
                                                itemName={node.name}
                                                onEdit={() => setTagging([node])}
                                                max={2}
                                            />
                                        </span>
                                    </td>
                                    <td className="hidden text-[13px] text-muted-foreground tabular-nums sm:table-cell">
                                        {formatWhen(node.metadata?.modified ?? node.updatedAt)}
                                    </td>
                                    <td className="pr-5 text-right text-[13px] text-muted-foreground tabular-nums sm:pr-8">
                                        {node.kind === 'folder'
                                            ? '–'
                                            : Number.isNaN(size)
                                              ? 'Missing'
                                              : formatBytes(size!)}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            <TagDialog
                nodes={tagging ?? []}
                open={tagging !== null}
                onOpenChange={(open) => !open && setTagging(null)}
            />
            {tag && (
                <RenameTagDialog
                    tag={tag}
                    open={renaming}
                    onOpenChange={setRenaming}
                    onRename={async (name) => {
                        if (!registry.data) return;
                        await driveClient.saveTags(renameTag(registry.data, tag.id, name));
                        await invalidateTags(queryClient);
                    }}
                />
            )}
            <AlertDialog
                open={removing}
                onOpenChange={(open) => !open && busy === null && setRemoving(false)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove “{tag?.name}”?</AlertDialogTitle>
                        <AlertDialogDescription>
                            The tag comes off {items.length} {items.length === 1 ? 'item' : 'items'}{' '}
                            and leaves your list. The items themselves aren’t touched.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={busy !== null}
                            onClick={() => void remove()}
                        >
                            <PendingLabel
                                pending={busy === 'remove'}
                                idle="Remove tag"
                                busy="Removing"
                            />
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

export function RenameTagDialog({
    tag,
    open,
    onOpenChange,
    onRename,
}: {
    tag: { id: string; name: string; colour: TagColour };
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onRename: (name: string) => Promise<void>;
}) {
    const id = useId();
    const [value, setValue] = useState(tag.name);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function submit() {
        const name = value.trim();
        if (!name || name === tag.name) {
            onOpenChange(false);
            return;
        }
        setPending(true);
        setError('');
        try {
            await onRename(name);
            cue('success');
            onOpenChange(false);
        } catch (error) {
            cue('error');
            setError(driveError(error));
        } finally {
            setPending(false);
        }
    }
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <form
                    className="contents"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void submit();
                    }}
                    noValidate
                >
                    <DialogHeader>
                        <DialogTitle>Rename tag</DialogTitle>
                        <DialogDescription>
                            The new name shows everywhere at once; the items are not touched.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="flex flex-col gap-2">
                        <label htmlFor={id} className="eyebrow text-muted-foreground">
                            Name
                        </label>
                        <div className="flex items-center gap-3">
                            <TagStamp name={value.trim() || tag.name} colour={tag.colour} />
                            <Input
                                id={id}
                                value={value}
                                onChange={(event) => setValue(event.target.value)}
                                autoComplete="off"
                                spellCheck={false}
                                aria-invalid={Boolean(error)}
                                maxLength={40}
                            />
                        </div>
                        {error && (
                            <p role="alert" className="text-xs text-destructive">
                                {error}
                            </p>
                        )}
                    </div>
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => onOpenChange(false)}
                            disabled={pending}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={pending || !value.trim()}>
                            <PendingLabel pending={pending} idle="Rename" busy="Renaming" />
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

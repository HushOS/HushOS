import {
    addTag,
    recolourTag,
    removeTag,
    renameTag,
    type Tag,
    type TagColour,
} from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
    PaletteIcon,
    PencilIcon,
    PlusIcon,
    RotateCcwIcon,
    TagIcon,
    Trash2Icon,
    TriangleAlertIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { RenameTagDialog } from '@/components/drive/tag-view';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
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
import { Swatch, TagColourButton, TagColourPicker } from '@/components/drive/tag-colour';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { driveClient, driveError } from '@/lib/drive';
import { cue } from '@/lib/sounds';
import { invalidateTags, suggestedColour, tagsQueryOptions, useTagCounts } from '@/lib/tags';

/*
 * The registry as a list: every tag, how many items on this device carry it,
 * and the three things that can happen to a tag. Each row opens the tag's
 * page; a new tag is made here without applying it to anything.
 */
export function TagsView() {
    const queryClient = useQueryClient();
    const registry = useQuery(tagsQueryOptions);
    const counts = useTagCounts();
    const id = useId();
    const [draft, setDraft] = useState('');
    const [picked, setPicked] = useState<TagColour | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const [renaming, setRenaming] = useState<Tag | null>(null);
    const [removing, setRemoving] = useState<Tag | null>(null);
    const [error, setError] = useState('');

    async function save(next: Awaited<ReturnType<typeof driveClient.tags>>, what: string) {
        try {
            await driveClient.saveTags(next);
            await invalidateTags(queryClient);
            cue('success', { volume: 0.4 });
        } catch (error) {
            cue('error');
            toast.add({ type: 'error', title: what, description: driveError(error) });
        }
    }
    async function create() {
        const name = draft.trim();
        if (!name || !registry.data) return;
        setBusy('create');
        setError('');
        try {
            const { registry: next } = addTag(
                registry.data,
                name,
                picked ?? suggestedColour(registry.data),
            );
            if (next !== registry.data) await driveClient.saveTags(next);
            await invalidateTags(queryClient);
            setDraft('');
            setPicked(null);
            cue('success', { volume: 0.4 });
        } catch (error) {
            cue('error');
            setError(driveError(error));
        } finally {
            setBusy(null);
        }
    }
    async function recolour(tag: Tag, colour: TagColour) {
        if (!registry.data) return;
        setBusy(tag.id);
        await save(recolourTag(registry.data, tag.id, colour), 'Couldn’t change the colour');
        setBusy(null);
    }
    async function remove(tag: Tag) {
        if (!registry.data) return;
        setBusy(tag.id);
        await save(removeTag(registry.data, tag.id), 'Couldn’t remove the tag');
        setBusy(null);
        setRemoving(null);
    }

    const tags = [...(registry.data?.tags ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    return (
        <div className="flex flex-col">
            <PageHeader
                title="Tags"
                description="Only you see your tags. People you share with don’t."
            />
            <form
                className="flex flex-col gap-2 px-5 pb-5 sm:px-8"
                onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                }}
                noValidate
            >
                <div className="flex max-w-md items-center gap-2">
                    {registry.data && (
                        <TagColourButton
                            value={picked ?? suggestedColour(registry.data)}
                            onChange={setPicked}
                            disabled={busy !== null}
                        />
                    )}
                    <label htmlFor={id} className="sr-only">
                        New tag
                    </label>
                    <Input
                        id={id}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder="New tag"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={40}
                        className="h-9 flex-1 pointer-coarse:h-11"
                    />
                    <Button
                        type="submit"
                        variant="outline"
                        disabled={busy !== null || !draft.trim() || !registry.data}
                    >
                        <PlusIcon />
                        {busy === 'create' ? 'Adding…' : 'Add'}
                    </Button>
                </div>
                {error && (
                    <p role="alert" className="text-[13px] text-destructive">
                        {error}
                    </p>
                )}
            </form>
            {registry.isPending && <SkeletonRows rows={4} />}
            {registry.isError && (
                <EmptyState
                    icon={TriangleAlertIcon}
                    tone="danger"
                    title="Your tags couldn’t be opened"
                    body={driveError(registry.error)}
                >
                    <Button variant="outline" onClick={() => void registry.refetch()}>
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </EmptyState>
            )}
            {registry.data && tags.length === 0 && (
                <EmptyState
                    icon={TagIcon}
                    title="No tags yet"
                    body="Make one above, or select items in a folder and press T."
                />
            )}
            {tags.length > 0 && (
                <table aria-label="Tags" className="w-full table-fixed border-collapse">
                    <thead>
                        <tr className="h-10 border-b border-rule text-xs font-semibold text-muted-foreground">
                            <th scope="col" className="pl-5 text-left sm:pl-8">
                                Tag
                            </th>
                            <th scope="col" className="hidden w-28 pr-6 text-right sm:table-cell">
                                Items
                            </th>
                            <th scope="col" className="w-36 pr-5 sm:pr-8 xl:w-[26rem]">
                                <span className="sr-only">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {tags.map((tag) => (
                            <tr
                                key={tag.id}
                                data-tag-id={tag.id}
                                className="h-14 border-b border-rule hover:bg-muted"
                            >
                                <td className="min-w-0 pl-5 sm:pl-8">
                                    <Link
                                        to="/app/tags/$tagId"
                                        params={{ tagId: tag.id }}
                                        className="inline-flex max-w-full items-center gap-3 text-[15px] font-semibold hover:underline"
                                    >
                                        <Swatch
                                            colour={tag.colour}
                                            className="size-3 rounded-full"
                                        />
                                        <span className="truncate">{tag.name}</span>
                                    </Link>
                                </td>
                                <td className="hidden pr-6 text-right text-[13px] text-muted-foreground tabular-nums sm:table-cell">
                                    {counts.get(tag.id) ?? 0}
                                </td>
                                <td className="py-1.5 pr-5 text-right sm:pr-8">
                                    <div className="flex justify-end gap-1.5">
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            disabled={busy !== null}
                                            onClick={() => setRenaming(tag)}
                                        >
                                            <PencilIcon />
                                            <span className="max-xl:sr-only">Rename tag</span>
                                        </Button>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger
                                                render={
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        disabled={busy !== null}
                                                        aria-label={`Colour of ${tag.name}`}
                                                    />
                                                }
                                            >
                                                <PaletteIcon />
                                                <span className="max-xl:sr-only">
                                                    Change colour
                                                </span>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" className="w-auto p-3">
                                                <TagColourPicker
                                                    value={tag.colour}
                                                    onChange={(colour) =>
                                                        void recolour(tag, colour)
                                                    }
                                                    disabled={busy !== null}
                                                />
                                            </DropdownMenuContent>
                                        </DropdownMenu>
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            aria-label={`Remove ${tag.name}`}
                                            disabled={busy !== null}
                                            onClick={() => setRemoving(tag)}
                                        >
                                            <Trash2Icon />
                                            <span className="max-xl:sr-only">Remove tag</span>
                                        </Button>
                                    </div>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            {renaming && (
                <RenameTagDialog
                    key={renaming.id}
                    tag={renaming}
                    open
                    onOpenChange={(open) => !open && setRenaming(null)}
                    onRename={async (name) => {
                        if (!registry.data) return;
                        await driveClient.saveTags(renameTag(registry.data, renaming.id, name));
                        await invalidateTags(queryClient);
                    }}
                />
            )}
            <AlertDialog
                open={removing !== null}
                onOpenChange={(open) => !open && busy === null && setRemoving(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Remove “{removing?.name}”?</AlertDialogTitle>
                        <AlertDialogDescription>
                            The tag comes off {removing ? (counts.get(removing.id) ?? 0) : 0}{' '}
                            {removing && (counts.get(removing.id) ?? 0) === 1 ? 'item' : 'items'}{' '}
                            and leaves your list. The items themselves aren’t touched.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            disabled={busy !== null}
                            onClick={() => removing && void remove(removing)}
                        >
                            <PendingLabel
                                pending={busy === removing?.id}
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

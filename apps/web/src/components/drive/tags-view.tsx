import {
    addTag,
    recolourTag,
    removeTag,
    renameTag,
    nextColour,
    type Tag,
    type TagColour,
} from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PaletteIcon, PencilIcon, PlusIcon, Trash2Icon } from 'lucide-react';
import { useId, useState } from 'react';
import { RenameTagDialog } from '@/components/drive/tag-view';
import { TagStamp } from '@/components/drive/tag-stamp';
import { PendingLabel, Spinner } from '@/components/motion';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TagColourPicker } from '@/components/drive/tag-colour';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { driveClient, driveError } from '@/lib/drive';
import { cue } from '@/lib/sounds';
import { invalidateTags, tagsQueryOptions, useTagCounts } from '@/lib/tags';

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
            const { registry: next } = addTag(registry.data, name, picked ?? undefined);
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
        await save(recolourTag(registry.data, tag.id, colour), 'Could not change the colour');
        setBusy(null);
    }
    async function remove(tag: Tag) {
        if (!registry.data) return;
        setBusy(tag.id);
        await save(removeTag(registry.data, tag.id), 'Could not remove the tag');
        setBusy(null);
        setRemoving(null);
    }

    const tags = [...(registry.data?.tags ?? [])].sort((a, b) => a.name.localeCompare(b.name));
    return (
        <div className="flex flex-col">
            <PageHeader
                eyebrow="Drive"
                title="Tags"
                description="Every tag in your workspace. Tags are sealed to your workspace and never written on an item, so the people you share with never see them."
            />
            <form
                className="flex flex-wrap items-end gap-2 border-b border-rule px-5 py-4 sm:px-8"
                onSubmit={(event) => {
                    event.preventDefault();
                    void create();
                }}
                noValidate
            >
                <div className="flex min-w-0 flex-1 flex-col gap-2 sm:max-w-sm">
                    <label htmlFor={id} className="eyebrow text-muted-foreground">
                        New tag
                    </label>
                    <Input
                        id={id}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        placeholder="Home, Tax, Travel…"
                        autoComplete="off"
                        spellCheck={false}
                        maxLength={40}
                        className="h-9"
                    />
                </div>
                {registry.data && (
                    <TagColourPicker
                        value={picked ?? nextColour(registry.data)}
                        onChange={setPicked}
                        disabled={busy !== null}
                        className="h-9"
                    />
                )}
                <Button
                    type="submit"
                    variant="outline"
                    size="sm"
                    className="h-9 w-24 justify-center"
                    disabled={busy !== null || !draft.trim() || !registry.data}
                >
                    <PlusIcon />
                    <PendingLabel pending={busy === 'create'} idle="Add" busy="Adding" />
                </Button>
                {error && (
                    <p role="alert" className="w-full text-xs text-destructive">
                        {error}
                    </p>
                )}
            </form>
            {registry.isPending && (
                <div className="flex items-center justify-center py-24 text-muted-foreground">
                    <Spinner />
                </div>
            )}
            {registry.isError && (
                <div className="px-5 py-6 sm:px-8">
                    <Alert variant="destructive" className="max-w-xl">
                        <AlertTitle>The tag list could not be opened</AlertTitle>
                        <AlertDescription>{driveError(registry.error)}</AlertDescription>
                    </Alert>
                </div>
            )}
            {registry.data && tags.length === 0 && (
                <p className="px-5 py-12 text-sm text-muted-foreground sm:px-8">
                    No tags yet. Make one above, or select items in a folder and press T.
                </p>
            )}
            {tags.length > 0 && (
                <table aria-label="Tags" className="w-full table-fixed border-collapse">
                    <thead>
                        <tr className="border-b border-rule">
                            <th
                                scope="col"
                                className="eyebrow py-2.5 pl-5 text-left text-muted-foreground sm:pl-8"
                            >
                                Tag
                            </th>
                            <th
                                scope="col"
                                className="eyebrow hidden w-28 py-2.5 pr-6 text-right text-muted-foreground sm:table-cell"
                            >
                                Items
                            </th>
                            <th scope="col" className="w-44 pr-5 sm:w-80 sm:pr-8">
                                <span className="sr-only">Actions</span>
                            </th>
                        </tr>
                    </thead>
                    <tbody>
                        {tags.map((tag) => (
                            <tr
                                key={tag.id}
                                data-tag-id={tag.id}
                                className="h-[46px] border-b border-rule hover:bg-muted"
                            >
                                <td className="py-2 pl-5 sm:pl-8">
                                    <Link
                                        to="/app/tags/$tagId"
                                        params={{ tagId: tag.id }}
                                        className="inline-flex items-center gap-3 text-sm hover:underline"
                                    >
                                        <TagStamp name={tag.name} colour={tag.colour} />
                                    </Link>
                                </td>
                                <td className="hidden py-2 pr-6 text-right text-sm text-muted-foreground tabular-nums sm:table-cell">
                                    {counts.get(tag.id) ?? 0}
                                </td>
                                <td className="py-1.5 pr-5 text-right sm:pr-8">
                                    <div className="flex justify-end gap-1.5">
                                        <Button
                                            variant="ghost"
                                            size="xs"
                                            disabled={busy !== null}
                                            onClick={() => setRenaming(tag)}
                                        >
                                            <PencilIcon />
                                            <span className="max-sm:sr-only">Rename</span>
                                        </Button>
                                        <DropdownMenu>
                                            <DropdownMenuTrigger
                                                render={
                                                    <Button
                                                        variant="ghost"
                                                        size="xs"
                                                        disabled={busy !== null}
                                                        aria-label={`Colour of ${tag.name}`}
                                                    />
                                                }
                                            >
                                                <PaletteIcon />
                                                <span className="max-sm:sr-only">Colour</span>
                                            </DropdownMenuTrigger>
                                            <DropdownMenuContent align="end" className="w-auto p-2">
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
                                            size="xs"
                                            aria-label={`Remove ${tag.name}`}
                                            disabled={busy !== null}
                                            onClick={() => setRemoving(tag)}
                                        >
                                            <Trash2Icon />
                                            <span className="max-sm:sr-only">Remove</span>
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
                            and leaves your list. The items themselves are not touched.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
                        <AlertDialogAction
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

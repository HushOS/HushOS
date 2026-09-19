import {
    addTag,
    assign,
    findTag,
    nextColour,
    tagsOf,
    type DriveNode,
    type Tag,
    type TagColour,
    type TagRegistry,
} from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CheckIcon, PlusIcon, TagsIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { TagColourPicker } from '@/components/drive/tag-colour';
import { TagStamp } from '@/components/drive/tag-stamp';
import { PendingLabel, Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { driveClient, driveError } from '@/lib/drive';
import { invalidateTags, tagsQueryOptions } from '@/lib/tags';
import { cue } from '@/lib/sounds';

/*
 * The tags one or more items carry. Every tag in the workspace is a row: on
 * for all of the chosen items, some, or none. A new tag is made here too, and
 * goes on at once. Saving rewrites each changed item's metadata, sealed on
 * this device, so the server sees a rename and nothing more.
 */
export function TagDialog({
    nodes,
    open,
    onOpenChange,
}: {
    nodes: DriveNode[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={open && nodes.length > 0} onOpenChange={onOpenChange}>
            <DialogContent>
                {nodes.length > 0 && (
                    <TagForm
                        key={nodes.map((node) => node.id).join(',')}
                        nodes={nodes}
                        onOpenChange={onOpenChange}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

type Mark = 'all' | 'some' | 'none';

function marksFor(nodes: DriveNode[], registry: TagRegistry) {
    const marks: Record<string, Mark> = {};
    for (const tag of registry.tags) {
        const carrying = nodes.filter((node) => registry.items[tag.id]?.includes(node.id)).length;
        marks[tag.id] = carrying === 0 ? 'none' : carrying === nodes.length ? 'all' : 'some';
    }
    return marks;
}

function TagForm({
    nodes,
    onOpenChange,
}: {
    nodes: DriveNode[];
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const id = useId();
    const registry = useQuery(tagsQueryOptions);
    const [marks, setMarks] = useState<Record<string, Mark> | null>(null);
    const [draft, setDraft] = useState('');
    const [picked, setPicked] = useState<TagColour | null>(null);
    const [pending, setPending] = useState<'save' | 'create' | null>(null);
    const [error, setError] = useState('');
    // The starting marks come from the items once the registry is here; edits layer on top.
    const current = marks ?? (registry.data ? marksFor(nodes, registry.data) : null);

    function toggle(tagId: string) {
        if (!current) return;
        setMarks({ ...current, [tagId]: current[tagId] === 'all' ? 'none' : 'all' });
    }

    // What the box holds: the tags it narrows to, and the one it names exactly, if any.
    const typed = draft.trim();
    const exact = (() => {
        if (!typed || !registry.data) return null;
        try {
            return findTag(registry.data, typed);
        } catch {
            return null;
        }
    })();
    // The list narrows to the typed text, but a checked tag never leaves it: what is about to be saved stays in sight.
    const matches = (tag: Tag) =>
        !typed || tag.name.toLocaleLowerCase().includes(typed.toLocaleLowerCase());
    const anyMatch = !typed || (registry.data?.tags ?? []).some(matches);
    const selected = exact !== null && current?.[exact.id] === 'all';
    const shown = [...(registry.data?.tags ?? [])]
        .filter((tag) => matches(tag) || (current?.[tag.id] ?? 'none') !== 'none')
        .sort((a, b) => a.name.localeCompare(b.name));

    /* Enter on a name that exists checks it; on a new name, makes it and checks it. */
    async function create() {
        const name = typed;
        if (!name || !registry.data || !current || pending) return;
        if (exact) {
            if (current[exact.id] !== 'all') setMarks({ ...current, [exact.id]: 'all' });
            setDraft('');
            return;
        }
        setPending('create');
        setError('');
        try {
            const { registry: next, tag } = addTag(registry.data, name, picked ?? undefined);
            if (next !== registry.data) await driveClient.saveTags(next);
            await invalidateTags(queryClient);
            // Marks may have moved while the save was out; check on top of what is there now.
            setMarks((marks) => ({ ...(marks ?? current), [tag.id]: 'all' }));
            setDraft('');
            setPicked(null);
            cue('success', { volume: 0.4 });
        } catch (error) {
            cue('error');
            setError(driveError(error));
        } finally {
            setPending(null);
        }
    }

    async function save() {
        if (!current || !registry.data) return;
        setPending('save');
        setError('');
        try {
            // One registry write for the whole selection; nothing on any node changes.
            let next = registry.data;
            for (const node of nodes) {
                const had = tagsOf(next, node.id);
                const kept = had.filter((tagId) => current[tagId] !== 'none');
                const added = Object.entries(current)
                    .filter(([tagId, mark]) => mark === 'all' && !kept.includes(tagId))
                    .map(([tagId]) => tagId);
                next = assign(next, node.id, [...kept, ...added]);
            }
            if (next !== registry.data) await driveClient.saveTags(next);
            await invalidateTags(queryClient);
            cue('success');
            onOpenChange(false);
        } catch (error) {
            cue('error');
            setError(driveError(error));
        } finally {
            setPending(null);
        }
    }

    const busy = pending !== null;
    const what = nodes.length === 1 ? `“${nodes[0]!.name}”` : `${nodes.length} selected items`;
    return (
        <form
            className="contents"
            onSubmit={(event) => {
                event.preventDefault();
                void save();
            }}
            noValidate
        >
            <DialogHeader>
                <DialogTitle>Tags for {what}</DialogTitle>
                <DialogDescription>
                    Tags are yours alone: sealed to your workspace, never written on the item, and
                    invisible to anyone you share it with.
                </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
                {registry.isPending && (
                    <div className="flex items-center justify-center py-6 text-muted-foreground">
                        <Spinner />
                    </div>
                )}
                {registry.isError && (
                    <p role="alert" className="text-xs text-destructive">
                        {driveError(registry.error)}
                    </p>
                )}
                {registry.data && current && (
                    <div className="flex max-h-72 flex-col overflow-y-auto border-y border-rule">
                        {registry.data.tags.length === 0 && (
                            <p className="px-1.5 py-3 text-sm text-muted-foreground">
                                No tags yet. Make the first one below.
                            </p>
                        )}
                        {shown.map((tag) => {
                            const mark = current[tag.id] ?? 'none';
                            return (
                                <label
                                    key={tag.id}
                                    className="flex cursor-pointer items-center gap-3 border-b border-rule px-1.5 py-2.5 last:border-b-0 hover:bg-muted"
                                >
                                    <Checkbox
                                        checked={mark === 'all'}
                                        indeterminate={mark === 'some'}
                                        onCheckedChange={() => toggle(tag.id)}
                                        aria-label={tag.name}
                                    />
                                    <TagStamp name={tag.name} colour={tag.colour} />
                                    {mark === 'some' && (
                                        <span className="ml-auto text-xs text-muted-foreground">
                                            on some
                                        </span>
                                    )}
                                </label>
                            );
                        })}
                        {registry.data.tags.length > 0 && !anyMatch && (
                            <p className="px-1.5 py-3 text-sm text-muted-foreground">
                                No tag called “{typed}”. Press Enter to make it.
                            </p>
                        )}
                    </div>
                )}
                <div className="flex flex-col gap-2">
                    <label htmlFor={id} className="eyebrow text-muted-foreground">
                        Find or make a tag
                    </label>
                    <div className="flex flex-col gap-2">
                        <Input
                            id={id}
                            value={draft}
                            onChange={(event) => setDraft(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                    event.preventDefault();
                                    void create();
                                }
                            }}
                            placeholder="Home, Tax, Travel…"
                            autoComplete="off"
                            spellCheck={false}
                            maxLength={40}
                        />
                        <div className="flex items-center justify-between gap-2">
                            {registry.data && !exact ? (
                                <TagColourPicker
                                    value={picked ?? nextColour(registry.data)}
                                    onChange={setPicked}
                                    disabled={busy}
                                />
                            ) : (
                                <span />
                            )}
                            <Button
                                type="button"
                                variant="outline"
                                size="sm"
                                disabled={busy || !typed || !registry.data || selected}
                                onClick={() => void create()}
                            >
                                {exact ? <CheckIcon /> : <PlusIcon />}
                                <PendingLabel
                                    pending={pending === 'create'}
                                    idle={selected ? 'Selected' : exact ? 'Check' : 'Add'}
                                    busy="Adding"
                                />
                            </Button>
                        </div>
                    </div>
                </div>
                {error && (
                    <p role="alert" className="text-xs text-destructive">
                        {error}
                    </p>
                )}
            </div>
            <DialogFooter className="sm:justify-between">
                <Button
                    variant="outline"
                    size="sm"
                    render={<Link to="/app/tags" onClick={() => onOpenChange(false)} />}
                >
                    <TagsIcon />
                    Manage tags
                </Button>
                <span className="flex gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => onOpenChange(false)}
                        disabled={busy}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" disabled={busy || !current}>
                        <PendingLabel pending={pending === 'save'} idle="Save tags" busy="Saving" />
                    </Button>
                </span>
            </DialogFooter>
        </form>
    );
}

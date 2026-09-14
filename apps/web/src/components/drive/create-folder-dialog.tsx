import type { DriveNode } from '@hushos/drive/client';
import { splitPath } from '@hushos/drive/client';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { PendingLabel } from '@/components/motion';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { driveClient, driveError, invalidateFolders } from '@/lib/drive';
import { cue } from '@/lib/sounds';

/*
 * One field. "Reports" makes a folder; "Reports/2026/Q3" makes the chain, each
 * folder wrapped under the one before it, in a single request. The form mounts
 * with the dialog, so every opening starts clean.
 */
export function CreateFolderDialog({
    parent,
    open,
    onOpenChange,
    onCreated,
}: {
    parent: DriveNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onCreated?: (nodes: DriveNode[]) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent>
                <CreateFolderForm
                    parent={parent}
                    onOpenChange={onOpenChange}
                    onCreated={onCreated}
                />
            </DialogContent>
        </Dialog>
    );
}

function CreateFolderForm({
    parent,
    onOpenChange,
    onCreated,
}: {
    parent: DriveNode;
    onOpenChange: (open: boolean) => void;
    onCreated?: (nodes: DriveNode[]) => void;
}) {
    const queryClient = useQueryClient();
    const id = useId();
    const [value, setValue] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const segments = splitPath(value);

    async function submit() {
        if (!segments.length) {
            setError('Enter a folder name.');
            return;
        }
        setPending(true);
        setError('');
        try {
            const nodes = await driveClient.createFolderPath(parent, segments);
            await invalidateFolders(queryClient, parent.id);
            cue('success');
            onCreated?.(nodes);
            onOpenChange(false);
        } catch (error) {
            cue('error');
            setError(driveError(error));
        } finally {
            setPending(false);
        }
    }

    return (
        <form
            className="contents"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
            noValidate
        >
            <DialogHeader>
                <DialogTitle>New folder</DialogTitle>
                <DialogDescription>
                    In {parent.parentId === null ? 'the top folder' : `“${parent.name}”`}. Separate
                    names with a slash to create folders inside folders.
                </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
                <label htmlFor={id} className="eyebrow text-muted-foreground">
                    Name
                </label>
                <Input
                    id={id}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    placeholder="Reports/2026"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={Boolean(error)}
                    aria-describedby={`${id}-hint`}
                    maxLength={2048}
                />
                <p
                    id={`${id}-hint`}
                    role={error ? 'alert' : undefined}
                    className={`font-mono text-[11px] leading-relaxed ${error ? 'text-destructive' : 'text-muted-foreground'}`}
                >
                    {error ||
                        (segments.length > 1
                            ? `Creates ${segments.length} folders: ${segments.join(' › ')}`
                            : 'Names stay encrypted; only you can read them.')}
                </p>
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
                <Button type="submit" disabled={pending}>
                    <PendingLabel pending={pending} idle="Create" busy="Creating" />
                </Button>
            </DialogFooter>
        </form>
    );
}

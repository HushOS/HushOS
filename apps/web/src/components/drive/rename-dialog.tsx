import type { DriveNode } from '@hushos/drive/client';
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

export function RenameDialog({
    node,
    siblings = [],
    open,
    onOpenChange,
}: {
    node: DriveNode | null;
    /* The other names in the same folder, so a taken name is caught before it is sent. */
    siblings?: DriveNode[];
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={open && node !== null} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[440px]">
                {node && <RenameForm node={node} siblings={siblings} onOpenChange={onOpenChange} />}
            </DialogContent>
        </Dialog>
    );
}

function RenameForm({
    node,
    siblings,
    onOpenChange,
}: {
    node: DriveNode;
    siblings: DriveNode[];
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const id = useId();
    const [value, setValue] = useState(node.name);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const name = value.trim();
    const taken =
        name !== node.name &&
        siblings.some(
            (other) => other.id !== node.id && other.name.toLowerCase() === name.toLowerCase(),
        );
    // Said as the name is typed, so the button never fails for a reason it could have shown.
    const problem = !name
        ? 'Enter a name.'
        : taken
          ? `“${name}” is already in this folder. Try another name.`
          : '';
    const shown = problem || error;

    async function submit() {
        if (problem) return;
        if (name === node.name) {
            onOpenChange(false);
            return;
        }
        setPending(true);
        setError('');
        try {
            const renamed = await driveClient.rename(node, name);
            await invalidateFolders(queryClient, renamed.parentId);
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
        <form
            className="contents"
            onSubmit={(event) => {
                event.preventDefault();
                void submit();
            }}
            noValidate
        >
            <DialogHeader>
                <DialogTitle>Rename</DialogTitle>
                <DialogDescription className="sr-only">
                    A new name for “{node.name}”.
                </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
                <label htmlFor={id} className="sr-only">
                    Name
                </label>
                <Input
                    ref={(element) => {
                        // Select the stem, not the extension, the way desktops do.
                        if (!element || element.dataset.selected) return;
                        element.dataset.selected = 'true';
                        const dot = node.kind === 'file' ? node.name.lastIndexOf('.') : -1;
                        element.setSelectionRange(0, dot > 0 ? dot : node.name.length);
                    }}
                    id={id}
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={Boolean(shown)}
                    aria-describedby={shown ? `${id}-problem` : undefined}
                    maxLength={255}
                    className="h-11 text-[15px]"
                />
                {shown && (
                    <p id={`${id}-problem`} role="alert" className="text-[13px] text-destructive">
                        {shown}
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
                <Button type="submit" disabled={pending || Boolean(problem)}>
                    <PendingLabel pending={pending} idle="Rename" busy="Renaming" />
                </Button>
            </DialogFooter>
        </form>
    );
}

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
    open,
    onOpenChange,
}: {
    node: DriveNode | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <Dialog open={open && node !== null} onOpenChange={onOpenChange}>
            <DialogContent>
                {node && <RenameForm node={node} onOpenChange={onOpenChange} />}
            </DialogContent>
        </Dialog>
    );
}

function RenameForm({
    node,
    onOpenChange,
}: {
    node: DriveNode;
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const id = useId();
    const [value, setValue] = useState(node.name);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');

    async function submit() {
        const name = value.trim();
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
                <DialogTitle>Rename {node.kind === 'folder' ? 'folder' : 'file'}</DialogTitle>
                <DialogDescription>
                    The new name is encrypted before it leaves this device.
                </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
                <label htmlFor={id} className="eyebrow text-muted-foreground">
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
                    aria-invalid={Boolean(error)}
                    maxLength={255}
                />
                {error && (
                    <p role="alert" className="font-mono text-[11px] text-destructive">
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
    );
}

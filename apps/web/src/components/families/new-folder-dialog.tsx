import { checkName } from '@hushos/drive/client';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { afterFamilyChange } from '@/lib/families';
import { errorCopy, outcomeCopy } from '@/lib/groups/copy';
import { createFamilyFolder } from '@/lib/spaces';
import { cue } from '@/lib/sounds';

/*
 * "New family folder" (route 21), for those who manage the family: a member
 * list change of its own that lists the folder's key, with the key granted to
 * everyone in the family, sent at once. The folder lands with its top folder,
 * named here and sealed on this device.
 */
export function NewFamilyFolderDialog({
    userId,
    groupId,
    family,
    open,
    onOpenChange,
}: {
    userId: string;
    groupId: string;
    family: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const id = useId();
    const queryClient = useQueryClient();
    const [name, setName] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');

    async function submit(event: FormEvent) {
        event.preventDefault();
        setPending(true);
        setError('');
        try {
            const clean = checkName(name);
            const staged = await createFamilyFolder(userId, groupId, clean);
            const failed =
                staged.status === 'sent'
                    ? outcomeCopy(staged.outcome, { family })
                    : staged.status === 'not-synced'
                      ? staged.sync.status === 'fork'
                          ? `${family}’s member list was shown differently to you.`
                          : `Couldn’t check ${family}. Try again.`
                      : 'Couldn’t make the folder. Try again.';
            if (failed) throw new Error(failed);
            cue('success');
            toast.add({
                type: 'success',
                title: `“${clean}” is ready`,
                description: `Everyone in ${family} can open it.`,
            });
            setName('');
            onOpenChange(false);
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family }));
        } finally {
            setPending(false);
            await afterFamilyChange(queryClient, userId);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle>New family folder</DialogTitle>
                    <DialogDescription>
                        Everyone in {family} can open it, and anyone who joins later.
                    </DialogDescription>
                </DialogHeader>
                <form
                    noValidate
                    onSubmit={(event) => void submit(event)}
                    className="flex flex-col gap-4"
                >
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor={id} className="text-[13px] font-semibold">
                            Name
                        </label>
                        <Input
                            id={id}
                            autoComplete="off"
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="Photos"
                            aria-invalid={Boolean(error) || undefined}
                            aria-describedby={error ? `${id}-error` : undefined}
                        />
                        {error && (
                            <p
                                id={`${id}-error`}
                                role="alert"
                                className="text-[13px] text-destructive"
                            >
                                {error}
                            </p>
                        )}
                    </div>
                    <div className="flex justify-end gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            disabled={pending}
                            onClick={() => onOpenChange(false)}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={pending || !name.trim()}>
                            {pending ? 'Creating…' : 'Create folder'}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

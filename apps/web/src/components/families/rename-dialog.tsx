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
import { groupsApi } from '@/lib/groups/api';
import { errorCopy } from '@/lib/groups/copy';
import { cue } from '@/lib/sounds';

/*
 * Renaming the family (route 4, for those who manage it): the name prefilled, Save. The new
 * name shows wherever the family's name does once the families are read again, the sidebar
 * included; the server refuses anyone who doesn't manage the family, and an empty or overlong
 * name, in its own words. Mounted only while open, so each opening starts from the name as it
 * is then.
 */
export function RenameFamilyDialog({
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
    const [name, setName] = useState(family);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const trimmed = name.trim();

    async function submit(event: FormEvent) {
        event.preventDefault();
        if (!trimmed || trimmed === family) return;
        setPending(true);
        setError('');
        try {
            await groupsApi.rename(groupId, trimmed);
            await afterFamilyChange(queryClient, userId);
            cue('success');
            toast.add({ type: 'success', title: `Renamed to ${trimmed}` });
            onOpenChange(false);
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family }));
        } finally {
            setPending(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle>Rename family</DialogTitle>
                    <DialogDescription>
                        Everyone in the family sees the new name, and so does the server.
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
                            maxLength={100}
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            disabled={pending}
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
                        <Button type="submit" disabled={pending || !trimmed || trimmed === family}>
                            {pending ? 'Saving…' : 'Save'}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

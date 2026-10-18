import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
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
import { useBillingEnabled } from '@/lib/queries';
import { afterFamilyChange, familiesQueryOptions, familyContext } from '@/lib/families';
import { createInFamilyCopy, errorCopy, outcomeCopy } from '@/lib/groups/copy';
import { createFamily } from '@/lib/groups/outbox';
import { cue } from '@/lib/sounds';

/*
 * "Create a family": one name, then the worker makes the family's keys, its
 * member list with you as organizer and the first shared folder ("Family"),
 * and the outbox sends it. A creation that could not reach the server stays
 * on this device and is sent again on the next visit: said, not hidden.
 * Someone already in a family is told to leave it first, before any keys are
 * made (one family per account); the server refuses it too.
 */
export function CreateFamilyDialog({
    userId,
    open,
    onOpenChange,
}: {
    userId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const id = useId();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    // Where plans are sold, a family chooses one before anyone can join (docs/groups-design.md 3.5).
    const billing = useBillingEnabled();
    const [name, setName] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const yours = useQuery(familiesQueryOptions(userId)).data?.find(
        (at) => at.kind === 'family' && at.state === 'active',
    );
    const refusal = yours ? createInFamilyCopy(yours.name) : '';

    async function submit(event: FormEvent) {
        event.preventDefault();
        const trimmed = name.trim();
        if (!trimmed || yours) return;
        setPending(true);
        setError('');
        try {
            const { groupId, outcome } = await createFamily(familyContext(userId), trimmed);
            void afterFamilyChange(queryClient, userId);
            if (outcome.status === 'landed') {
                cue('success');
                toast.add({ type: 'success', title: `${trimmed} created` });
                onOpenChange(false);
                setName('');
                await navigate({ to: '/app/families/$groupId', params: { groupId } });
                return;
            }
            if (outcome.status === 'pending') {
                toast.add({
                    type: 'info',
                    title: 'Saved on this device',
                    description:
                        'HushOS couldn’t reach the server. It finishes creating the family when it can.',
                });
                onOpenChange(false);
                return;
            }
            cue('error');
            setError(outcomeCopy(outcome, { family: trimmed }) ?? '');
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family: trimmed }));
        } finally {
            setPending(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle>Create a family</DialogTitle>
                    <DialogDescription>
                        {refusal ||
                            (billing
                                ? 'You’ll be its organizer. Then choose a plan and invite people by email.'
                                : 'You’ll be its organizer. Then invite people by email.')}
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
                            placeholder="Lindqvist family"
                            disabled={Boolean(yours)}
                            aria-invalid={Boolean(error) || undefined}
                            aria-describedby={`${id}-hint`}
                        />
                        <p
                            id={`${id}-hint`}
                            role={error ? 'alert' : undefined}
                            className={`text-[13px] ${error ? 'text-destructive' : 'text-muted-foreground'}`}
                        >
                            {error || 'Everyone you invite sees this name, and so does the server.'}
                        </p>
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
                        <Button type="submit" disabled={pending || !name.trim() || Boolean(yours)}>
                            {pending ? 'Creating…' : 'Create family'}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

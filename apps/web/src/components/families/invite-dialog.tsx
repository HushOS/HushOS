import { INVITATION_DAYS } from '@hushos/groups/protocol';
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
import { familyKeys } from '@/lib/families';
import { GroupApiError, groupsApi } from '@/lib/groups/api';
import { errorCopy } from '@/lib/groups/copy';
import { cue } from '@/lib/sounds';

/*
 * "Invite someone": the server mails a link to the address. Accepting it does
 * not let anyone in: they wait until a manager checks it's them and reads
 * them the join code.
 */
export function InviteDialog({
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
    const [email, setEmail] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    // Only an address the server can't use marks the field: not a dropped connection, a full
    // family, or an address that already has an open invitation (that one is cancelled instead).
    const [badAddress, setBadAddress] = useState(false);

    async function submit(event: FormEvent) {
        event.preventDefault();
        const address = email.trim();
        if (!address) return;
        setPending(true);
        setError('');
        setBadAddress(false);
        try {
            await groupsApi.invite(groupId, address, []);
            cue('success');
            toast.add({ type: 'success', title: `Invitation sent to ${address}` });
            void queryClient.invalidateQueries({
                queryKey: familyKeys.invitations(userId, groupId),
            });
            setEmail('');
            onOpenChange(false);
        } catch (cause) {
            cue('error');
            const refused = cause instanceof GroupApiError ? cause.code : null;
            setBadAddress(refused === 'invalid' || refused === 'already-member');
            setError(
                refused === 'invalid'
                    ? 'Enter their whole email address, like them@example.com.'
                    : errorCopy(cause, { family }),
            );
        } finally {
            setPending(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="sm:max-w-[440px]">
                <DialogHeader>
                    <DialogTitle>Invite someone</DialogTitle>
                    <DialogDescription>
                        They’ll get an email with a link. Once they accept, you check it’s them
                        before they join.
                    </DialogDescription>
                </DialogHeader>
                <form
                    noValidate
                    onSubmit={(event) => void submit(event)}
                    className="flex flex-col gap-4"
                >
                    <div className="flex flex-col gap-1.5">
                        <label htmlFor={id} className="text-[13px] font-semibold">
                            Email
                        </label>
                        <Input
                            id={id}
                            type="email"
                            autoComplete="off"
                            spellCheck={false}
                            value={email}
                            onChange={(event) => {
                                // The message was about the address as it was: it goes as it changes.
                                setEmail(event.target.value);
                                setError('');
                                setBadAddress(false);
                            }}
                            placeholder="them@example.com"
                            aria-invalid={badAddress || undefined}
                            aria-describedby={`${id}-hint`}
                        />
                        <p
                            id={`${id}-hint`}
                            role={error ? 'alert' : undefined}
                            className={`text-[13px] ${error ? 'text-destructive' : 'text-muted-foreground'}`}
                        >
                            {error || `The invitation is open for ${INVITATION_DAYS} days.`}
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
                        <Button type="submit" disabled={pending || !email.trim()}>
                            {pending ? 'Sending…' : 'Send invitation'}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}

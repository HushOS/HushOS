import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { addContact, type AccountChange, type Pin as ContactPin } from '@/lib/contacts';
import { driveKeys } from '@/lib/drive';
import { afterTrustChanged } from '@/lib/integrity';
import { cue } from '@/lib/sounds';

/*
 * Add someone (docs/optional-verification.md 6.2): their email, Add, and they
 * are a contact at once, remembered with the keys HushOS serves for them now.
 * No words: checking it's them is a later, optional step (Check it's Maya).
 * Someone already added is said so in the hint; an account that changed since
 * this device last saw it goes to the changed-account notice instead.
 */
export function AddSomeone({
    userId,
    writer,
    onAdded,
    onChanged,
    onCancel,
}: {
    userId: string;
    /*
     * The account that wrote an Unverified item, from its mark: the server
     * names writers by id alone, so the person types the address and an
     * account that is not the writer is said to be so.
     */
    writer?: string;
    onAdded: (pin: ContactPin) => void;
    onChanged: (change: AccountChange) => void;
    onCancel: () => void;
}) {
    const queryClient = useQueryClient();
    const id = useId();
    const [email, setEmail] = useState('');
    const [adding, setAdding] = useState(false);
    const [hint, setHint] = useState<{ text: string; error: boolean } | null>(null);

    async function add() {
        const address = email.trim();
        if (!address) return;
        setAdding(true);
        setHint(null);
        try {
            const added = await addContact(queryClient, userId, address, writer);
            if (added.outcome === 'changed') {
                onChanged(added.change);
                return;
            }
            if (added.outcome === 'already') {
                setHint({
                    text: `${firstName(added.pin.name)} is already in your contacts.`,
                    error: false,
                });
                return;
            }
            // What they wrote now reads as theirs, and what they shared opens.
            afterTrustChanged(queryClient);
            void queryClient.invalidateQueries({ queryKey: driveKeys.shared });
            cue('success');
            onAdded(added.pin);
        } catch (cause) {
            cue('error');
            setHint({
                text: cause instanceof Error ? cause.message : 'Check the address and try again.',
                error: true,
            });
        } finally {
            setAdding(false);
        }
    }

    return (
        <form
            noValidate
            className="flex flex-col gap-4"
            onSubmit={(event) => {
                event.preventDefault();
                void add();
            }}
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
                        setEmail(event.target.value);
                        setHint(null);
                    }}
                    placeholder="them@example.com"
                    aria-invalid={hint?.error || undefined}
                    aria-describedby={`${id}-hint`}
                    className="text-[15px]"
                />
                <p
                    id={`${id}-hint`}
                    role={hint?.error ? 'alert' : undefined}
                    aria-live="polite"
                    className={`text-[13px] ${hint?.error ? 'text-destructive' : 'text-muted-foreground'}`}
                >
                    {hint?.text ?? 'The email they use for HushOS.'}
                </p>
            </div>
            <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={onCancel}>
                    Cancel
                </Button>
                <Button type="submit" disabled={adding || !email.trim()}>
                    {adding ? 'Adding…' : 'Add'}
                </Button>
            </div>
        </form>
    );
}

export function firstName(name: string) {
    return name.trim().split(/\s+/)[0] || name;
}

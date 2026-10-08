import type { ContactPin } from '@hushos/auth/api';
import { useQueryClient } from '@tanstack/react-query';
import { ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { FingerprintWords } from '@/components/fingerprint-words';
import { PersonAvatar } from '@/components/person-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDay } from '@/lib/drive';
import { lookupContact, pinContact, settingsQueryOptions, type Lookup } from '@/lib/contacts';
import { cue } from '@/lib/sounds';

/*
 * Adding someone: look them up by email, then check it's them. The server hands
 * over their key; the fingerprint is how a person knows it is really theirs, read
 * aloud by the other person from their own People you share with page. Nobody is
 * added until "They match". Used from the share dialog, so sharing never has to
 * stop for it, and from People you share with.
 */
export function CheckContact({
    userId,
    email: initialEmail = '',
    onAdded,
    onCancel,
}: {
    userId: string;
    /* Looked up at once when given, as from the share dialog's field. */
    email?: string;
    onAdded: (pin: ContactPin) => void;
    onCancel: () => void;
}) {
    const queryClient = useQueryClient();
    const id = useId();
    const [email, setEmail] = useState(initialEmail);
    const [looking, setLooking] = useState(false);
    const [adding, setAdding] = useState(false);
    const [found, setFound] = useState<Lookup | null>(null);
    const [error, setError] = useState('');
    const [mismatch, setMismatch] = useState(false);

    async function lookup(address = email.trim()) {
        if (!address) return;
        setLooking(true);
        setError('');
        setFound(null);
        setMismatch(false);
        try {
            setFound(await lookupContact(queryClient, userId, address));
        } catch (cause) {
            cue('error');
            setError(cause instanceof Error ? cause.message : 'Check the address and try again.');
        } finally {
            setLooking(false);
        }
    }
    const started = useRef(false);
    useEffect(() => {
        if (started.current || !initialEmail) return;
        started.current = true;
        void lookup(initialEmail);
        // Only the email it was opened with is looked up by itself.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialEmail]);

    async function add() {
        if (!found) return;
        setAdding(true);
        setError('');
        try {
            await pinContact(queryClient, userId, found);
            const loaded = await queryClient.fetchQuery(settingsQueryOptions(userId));
            const pin = loaded.settings.contacts[found.contact.userId];
            if (!pin) throw new Error('They weren’t saved. Try again.');
            cue('success');
            onAdded(pin);
        } catch (cause) {
            cue('error');
            setError(cause instanceof Error ? cause.message : 'They weren’t saved. Try again.');
        } finally {
            setAdding(false);
        }
    }

    const first = found ? (found.contact.name.trim().split(/\s+/)[0] ?? found.contact.name) : '';
    const alreadyAdded = found !== null && found.pinned !== null && !found.changed;
    const unsignedKem = found?.kem !== null && found?.kem !== undefined && !found.kem.valid;

    if (!found)
        return (
            <form
                noValidate
                className="flex flex-col gap-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void lookup();
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
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="them@example.com"
                        aria-invalid={Boolean(error) || undefined}
                        aria-describedby={`${id}-hint`}
                        className="text-[15px]"
                    />
                    <p
                        id={`${id}-hint`}
                        role={error ? 'alert' : undefined}
                        className={`text-[13px] ${error ? 'text-destructive' : 'text-muted-foreground'}`}
                    >
                        {error || 'The email they use for HushOS.'}
                    </p>
                </div>
                <div className="flex justify-end gap-2">
                    <Button type="button" variant="outline" onClick={onCancel}>
                        Cancel
                    </Button>
                    <Button type="submit" disabled={looking || !email.trim()}>
                        {looking ? 'Looking up…' : 'Look up'}
                    </Button>
                </div>
            </form>
        );

    return (
        <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
                <PersonAvatar name={found.contact.name} seed={found.contact.userId} size={44} />
                <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[15px] font-semibold">{found.contact.name}</span>
                    <span className="truncate text-[13px] text-muted-foreground">
                        {found.contact.email}
                    </span>
                </div>
            </div>
            {found.changed ? (
                <p
                    role="alert"
                    className="flex items-start gap-2.5 rounded-xl bg-destructive-soft px-3.5 py-3 text-sm text-destructive"
                >
                    <ShieldAlertIcon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span>
                        {first}’s account has changed since you added them on{' '}
                        {formatDay(found.pinned!.pinnedAt)}. That can be a new phone or a reset, or
                        someone pretending. Check it’s them before you accept.
                    </span>
                </p>
            ) : (
                <p className="text-sm leading-snug text-muted-foreground">
                    Ask {first} to open People you share with in HushOS and read you their twelve
                    words, on a call or in person. If they match these, it’s really them.
                </p>
            )}
            <FingerprintWords fingerprint={found.fingerprint} />
            <p
                data-kem={found.kem ? (found.kem.valid ? 'signed' : 'unsigned') : 'none'}
                className={unsignedKem ? 'text-[13px] text-destructive' : 'sr-only'}
            >
                {unsignedKem
                    ? `${first}’s newest key isn’t signed by their account. Don’t add them; ask them to sign in again first.`
                    : found.kem
                      ? 'Their newest key is signed by their account.'
                      : 'They get their newest key the next time they sign in.'}
            </p>
            {mismatch && (
                <p role="alert" className="text-[13px] text-destructive">
                    Don’t share with this account. Check the email address with {first}, then try
                    again.
                </p>
            )}
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
                {alreadyAdded ? (
                    <>
                        <Button variant="outline" onClick={onCancel}>
                            Cancel
                        </Button>
                        <Button onClick={() => onAdded(found.pinned!)}>
                            Already in your contacts
                        </Button>
                    </>
                ) : (
                    <>
                        <Button
                            variant="outline"
                            disabled={adding}
                            onClick={() => (mismatch ? onCancel() : setMismatch(true))}
                        >
                            {mismatch ? 'Back' : 'They don’t match'}
                        </Button>
                        <Button
                            variant={found.changed ? 'destructive' : 'default'}
                            disabled={adding || unsignedKem || mismatch}
                            onClick={() => void add()}
                        >
                            <ShieldCheckIcon />
                            {adding ? 'Adding…' : found.changed ? 'Accept change' : 'They match'}
                        </Button>
                    </>
                )}
            </div>
        </div>
    );
}

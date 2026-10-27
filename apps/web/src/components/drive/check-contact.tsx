import { useQueryClient } from '@tanstack/react-query';
import { ShieldAlertIcon, ShieldCheckIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { FingerprintWords } from '@/components/fingerprint-words';
import { Spinner } from '@/components/motion';
import { PersonAvatar } from '@/components/person-avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { driveKeys, formatDay } from '@/lib/drive';
import {
    lookupContact,
    pinContact,
    replacementUnseen,
    settingsQueryOptions,
    type Lookup,
    type Pin as ContactPin,
} from '@/lib/contacts';
import { vouchLine } from '@/lib/family-pin';
import { cue } from '@/lib/sounds';

/*
 * Adding someone: look them up by email, then check it's them. The server hands
 * over their key; the fingerprint is how a person knows it is really theirs, read
 * aloud by the other person from their own Contacts page. Nobody is
 * added until "They match". Used from the share dialog, so sharing never has to
 * stop for it, and from Contacts.
 */
export function CheckContact({
    userId,
    email: initialEmail = '',
    writer,
    recheck = false,
    onAdded,
    onCancel,
}: {
    userId: string;
    /* Looked up at once when given, as from the share dialog's field. */
    email?: string;
    /*
     * The account that wrote an Unverified item, from its mark: the server
     * names writers by id alone, so the person types the address and an
     * account that is not the writer is said to be so.
     */
    writer?: string;
    /* Comparing words again with someone already added: "They match" saves the check afresh. */
    recheck?: boolean;
    onAdded: (pin: ContactPin) => void;
    onCancel: () => void;
}) {
    const queryClient = useQueryClient();
    const id = useId();
    const [email, setEmail] = useState(initialEmail);
    // Opened on someone's address, the lookup runs before anything shows: the email form only
    // appears if it fails, so the address can be corrected (a phone's password manager would
    // otherwise light up on a field nobody is meant to type in).
    const [asking, setAsking] = useState(!initialEmail);
    const [looking, setLooking] = useState(Boolean(initialEmail));
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
            setAsking(true);
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
            // What they shared, waiting on this check, opens now.
            void queryClient.invalidateQueries({ queryKey: driveKeys.shared });
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
    // A pin taken on a family's word is not this person's check: the words are compared like
    // anyone new's (pinContact then makes it their own and drops the family's mark).
    const familyVouched = found?.pinned ? vouchLine(found.pinned) : null;
    const alreadyAdded =
        !recheck &&
        found !== null &&
        found.pinned !== null &&
        familyVouched === null &&
        !found.changed &&
        !found.stale;
    // Words can only be compared over an upgraded identity whose keys statement holds.
    const notUpgraded = found !== null && !found.upgraded;
    const notWriter =
        writer !== undefined &&
        found !== null &&
        found.contact.userId.toLowerCase() !== writer.toLowerCase();

    if (!found && !asking)
        return (
            <div className="flex flex-col gap-4">
                <output className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="size-4" />
                    Getting their words
                </output>
                <div className="flex justify-end">
                    <Button type="button" variant="outline" onClick={onCancel}>
                        Cancel
                    </Button>
                </div>
            </div>
        );

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
            ) : found.followed || (recheck && found.pinned && replacementUnseen(found.pinned)) ? (
                <p className="text-sm leading-snug">
                    {first} replaced their sharing keys; the change is signed by their previous
                    keys. To be sure it was them, ask {first} to open Contacts in HushOS, choose
                    Your twelve words, and read them to you.
                </p>
            ) : notUpgraded ? (
                <p className="text-sm leading-snug text-muted-foreground">
                    {first} hasn’t signed in since HushOS upgraded its keys. You can compare words
                    once they have.
                </p>
            ) : found.stale ? (
                <p className="text-sm leading-snug text-muted-foreground">
                    You added {first} before the twelve words covered all of their keys. Ask {first}{' '}
                    to open Contacts in HushOS, choose Your twelve words, and read them to you, on a
                    call or in person. Until you do, nothing is shared with {first} and what they
                    share with you stays shut.
                </p>
            ) : (
                <p className="text-sm leading-snug text-muted-foreground">
                    {familyVouched && <span data-vouched>{familyVouched}. </span>}
                    Ask {first} to open Contacts in HushOS, choose Your twelve words, and read them
                    to you, on a call or in person. If they match these, it’s really them.
                </p>
            )}
            {found.fingerprint && <FingerprintWords fingerprint={found.fingerprint} />}
            <p data-keys={found.upgraded ? 'signed' : 'not-upgraded'} className="sr-only">
                {found.upgraded
                    ? 'All four of their keys are signed by their account.'
                    : 'Their keys are not upgraded yet.'}
            </p>
            {notWriter && (
                <p role="alert" className="text-[13px] text-destructive">
                    This isn’t the account that wrote it. Check the address, then look them up
                    again.
                </p>
            )}
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
                            disabled={adding || notUpgraded || mismatch || notWriter}
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

import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlertIcon, Trash2Icon, UserPlusIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { CopyValue } from '@/components/copy-value';
import { useDrive } from '@/components/drive/drive-shell';
import { PendingLabel, Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import {
    lookupContact,
    ownFingerprintQueryOptions,
    pinContact,
    removeContact,
    settingsQueryOptions,
    type Lookup,
} from '@/lib/contacts';
import { formatWhen } from '@/lib/drive';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/_drive/contacts')({
    head: () => ({ meta: [{ title: 'Contacts · HushOS' }] }),
    component: ContactsPage,
});

/*
 * Contacts are the people a person can share with. Each is pinned with the
 * identity key seen the first time, and its fingerprint, so both sides can
 * compare over a call or in person before anything is shared. A changed key is
 * shown as a warning to accept, never applied quietly.
 */
function ContactsPage() {
    return (
        <>
            <Contacts />
        </>
    );
}

function message(error: unknown) {
    return error instanceof Error ? error.message : 'Please try again.';
}

function Contacts() {
    const { userId } = useDrive();
    const queryClient = useQueryClient();
    const own = useQuery(ownFingerprintQueryOptions(userId));
    const settings = useQuery(settingsQueryOptions(userId));
    const [removing, setRemoving] = useState<string | null>(null);
    const contacts = Object.values(settings.data?.settings.contacts ?? {}).sort((a, b) =>
        a.name.localeCompare(b.name),
    );

    async function remove(contactId: string, name: string) {
        setRemoving(contactId);
        try {
            await removeContact(queryClient, userId, contactId);
            cue('droplet');
            toast.add({ type: 'success', title: `“${name}” removed from your contacts` });
        } catch (error) {
            cue('error');
            toast.add({ type: 'error', title: 'Could not remove', description: message(error) });
        } finally {
            setRemoving(null);
        }
    }

    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                eyebrow="Account"
                title="Contacts"
                description="People you can share with. Compare fingerprints over a call or in person before you share anything: the server hands you their key, and the fingerprint is how you know it is really theirs."
            />
            <div className="flex max-w-3xl flex-col gap-10 px-5 py-6 sm:px-8 sm:py-8">
                <section className="flex flex-col gap-3">
                    <h2 className="text-lg font-bold">Your fingerprint</h2>
                    <div className="rounded-md bg-muted px-4 py-3.5 font-mono text-[13px] wrap-anywhere">
                        {own.isPending ? (
                            <Spinner className="size-4 text-muted-foreground" />
                        ) : own.isError ? (
                            <span className="font-sans text-sm text-destructive">
                                {message(own.error)}
                            </span>
                        ) : (
                            <CopyValue value={own.data} label="Your fingerprint" />
                        )}
                    </div>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                        Read this to the person adding you; theirs should match what you see below.
                    </p>
                </section>

                <AddContact userId={userId} />

                <section className="flex flex-col gap-3">
                    <h2 className="text-lg font-bold">
                        Pinned {contacts.length ? `(${contacts.length})` : ''}
                    </h2>
                    {settings.isPending && (
                        <div className="flex h-12 items-center">
                            <Spinner className="size-4 text-muted-foreground" />
                        </div>
                    )}
                    {settings.isError && (
                        <p className="rounded-md bg-destructive-soft px-4 py-3 text-sm text-destructive">
                            {message(settings.error)}
                        </p>
                    )}
                    {settings.data && contacts.length === 0 && (
                        <p className="text-sm text-muted-foreground">Nobody pinned yet.</p>
                    )}
                    {contacts.length > 0 && (
                        <ul className="divide-y divide-rule rounded-md border border-rule">
                            {contacts.map((contact) => (
                                <li
                                    key={contact.userId}
                                    data-contact={contact.email}
                                    className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted"
                                >
                                    <span
                                        aria-hidden="true"
                                        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-accent-foreground"
                                    >
                                        {contact.name.trim().charAt(0).toUpperCase()}
                                    </span>
                                    <div className="min-w-0 flex-1">
                                        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                                            <span className="font-medium wrap-anywhere">
                                                {contact.name}
                                            </span>
                                            <Badge variant="success">
                                                Pinned {formatWhen(contact.pinnedAt)}
                                            </Badge>
                                            {contact.kemPublicKeyHash && (
                                                <Badge variant="outline">Post-quantum</Badge>
                                            )}
                                        </p>
                                        <p className="mt-1 font-mono text-[11px] leading-relaxed wrap-anywhere text-muted-foreground">
                                            {contact.email}
                                            <br />
                                            {contact.fingerprint}
                                        </p>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="xs"
                                        aria-label={`Remove ${contact.name}`}
                                        disabled={removing !== null}
                                        onClick={() => void remove(contact.userId, contact.name)}
                                    >
                                        <Trash2Icon />
                                        <span className="max-sm:sr-only">Remove</span>
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </section>
            </div>
        </div>
    );
}

/* Look someone up, see their fingerprint, pin. A found person is not pinned until the click. */
function AddContact({ userId }: { userId: string }) {
    const queryClient = useQueryClient();
    const id = useId();
    const [email, setEmail] = useState('');
    const [looking, setLooking] = useState(false);
    const [pinning, setPinning] = useState(false);
    const [error, setError] = useState('');
    const [found, setFound] = useState<Lookup | null>(null);

    async function lookup() {
        const address = email.trim();
        if (!address) return;
        setLooking(true);
        setError('');
        setFound(null);
        try {
            setFound(await lookupContact(queryClient, userId, address));
        } catch (error) {
            cue('error');
            setError(message(error));
        } finally {
            setLooking(false);
        }
    }
    async function pin() {
        if (!found) return;
        setPinning(true);
        try {
            await pinContact(queryClient, userId, found);
            cue('success');
            toast.add({
                type: 'success',
                title: found.changed
                    ? `New key accepted for “${found.contact.name}”`
                    : `“${found.contact.name}” pinned`,
            });
            setFound(null);
            setEmail('');
        } catch (error) {
            cue('error');
            setError(message(error));
        } finally {
            setPinning(false);
        }
    }

    const unchanged = found?.pinned !== null && found?.changed === false;
    return (
        <section className="flex flex-col gap-3">
            <h2 className="text-lg font-bold">Add a contact</h2>
            <form
                noValidate
                className="flex flex-col gap-3"
                onSubmit={(event) => {
                    event.preventDefault();
                    void lookup();
                }}
            >
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor={id}>Email</Label>
                    <Input
                        id={id}
                        type="email"
                        autoComplete="off"
                        spellCheck={false}
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        placeholder="them@example.com"
                        aria-invalid={Boolean(error) || undefined}
                        className="max-w-md"
                    />
                </div>
                {error && (
                    <p
                        role="alert"
                        className="rounded-md bg-destructive-soft px-3 py-2 text-sm leading-relaxed text-destructive"
                    >
                        {error}
                    </p>
                )}
                {found && (
                    <div className="rounded-md border border-rule px-4 py-3.5">
                        <p className="text-sm font-medium">{found.contact.name}</p>
                        <p className="font-mono text-[11px] text-muted-foreground">
                            {found.contact.email}
                        </p>
                        <p
                            className="mt-3 rounded-md bg-muted px-3 py-2.5 font-mono text-[13px] wrap-anywhere"
                            data-fingerprint
                        >
                            {found.fingerprint}
                        </p>
                        <p
                            className="mt-2 text-xs leading-relaxed text-muted-foreground"
                            data-kem={
                                found.kem ? (found.kem.valid ? 'signed' : 'unsigned') : 'none'
                            }
                        >
                            {found.kem
                                ? found.kem.valid
                                    ? 'Post-quantum key present, signed by this identity.'
                                    : 'Post-quantum key present but not signed by this identity. Do not pin.'
                                : 'No post-quantum key yet; they get one the next time they sign in.'}
                        </p>
                        {found.changed && (
                            <p
                                role="alert"
                                className="mt-3 flex items-start gap-2 rounded-md bg-destructive-soft px-3 py-2 text-xs leading-relaxed text-destructive"
                            >
                                <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                                <span>
                                    This key differs from the one you pinned on{' '}
                                    {formatWhen(found.pinned!.pinnedAt)}. Confirm the new
                                    fingerprint with them directly before accepting; a changed key
                                    can mean a reinstalled account or someone in the middle.
                                </span>
                            </p>
                        )}
                        {unchanged && (
                            <p className="mt-3 text-xs text-muted-foreground">
                                Already pinned with this key.
                            </p>
                        )}
                    </div>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    {found && !unchanged ? (
                        <Button
                            type="button"
                            variant={found.changed ? 'destructive' : 'default'}
                            onClick={() => void pin()}
                            disabled={pinning}
                        >
                            <PendingLabel
                                pending={pinning}
                                idle={found.changed ? 'Accept new key' : 'Pin contact'}
                                busy="Saving"
                            />
                            <UserPlusIcon aria-hidden="true" />
                        </Button>
                    ) : (
                        <Button type="submit" disabled={looking || !email.trim()}>
                            <PendingLabel pending={looking} idle="Look up" busy="Looking up" />
                            <UserPlusIcon aria-hidden="true" />
                        </Button>
                    )}
                    <p className="text-sm text-muted-foreground">
                        {found
                            ? 'Compare the fingerprint with them, then pin.'
                            : 'By their HushOS email.'}
                    </p>
                </div>
            </form>
        </section>
    );
}

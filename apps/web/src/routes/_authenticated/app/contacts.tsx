import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShieldAlertIcon, Trash2Icon, UserPlusIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { CopyValue } from '@/components/copy-value';
import { DriveShell, useDrive } from '@/components/drive/drive-shell';
import { FormActions, FormNote, FormRow, FormTable } from '@/components/form-rows';
import { PendingLabel, Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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

export const Route = createFileRoute('/_authenticated/app/contacts')({
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
    const { user } = Route.useRouteContext();
    return (
        <DriveShell user={user}>
            <Contacts />
        </DriveShell>
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
            <div className="flex flex-col gap-8 px-5 py-6 sm:px-8 sm:py-8">
                <section className="flex flex-col gap-3">
                    <h2 className="eyebrow text-muted-foreground">Your fingerprint</h2>
                    <div className="border bg-card px-4 py-3.5 font-mono text-[13px] wrap-anywhere">
                        {own.isPending ? (
                            <Spinner className="size-4 text-muted-foreground" />
                        ) : own.isError ? (
                            <span className="text-destructive">{message(own.error)}</span>
                        ) : (
                            <CopyValue value={own.data} label="Your fingerprint" />
                        )}
                    </div>
                    <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                        Read this to the person adding you; theirs should match what you see below.
                    </p>
                </section>

                <AddContact userId={userId} />

                <section className="flex flex-col gap-3">
                    <h2 className="eyebrow text-muted-foreground">
                        Pinned {contacts.length ? `(${contacts.length})` : ''}
                    </h2>
                    {settings.isPending && (
                        <div className="flex h-16 items-center border bg-card px-4">
                            <Spinner className="size-4 text-muted-foreground" />
                        </div>
                    )}
                    {settings.isError && (
                        <p className="border bg-card px-4 py-3.5 font-mono text-xs text-destructive">
                            {message(settings.error)}
                        </p>
                    )}
                    {settings.data && contacts.length === 0 && (
                        <p className="border bg-card px-4 py-3.5 font-mono text-xs text-muted-foreground">
                            Nobody pinned yet.
                        </p>
                    )}
                    {contacts.length > 0 && (
                        <ul className="border bg-card">
                            {contacts.map((contact) => (
                                <li
                                    key={contact.userId}
                                    data-contact={contact.email}
                                    className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-3 last:border-b-0"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm">{contact.name}</p>
                                        <p className="font-mono text-[11px] text-muted-foreground">
                                            {contact.email} · pinned {formatWhen(contact.pinnedAt)}
                                        </p>
                                        <p className="mt-1 font-mono text-[11px] wrap-anywhere">
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
            <h2 className="eyebrow text-muted-foreground">Add a contact</h2>
            <form
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    void lookup();
                }}
            >
                <FormTable>
                    <FormRow label="Email" htmlFor={id} invalid={Boolean(error)}>
                        <Input
                            id={id}
                            type="email"
                            autoComplete="off"
                            spellCheck={false}
                            value={email}
                            onChange={(event) => setEmail(event.target.value)}
                            placeholder="them@example.com"
                            className="h-12 border-0 bg-transparent px-4 shadow-none focus-visible:ring-0"
                        />
                    </FormRow>
                    {error && <FormNote tone="destructive">{error}</FormNote>}
                    {found && (
                        <div className="px-4 py-3.5">
                            <p className="text-sm">{found.contact.name}</p>
                            <p className="font-mono text-[11px] text-muted-foreground">
                                {found.contact.email}
                            </p>
                            <p
                                className="mt-2 font-mono text-[13px] wrap-anywhere"
                                data-fingerprint
                            >
                                {found.fingerprint}
                            </p>
                            {found.changed && (
                                <p
                                    role="alert"
                                    className="mt-3 flex items-start gap-2 bg-destructive/15 px-3 py-2 font-mono text-[11px] leading-relaxed"
                                >
                                    <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                                    <span>
                                        This key differs from the one you pinned on{' '}
                                        {formatWhen(found.pinned!.pinnedAt)}. Confirm the new
                                        fingerprint with them directly before accepting; a changed
                                        key can mean a reinstalled account or someone in the middle.
                                    </span>
                                </p>
                            )}
                            {unchanged && (
                                <p className="mt-3 font-mono text-[11px] text-muted-foreground">
                                    Already pinned with this key.
                                </p>
                            )}
                        </div>
                    )}
                    <FormActions
                        action={
                            found && !unchanged ? (
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
                                    <PendingLabel
                                        pending={looking}
                                        idle="Look up"
                                        busy="Looking up"
                                    />
                                    <UserPlusIcon aria-hidden="true" />
                                </Button>
                            )
                        }
                    >
                        {found
                            ? 'Compare the fingerprint with them, then pin.'
                            : 'By their HushOS email.'}
                    </FormActions>
                </FormTable>
            </form>
        </section>
    );
}

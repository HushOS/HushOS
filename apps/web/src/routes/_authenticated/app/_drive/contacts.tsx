import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    CheckIcon,
    EllipsisIcon,
    RotateCcwIcon,
    SearchIcon,
    ShieldCheckIcon,
    UserPlusIcon,
    UserXIcon,
} from 'lucide-react';
import { useState } from 'react';
import { AccountChangedDialog } from '@/components/drive/account-changed';
import { AddSomeone } from '@/components/drive/add-someone';
import { CheckContactDialog, type Checking } from '@/components/drive/check-contact';
import { useDrive } from '@/components/drive/drive-shell';
import { EmptyState, RowMenuButton, SkeletonRows } from '@/components/drive/file-list';
import { OwnWordsDialog } from '@/components/own-words-dialog';
import { PageHeader } from '@/components/page-header';
import { PersonAvatar } from '@/components/person-avatar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import {
    accountChangeOf,
    contactStandingsQueryOptions,
    removeContact,
    settingsQueryOptions,
    useAccountChanges,
    type AccountChange,
    type Pin as ContactPin,
} from '@/lib/contacts';
import { afterTrustChanged } from '@/lib/integrity';
import { vouchLine } from '@/lib/family-pin';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/_drive/contacts')({
    head: () => ({ meta: [{ title: 'Contacts · HushOS' }] }),
    component: People,
});

/*
 * Contacts (for a while "People you share with"). Someone added by email is a
 * contact at once, remembered with the keys HushOS serves for them then, and
 * can be shared with straight away (docs/optional-verification.md 6.5).
 * Checking it's them is a later, optional step: their twelve words, read on a
 * call or in person, make them Verified. An account that changed with no
 * signed chain is said calmly on its row, and nothing new is shared with
 * them until Review (Continue or a check). Adding works here and, so sharing
 * never stops for it, from the share sheet too.
 */
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
/* A list this long gets a filter; a shorter one fits on a screen and is found by eye. */
const FILTER_FROM = 8;

function People() {
    const { userId } = useDrive();
    const queryClient = useQueryClient();
    const settings = useQuery(settingsQueryOptions(userId));
    const standings = useQuery({
        ...contactStandingsQueryOptions(userId, settings.dataUpdatedAt),
        enabled: settings.isSuccess,
    });
    useAccountChanges();
    const [adding, setAdding] = useState(false);
    const [checking, setChecking] = useState<Checking | null>(null);
    const [reviewing, setReviewing] = useState<AccountChange | null>(null);
    const [removing, setRemoving] = useState<ContactPin | null>(null);
    const [busy, setBusy] = useState(false);
    const [showingWords, setShowingWords] = useState(false);
    const [query, setQuery] = useState('');
    const contacts = Object.values(settings.data?.settings.contacts ?? {}).sort((a, b) =>
        a.name.localeCompare(b.name),
    );
    // Kept while something is typed, so a list that shrank below the threshold never hides a filter.
    const filtering = contacts.length >= FILTER_FROM || query !== '';
    const needle = filtering ? query.trim().toLocaleLowerCase() : '';
    const shown = needle
        ? contacts.filter(
              (contact) =>
                  contact.name.toLocaleLowerCase().includes(needle) ||
                  contact.email.toLocaleLowerCase().includes(needle),
          )
        : contacts;
    const standingOf = (contact: ContactPin) =>
        standings.data?.get(contact.userId.toLowerCase()) ?? null;
    // Changed here: the settings disagree with this device, or a lookup this session found it.
    const changeOf = (contact: ContactPin): AccountChange | null =>
        accountChangeOf(userId, contact.userId) ??
        (standingOf(contact)?.changed
            ? { contactId: contact.userId, name: contact.name, email: contact.email }
            : null);

    async function remove(contact: ContactPin) {
        setBusy(true);
        try {
            await removeContact(queryClient, userId, contact.userId);
            // What they wrote no longer reads as theirs.
            afterTrustChanged(queryClient);
            cue('droplet');
            toast.add({ type: 'success', title: `${firstName(contact.name)} removed` });
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t remove them',
                description: cause instanceof Error ? cause.message : undefined,
            });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                title="Contacts"
                description="People you share with. Add someone by the email they use for HushOS."
            >
                <Button variant="outline" onClick={() => setShowingWords(true)}>
                    Your twelve words
                </Button>
                <Button onClick={() => setAdding(true)}>
                    <UserPlusIcon />
                    Add someone
                </Button>
            </PageHeader>
            {settings.isPending && <SkeletonRows rows={3} />}
            {settings.isError && (
                <EmptyState
                    title="This list couldn’t be opened"
                    body={settings.error instanceof Error ? settings.error.message : undefined}
                >
                    <Button variant="outline" onClick={() => void settings.refetch()}>
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </EmptyState>
            )}
            {/* What this device remembers couldn't be read: nobody is shown as verified, and acts wait. */}
            {standings.isError && (
                <Alert variant="warning" className="mx-5 mb-4 w-auto sm:mx-8">
                    <AlertTitle>{standings.error.message}</AlertTitle>
                    <AlertDescription>
                        <Button
                            variant="outline"
                            size="sm"
                            className="mt-1"
                            onClick={() => void standings.refetch()}
                        >
                            <RotateCcwIcon />
                            Try again
                        </Button>
                    </AlertDescription>
                </Alert>
            )}
            {settings.data && contacts.length === 0 && (
                <div className="flex flex-col border-y border-rule px-5 py-4 sm:px-8">
                    <span className="text-[15px] font-medium">Nobody here yet</span>
                    <span className="text-[13px] text-muted-foreground">
                        Add someone by their email, or add them while you share.
                    </span>
                </div>
            )}
            {filtering && (
                <div className="relative mx-5 mb-3 max-w-md sm:mx-8">
                    <SearchIcon
                        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <Input
                        type="search"
                        aria-label="Find someone by name or email"
                        placeholder="Find someone"
                        value={query}
                        onChange={(event) => setQuery(event.target.value)}
                        className="h-9 pl-9 pointer-coarse:h-11"
                    />
                </div>
            )}
            {/* Said as the list narrows, so a screen reader hears what typing found. */}
            <output
                className={
                    needle && shown.length === 0
                        ? 'border-t border-rule px-5 py-4 text-sm text-muted-foreground sm:px-8'
                        : 'sr-only'
                }
            >
                {!needle
                    ? ''
                    : shown.length === 0
                      ? `Nobody here matches “${query.trim()}”.`
                      : `${shown.length} of ${contacts.length} shown`}
            </output>
            {shown.length > 0 && (
                <ul className="flex flex-col border-t border-rule">
                    {shown.map((contact) => {
                        const standing = standingOf(contact);
                        const change = changeOf(contact);
                        const first = firstName(contact.name);
                        return (
                            <li
                                key={contact.userId}
                                data-contact={contact.email}
                                data-standing={
                                    change ? 'changed' : standing?.verified ? 'verified' : 'seen'
                                }
                                className="flex min-h-16 items-center gap-3 border-b border-rule py-2 pr-3 pl-5 hover:bg-muted sm:pr-5 sm:pl-8"
                            >
                                <PersonAvatar name={contact.name} seed={contact.userId} />
                                <span className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate text-[15px] font-medium">
                                        {contact.name}
                                    </span>
                                    {change ? (
                                        <span className="text-[13px] text-muted-foreground">
                                            Account changed ·{' '}
                                            <Button
                                                variant="link"
                                                className="text-[13px] font-semibold"
                                                onClick={() => setReviewing(change)}
                                            >
                                                Review
                                            </Button>
                                        </span>
                                    ) : (
                                        <span className="truncate text-[13px] text-muted-foreground">
                                            {contact.email}
                                            {/* Taken on a family's word: the server's name, the family's keys. */}
                                            {vouchLine(contact) && ` · ${vouchLine(contact)}`}
                                        </span>
                                    )}
                                </span>
                                {standing && !change && (
                                    <span className="inline-flex shrink-0 items-center gap-1 text-[13px] text-muted-foreground">
                                        {standing.verified && (
                                            <CheckIcon className="size-3.5" aria-hidden="true" />
                                        )}
                                        {standing.verified ? 'Verified' : 'Not verified'}
                                    </span>
                                )}
                                <DropdownMenu>
                                    <DropdownMenuTrigger
                                        render={
                                            <RowMenuButton
                                                aria-label={`More for ${contact.name}`}
                                            />
                                        }
                                    >
                                        <EllipsisIcon className="size-5" aria-hidden="true" />
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-56">
                                        <DropdownMenuGroup>
                                            <DropdownMenuItem
                                                onClick={() =>
                                                    setChecking({
                                                        email: contact.email,
                                                        name: contact.name,
                                                    })
                                                }
                                            >
                                                <ShieldCheckIcon aria-hidden="true" />
                                                {standing?.verified && !change
                                                    ? 'Check again'
                                                    : `Check it’s ${first}`}
                                            </DropdownMenuItem>
                                        </DropdownMenuGroup>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuGroup>
                                            <DropdownMenuItem
                                                variant="destructive"
                                                disabled={busy}
                                                onClick={() => setRemoving(contact)}
                                            >
                                                <UserXIcon aria-hidden="true" />
                                                Remove
                                            </DropdownMenuItem>
                                        </DropdownMenuGroup>
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            </li>
                        );
                    })}
                </ul>
            )}

            <OwnWordsDialog userId={userId} open={showingWords} onOpenChange={setShowingWords} />

            <Dialog open={adding} onOpenChange={setAdding}>
                <DialogContent className="sm:max-w-[480px]">
                    <DialogHeader>
                        <DialogTitle>Add someone</DialogTitle>
                    </DialogHeader>
                    {adding && (
                        <AddSomeone
                            userId={userId}
                            onCancel={() => setAdding(false)}
                            onAdded={(pin) => {
                                setAdding(false);
                                toast.add({
                                    type: 'success',
                                    title: `${firstName(pin.name)} added`,
                                });
                            }}
                            onChanged={(change) => {
                                setAdding(false);
                                setReviewing(change);
                            }}
                        />
                    )}
                </DialogContent>
            </Dialog>

            {/*
             * Checking someone looks up the keys the server serves for them now, and only here (or
             * on a mark's Check again, or when sharing) does a pin follow a signed succession.
             */}
            <CheckContactDialog
                userId={userId}
                person={checking}
                onOpenChange={(open) => !open && setChecking(null)}
            />
            <AccountChangedDialog
                userId={userId}
                change={reviewing}
                onOpenChange={(open) => !open && setReviewing(null)}
            />

            <AlertDialog
                open={removing !== null}
                onOpenChange={(open) => !open && setRemoving(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Remove {removing ? firstName(removing.name) : ''}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {removing ? firstName(removing.name) : 'They'} keeps access to anything
                            you’ve already shared.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            onClick={() => {
                                const target = removing;
                                setRemoving(null);
                                if (target) void remove(target);
                            }}
                        >
                            Remove
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
}

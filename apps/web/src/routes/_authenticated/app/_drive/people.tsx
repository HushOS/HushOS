import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ContactIcon,
    EllipsisIcon,
    RotateCcwIcon,
    SearchIcon,
    ShieldCheckIcon,
    TriangleAlertIcon,
    UserPlusIcon,
    UserXIcon,
} from 'lucide-react';
import { useState } from 'react';
import { CheckContact } from '@/components/drive/check-contact';
import { useDrive } from '@/components/drive/drive-shell';
import { EmptyState, RowMenuButton, SkeletonRows } from '@/components/drive/file-list';
import { OwnWordsDialog } from '@/components/own-words-dialog';
import { PageHeader } from '@/components/page-header';
import { PersonAvatar } from '@/components/person-avatar';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
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
    acknowledgeSuccession,
    pinVerified,
    removeContact,
    replacementUnseen,
    settingsQueryOptions,
    type Pin as ContactPin,
} from '@/lib/contacts';
import { afterTrustChanged } from '@/lib/integrity';
import { formatWhen } from '@/lib/drive';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/_drive/people')({
    head: () => ({ meta: [{ title: 'People you share with · HushOS' }] }),
    component: People,
});

/*
 * People you share with (once "Contacts"). Each is added with the key seen the
 * first time, after checking it's them: the other person reads their twelve
 * words from this page, and they have to match. A changed key is shown as a
 * warning to accept, never applied quietly. Adding works here and, so sharing
 * never stops for it, from the share dialog too.
 */
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
/* A list this long gets a filter; a shorter one fits on a screen and is found by eye. */
const FILTER_FROM = 8;

function People() {
    const { userId } = useDrive();
    const queryClient = useQueryClient();
    const settings = useQuery(settingsQueryOptions(userId));
    const [adding, setAdding] = useState(false);
    const [checking, setChecking] = useState<ContactPin | null>(null);
    const [removing, setRemoving] = useState<ContactPin | null>(null);
    const [busy, setBusy] = useState(false);
    const [rechecking, setRechecking] = useState<ContactPin | null>(null);
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
    // Pins made before the words covered every key: nothing is shared through them until checked again.
    const stale = useQuery({
        queryKey: ['contacts', 'stale', userId, settings.dataUpdatedAt],
        queryFn: async () => {
            const checked = await Promise.all(
                contacts.map(
                    async (contact) => [contact.userId, await pinVerified(contact)] as const,
                ),
            );
            return new Set(checked.filter(([, verified]) => !verified).map(([id]) => id));
        },
        enabled: settings.isSuccess,
    });

    // Contacts whose pin followed a signed succession: told once, with the way to compare again.
    const succeeded = contacts.filter(replacementUnseen);

    async function acknowledge(contact: ContactPin) {
        try {
            await acknowledgeSuccession(queryClient, userId, contact.userId);
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t save that',
                description: cause instanceof Error ? cause.message : undefined,
            });
        }
    }

    async function remove(contact: ContactPin) {
        setBusy(true);
        try {
            await removeContact(queryClient, userId, contact.userId);
            // What they wrote no longer counts as checked.
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
                title="People you share with"
                description="Add people by the email they use for HushOS. Checking it’s really them takes a minute on a call or in person, and is worth doing before you share anything private."
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
                    icon={TriangleAlertIcon}
                    tone="danger"
                    title="This list couldn’t be opened"
                    body={settings.error instanceof Error ? settings.error.message : undefined}
                >
                    <Button variant="outline" onClick={() => void settings.refetch()}>
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </EmptyState>
            )}
            {succeeded.map((contact) => (
                <div
                    key={contact.userId}
                    data-succession={contact.email}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-rule px-5 py-3 sm:px-8"
                >
                    <ShieldCheckIcon
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <p className="min-w-0 flex-1 text-sm">
                        {contact.name} replaced their sharing keys; the change is signed by their
                        previous keys.
                    </p>
                    <span className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={() => setRechecking(contact)}>
                            Compare words again
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => void acknowledge(contact)}>
                            Dismiss
                        </Button>
                    </span>
                </div>
            ))}
            {settings.data && contacts.length === 0 && (
                <div className="flex items-center gap-3 border-y border-rule px-5 py-4 sm:px-8">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <ContactIcon className="size-4" aria-hidden="true" />
                    </span>
                    <span className="flex min-w-0 flex-col">
                        <span className="text-[15px] font-medium">Nobody here yet</span>
                        <span className="text-[13px] text-muted-foreground">
                            Add someone by their email, or add them while you share.
                        </span>
                    </span>
                </div>
            )}
            {filtering && (
                <div
                    className={`relative mx-5 mb-3 max-w-md sm:mx-8 ${succeeded.length > 0 ? 'mt-4' : ''}`}
                >
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
                    {shown.map((contact) => (
                        <li
                            key={contact.userId}
                            data-contact={contact.email}
                            className="flex h-16 items-center gap-3 border-b border-rule pr-3 pl-5 hover:bg-muted sm:pr-5 sm:pl-8"
                        >
                            <PersonAvatar name={contact.name} seed={contact.userId} />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-[15px] font-medium">
                                    {contact.name}
                                </span>
                                <span className="truncate text-[13px] text-muted-foreground">
                                    {contact.email}
                                </span>
                            </span>
                            {stale.data?.has(contact.userId) ? (
                                <Badge variant="warning">Check again</Badge>
                            ) : (
                                <span className="hidden text-[13px] text-muted-foreground sm:inline">
                                    Added {formatWhen(contact.pinnedAt, { lower: true })}
                                </span>
                            )}
                            <DropdownMenu>
                                <DropdownMenuTrigger
                                    render={
                                        <RowMenuButton aria-label={`More for ${contact.name}`} />
                                    }
                                >
                                    <EllipsisIcon className="size-5" aria-hidden="true" />
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-56">
                                    <DropdownMenuGroup>
                                        {stale.data?.has(contact.userId) ? (
                                            <DropdownMenuItem
                                                onClick={() => setRechecking(contact)}
                                            >
                                                <ShieldCheckIcon aria-hidden="true" />
                                                Check their words again
                                            </DropdownMenuItem>
                                        ) : (
                                            <DropdownMenuItem onClick={() => setChecking(contact)}>
                                                <ShieldCheckIcon aria-hidden="true" />
                                                Check it’s them
                                            </DropdownMenuItem>
                                        )}
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
                    ))}
                </ul>
            )}

            <OwnWordsDialog userId={userId} open={showingWords} onOpenChange={setShowingWords} />

            <Dialog open={adding} onOpenChange={setAdding}>
                <DialogContent className="sm:max-w-[480px]">
                    <DialogHeader>
                        <DialogTitle>Add someone</DialogTitle>
                        <DialogDescription>
                            Then you can share with them. You’ll check it’s them first.
                        </DialogDescription>
                    </DialogHeader>
                    {adding && (
                        <CheckContact
                            userId={userId}
                            onCancel={() => setAdding(false)}
                            onAdded={(pin) => {
                                setAdding(false);
                                toast.add({ type: 'success', title: `${pin.name} added` });
                            }}
                        />
                    )}
                </DialogContent>
            </Dialog>

            <Dialog
                open={rechecking !== null}
                onOpenChange={(open) => !open && setRechecking(null)}
            >
                <DialogContent className="sm:max-w-[480px]">
                    <DialogHeader>
                        <DialogTitle>
                            Check {rechecking ? firstName(rechecking.name) : ''} again
                        </DialogTitle>
                        <DialogDescription>
                            {rechecking && replacementUnseen(rechecking)
                                ? 'Their keys are new, so their twelve words are too. Read them together once more.'
                                : 'Their twelve words now cover all of their keys. Read them together once more; shares between you open again once you’ve both done it.'}
                        </DialogDescription>
                    </DialogHeader>
                    {rechecking && (
                        <CheckContact
                            userId={userId}
                            email={rechecking.email}
                            recheck
                            onCancel={() => setRechecking(null)}
                            onAdded={(pin) => {
                                setRechecking(null);
                                toast.add({ type: 'success', title: `${pin.name} checked` });
                            }}
                        />
                    )}
                </DialogContent>
            </Dialog>

            {/*
             * Checking someone looks up the keys the server serves for them now, and only here
             * (or on a mark's Check again) does a pin follow a signed succession: never on its own.
             */}
            <Dialog open={checking !== null} onOpenChange={(open) => !open && setChecking(null)}>
                <DialogContent className="sm:max-w-[480px]">
                    <DialogHeader>
                        <DialogTitle>
                            Check it’s {checking ? firstName(checking.name) : ''}
                        </DialogTitle>
                        <DialogDescription>
                            If their words don’t match, don’t share anything new with them. Remove
                            them, and add them again once they’ve signed in.
                        </DialogDescription>
                    </DialogHeader>
                    {checking && (
                        <CheckContact
                            userId={userId}
                            email={checking.email}
                            onCancel={() => setChecking(null)}
                            onAdded={() => {
                                setChecking(null);
                                afterTrustChanged(queryClient);
                            }}
                        />
                    )}
                </DialogContent>
            </Dialog>

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
                            you’ve already shared. If you add them again, you’ll check it’s them
                            again.
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

import type { ContactPin } from '@hushos/auth/api';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
    ContactIcon,
    EllipsisIcon,
    RotateCcwIcon,
    ShieldCheckIcon,
    TriangleAlertIcon,
    UserPlusIcon,
    UserXIcon,
} from 'lucide-react';
import { useState } from 'react';
import { CheckContact } from '@/components/drive/check-contact';
import { FingerprintWords } from '@/components/fingerprint-words';
import { useDrive } from '@/components/drive/drive-shell';
import { EmptyState, RowMenuButton, SkeletonRows } from '@/components/drive/file-list';
import { Spinner } from '@/components/motion';
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
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
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
import { toast } from '@/components/ui/toast';
import { ownFingerprintQueryOptions, removeContact, settingsQueryOptions } from '@/lib/contacts';
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

function People() {
    const { userId } = useDrive();
    const queryClient = useQueryClient();
    const settings = useQuery(settingsQueryOptions(userId));
    const [adding, setAdding] = useState(false);
    const [checking, setChecking] = useState<ContactPin | null>(null);
    const [removing, setRemoving] = useState<ContactPin | null>(null);
    const [busy, setBusy] = useState(false);
    const contacts = Object.values(settings.data?.settings.contacts ?? {}).sort((a, b) =>
        a.name.localeCompare(b.name),
    );

    async function remove(contact: ContactPin) {
        setBusy(true);
        try {
            await removeContact(queryClient, userId, contact.userId);
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
            {contacts.length > 0 && (
                <ul className="flex flex-col border-t border-rule">
                    {contacts.map((contact) => (
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
                            <span className="hidden text-[13px] text-muted-foreground sm:inline">
                                Added {formatWhen(contact.pinnedAt, { lower: true })}
                            </span>
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
                                        <DropdownMenuItem onClick={() => setChecking(contact)}>
                                            <ShieldCheckIcon aria-hidden="true" />
                                            Check it’s them
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
                    ))}
                </ul>
            )}

            <OwnFingerprint userId={userId} />

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

            <Dialog open={checking !== null} onOpenChange={(open) => !open && setChecking(null)}>
                <DialogContent className="sm:max-w-[480px]">
                    <DialogHeader>
                        <DialogTitle>
                            Check it’s {checking ? firstName(checking.name) : ''}
                        </DialogTitle>
                        <DialogDescription>
                            Ask {checking ? firstName(checking.name) : 'them'} to open People you
                            share with in HushOS and read you their twelve words, on a call or in
                            person. If they match these, it’s really them.
                        </DialogDescription>
                    </DialogHeader>
                    {checking && <FingerprintWords fingerprint={checking.fingerprint} />}
                    <p className="text-[13px] text-muted-foreground">
                        If they don’t match, don’t share anything new with them. Remove them, and
                        add them again once they’ve signed in.
                    </p>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setChecking(null)}>
                            Done
                        </Button>
                    </DialogFooter>
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

/* What others check when they add this person: their twelve words, read aloud from here. */
function OwnFingerprint({ userId }: { userId: string }) {
    const own = useQuery(ownFingerprintQueryOptions(userId));
    return (
        <section className="mx-5 mt-8 mb-8 flex max-w-2xl flex-col gap-2 rounded-2xl border border-rule p-5 sm:mx-8">
            <h2 className="text-[15px] font-bold">Your twelve words</h2>
            <p className="text-sm text-muted-foreground">
                When someone adds you, they’ll ask you to read these. They’re the same on all your
                devices.
            </p>
            <div className="mt-1">
                {own.isPending ? (
                    <Spinner className="size-4 text-muted-foreground" />
                ) : own.isError ? (
                    <span className="text-sm text-destructive">
                        {own.error instanceof Error ? own.error.message : 'Couldn’t open it.'}
                    </span>
                ) : (
                    <FingerprintWords fingerprint={own.data} />
                )}
            </div>
        </section>
    );
}

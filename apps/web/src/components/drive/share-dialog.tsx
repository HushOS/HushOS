import type { LinkView, ShareRole, ShareView } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Command as CommandPrimitive } from 'cmdk';
import {
    CheckIcon,
    CopyIcon,
    EllipsisIcon,
    KeyRoundIcon,
    Link2Icon,
    Link2OffIcon,
    DownloadIcon,
    QrCodeIcon,
    UserPlusIcon,
    XIcon,
} from 'lucide-react';
import { useId, useRef, useState } from 'react';
import { ContactFlow, type FlowStart } from '@/components/drive/contact-flow';
import { useDrive } from '@/components/drive/drive-shell';
import { describeLink, LinkOptionsDialog } from '@/components/drive/link-row';
import { PersonAvatar } from '@/components/person-avatar';
import { QrCode, shareQrImage } from '@/components/qr-code';
import { safeFileName, saveBlob } from '@/lib/save-file';
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
import { CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectSeparator,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast';
import {
    accountChangeOf,
    addContact,
    AccountChangedError,
    granteeKeys,
    settingsQueryOptions,
    shareeStanding,
    useAccountChanges,
    type AccountChange,
    type Pin,
} from '@/lib/contacts';
import { familyWord, pinOf, vouchLine } from '@/lib/family-pin';
import { afterTrustChanged } from '@/lib/integrity';
import {
    displayName,
    driveClient,
    driveError,
    driveKeys,
    formatDay,
    formatWhen,
} from '@/lib/drive';
import { currentNode, oweRotation, rotateAfterRevoke } from '@/lib/rotation';
import { sessionQueryOptions } from '@/lib/session';
import { cue } from '@/lib/sounds';
import { copySecret } from '@/lib/clipboard';

const ROLES: { value: ShareRole; label: string }[] = [
    { value: 'viewer', label: 'Can view' },
    { value: 'editor', label: 'Can edit' },
];
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/*
 * Who can open an item: the people it is shared with, each with what they can
 * do, and the one link anyone can use. Sharing seals the item's key on this
 * device to the keys remembered for a contact, so only contacts can be chosen;
 * someone new is added by their email right here and shared with in the same
 * step, with no words (docs/optional-verification.md 6.3). Someone whose
 * account changed waits for Review before anything new is shared with them.
 */
export function ShareDialog({
    node,
    open,
    onOpenChange,
}: {
    node: DriveNode | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    // While a step of its own fills the sheet (a notice, a check, a stop), closing comes back here.
    const [over, setOver] = useState<Over | null>(null);
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next && over) setOver(null);
                else onOpenChange(next);
            }}
        >
            <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-[560px]">
                {node && (
                    <ShareForm
                        key={node.id}
                        node={node}
                        onOpenChange={onOpenChange}
                        over={over}
                        setOver={setOver}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

/* What a share sheet was doing when someone's changed account stopped it: run again after Review. */
type Interrupted =
    | { kind: 'share'; pin: Pin; role: ShareRole }
    | { kind: 'new'; email: string; role: ShareRole }
    | { kind: 'role'; share: ShareView; role: ShareRole };
/*
 * What fills the sheet in place of its own content, one at a time: the
 * contact flow (Review, Check it's Maya) or "Stop sharing with Maya?".
 */
type Over = { kind: 'flow'; start: FlowStart } | { kind: 'stop'; share: ShareView };

function ShareForm({
    node,
    onOpenChange,
    over,
    setOver: show,
}: {
    node: DriveNode;
    onOpenChange: (open: boolean) => void;
    over: Over | null;
    setOver: (over: Over | null) => void;
}) {
    const { userId } = useDrive();
    const queryClient = useQueryClient();
    const me = useQuery(sessionQueryOptions).data;
    const settings = useQuery(settingsQueryOptions(userId));
    const sharesKey = [...driveKeys.all, 'shares', node.id];
    const shares = useQuery({
        queryKey: sharesKey,
        queryFn: () => driveClient.nodeShares(node),
        staleTime: 0,
    });
    useAccountChanges();
    const [chosen, setChosen] = useState<Pin | null>(null);
    const [role, setRole] = useState<ShareRole>('viewer');
    /* 'share' while sealing, else the id of the share whose role is changing. */
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState('');
    /* The act a changed account stopped, and whether Review settled it so it may run again. */
    const interrupted = useRef<Interrupted | null>(null);
    const resolved = useRef(false);
    /* Something in this sheet's place; only a Review started by an act carries that act. */
    function setOver(next: Over | null, act: Interrupted | null = null) {
        interrupted.current = act;
        resolved.current = false;
        show(next);
    }

    const contacts = Object.values(settings.data?.settings.contacts ?? {}).sort((a, b) =>
        a.name.localeCompare(b.name),
    );
    const already = new Set(shares.data?.map((share) => share.grantee.id) ?? []);
    const choices = contacts.filter((contact) => !already.has(contact.userId));
    const refresh = () => queryClient.invalidateQueries({ queryKey: sharesKey });

    /*
     * An account that changed is the notice, in this sheet's place, not an error: nothing was
     * shared. The act waits, and runs again once Continue or a check settles it.
     */
    function reviewChange(
        cause: unknown,
        pin: Pick<Pin, 'userId' | 'name' | 'email'>,
        act: Interrupted,
    ) {
        if (!(cause instanceof AccountChangedError)) return false;
        setOver(
            {
                kind: 'flow',
                start: {
                    kind: 'changed',
                    change: accountChangeOf(userId, pin.userId) ?? {
                        contactId: pin.userId,
                        name: pin.name,
                        email: pin.email,
                    },
                },
            },
            act,
        );
        return true;
    }
    /* The flow ended: back to the sheet, and the act it interrupted again if trust was settled. */
    function flowDone() {
        const act = resolved.current ? interrupted.current : null;
        setOver(null);
        // A Continue or a check changes where each row stands.
        void queryClient.invalidateQueries({ queryKey: ['contacts', 'sharee'] });
        if (!act) return;
        if (act.kind === 'share') void share(act.pin, act.role);
        else if (act.kind === 'new') void shareWithNew(act.email, act.role);
        else void changeRole(act.share, act.role);
    }

    async function share(pin: Pin, as: ShareRole) {
        setPending('share');
        setError('');
        try {
            // A fresh node and fresh keys, also when this runs again after Review.
            const current = await currentNode(queryClient, node);
            await driveClient.share(current, await granteeKeys(userId, pin), as);
            await refresh();
            await queryClient.invalidateQueries({ queryKey: driveKeys.mine });
            cue('success');
            toast.add({
                type: 'success',
                title: `“${node.name}” shared with ${pin.name}`,
                description:
                    as === 'editor'
                        ? `${firstName(pin.name)} can open, add and change what’s inside.`
                        : `${firstName(pin.name)} can open and download it.`,
            });
            setChosen(null);
            setRole('viewer');
        } catch (cause) {
            if (reviewChange(cause, pin, { kind: 'share', pin, role: as })) return;
            cue('error');
            setError(driveError(cause));
        } finally {
            setPending(null);
        }
    }
    /* Someone new by their email (6.3): added as 6.2 adds them, and shared with, in one step. */
    async function shareWithNew(email: string, as: ShareRole) {
        setPending('share');
        setError('');
        const act: Interrupted = { kind: 'new', email, role: as };
        try {
            const added = await addContact(queryClient, userId, email);
            if (added.outcome === 'changed') {
                reviewChange(
                    new AccountChangedError(added.change.contactId, added.change.name),
                    { userId: added.change.contactId, ...added.change },
                    act,
                );
                return;
            }
            const pin = added.pin;
            const current = await currentNode(queryClient, node);
            await driveClient.share(current, await granteeKeys(userId, pin), as);
            await refresh();
            await queryClient.invalidateQueries({ queryKey: driveKeys.mine });
            // What they wrote now reads as theirs.
            if (added.outcome === 'added') afterTrustChanged(queryClient);
            cue('success');
            toast.add({ type: 'success', title: `Shared with ${firstName(pin.name)}` });
            setRole('viewer');
        } catch (cause) {
            if (
                cause instanceof AccountChangedError &&
                reviewChange(cause, { userId: cause.contactId, name: cause.person, email }, act)
            )
                return;
            cue('error');
            setError(driveError(cause));
        } finally {
            setPending(null);
        }
    }
    /* A new role is the same share sealed again with it; the server replaces the old one. */
    async function changeRole(target: ShareView, next: ShareRole) {
        // The settings as they are now: this may run again after Review moved the pin.
        const loaded = await queryClient.fetchQuery(settingsQueryOptions(userId)).catch(() => null);
        const pin = loaded
            ? (pinOf(loaded.settings.contacts, target.grantee.id)?.pin ?? null)
            : null;
        if (!pin || next === target.role) return;
        setPending(target.id);
        try {
            const current = await currentNode(queryClient, node);
            await driveClient.share(current, await granteeKeys(userId, pin), next);
            await refresh();
            cue('success', { volume: 0.4 });
            toast.add({
                type: 'success',
                title: `${firstName(target.grantee.name)} ${next === 'editor' ? 'can edit' : 'can view'} “${node.name}” now`,
            });
        } catch (cause) {
            if (reviewChange(cause, pin, { kind: 'role', share: target, role: next })) return;
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t change what they can do',
                description: driveError(cause),
            });
        } finally {
            setPending(null);
        }
    }
    async function stop(target: ShareView) {
        setPending(target.id);
        try {
            // Owed before it is stopped, so a closed tab still re-keys it (lib/rotation.ts).
            await oweRotation(node.id);
            await driveClient.revokeShare(node, target.id);
            await refresh();
            await queryClient.invalidateQueries({ queryKey: driveKeys.mine });
            cue('droplet');
            toast.add({
                type: 'success',
                title: `${target.grantee.name} can’t open “${node.name}” any more`,
            });
            void rotateAfterRevoke(queryClient, node);
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t stop sharing',
                description: driveError(cause),
            });
        } finally {
            setPending(null);
        }
    }

    if (over?.kind === 'flow')
        return (
            <ContactFlow
                userId={userId}
                start={over.start}
                onDone={flowDone}
                onResolved={() => {
                    resolved.current = true;
                }}
            />
        );
    if (over?.kind === 'stop')
        return (
            <>
                <DialogHeader>
                    <DialogTitle>
                        Stop sharing with {firstName(over.share.grantee.name)}?
                    </DialogTitle>
                    <DialogDescription>
                        They can’t open “{node.name}” in HushOS any more. Copies they already
                        downloaded stay with them. You can share it again later.
                    </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                    <Button variant="outline" onClick={() => setOver(null)}>
                        Cancel
                    </Button>
                    <Button
                        variant="destructive"
                        onClick={() => {
                            const target = over.share;
                            setOver(null);
                            void stop(target);
                        }}
                    >
                        Stop sharing
                    </Button>
                </DialogFooter>
            </>
        );

    return (
        <>
            <DialogHeader>
                <DialogTitle>Who can open this?</DialogTitle>
                <DialogDescription className="wrap-anywhere">{displayName(node)}</DialogDescription>
            </DialogHeader>
            {chosen ? (
                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rule p-3">
                        <PersonAvatar name={chosen.name} seed={chosen.userId} />
                        <span className="flex min-w-0 flex-1 flex-col">
                            <span className="truncate text-[15px] font-medium">{chosen.name}</span>
                            <span className="truncate text-[13px] text-muted-foreground">
                                {chosen.email}
                            </span>
                            {vouchLine(chosen) && (
                                <span
                                    data-vouched
                                    className="truncate text-[13px] text-muted-foreground"
                                >
                                    {vouchLine(chosen)}
                                </span>
                            )}
                        </span>
                        <RoleSelect
                            value={role}
                            onChange={setRole}
                            label={`What ${chosen.name} can do`}
                        />
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Choose someone else"
                            title="Choose someone else"
                            onClick={() => setChosen(null)}
                        >
                            <XIcon />
                        </Button>
                    </div>
                    {error && (
                        <p role="alert" className="text-[13px] text-destructive">
                            {error}
                        </p>
                    )}
                    <div className="flex justify-end">
                        <Button
                            disabled={pending !== null}
                            onClick={() => void share(chosen, role)}
                        >
                            {pending === 'share' ? 'Sharing…' : 'Share'}
                        </Button>
                    </div>
                </div>
            ) : (
                <>
                    <PeopleField
                        loading={settings.isPending}
                        busy={pending === 'share'}
                        contacts={choices}
                        anyContacts={contacts.length > 0}
                        role={role}
                        onRole={setRole}
                        onPick={setChosen}
                        onAdd={(email) => void shareWithNew(email, role)}
                    />
                    {error && (
                        <p role="alert" className="text-[13px] text-destructive">
                            {error}
                        </p>
                    )}
                </>
            )}

            <div className="flex flex-col">
                <div className="flex h-16 items-center gap-3 border-b border-rule last:border-0">
                    <PersonAvatar name={me?.name ?? 'You'} seed={userId} />
                    <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-[15px] font-medium">
                            {me?.name ? `${me.name} (you)` : 'You'}
                        </span>
                        {me?.email && (
                            <span className="truncate text-[13px] text-muted-foreground">
                                {me.email}
                            </span>
                        )}
                    </span>
                    <span className="pr-3 text-sm text-muted-foreground">Owner</span>
                </div>
                {shares.isError && (
                    <p role="alert" className="py-3 text-[13px] text-destructive">
                        {driveError(shares.error)}
                    </p>
                )}
                {shares.data?.map((entry) => (
                    <PersonRow
                        key={entry.id}
                        userId={userId}
                        entry={entry}
                        pin={settings.data?.settings.contacts[entry.grantee.id] ?? null}
                        disabled={pending !== null}
                        onRole={(next) => void changeRole(entry, next)}
                        onCheck={() =>
                            setOver({
                                kind: 'flow',
                                start: {
                                    kind: 'check',
                                    person: {
                                        email: entry.grantee.email,
                                        name: entry.grantee.name,
                                    },
                                },
                            })
                        }
                        onStop={() => setOver({ kind: 'stop', share: entry })}
                        onReview={(change) =>
                            setOver({ kind: 'flow', start: { kind: 'changed', change } })
                        }
                    />
                ))}
            </div>

            <LinksSection node={node} />

            <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Done
                </Button>
            </DialogFooter>
        </>
    );
}

/*
 * Someone the item is shared with: what they can do, Check it's Maya, Stop
 * sharing. The keys HushOS serves for them now are looked up as the sheet
 * opens (the share sheet is one of the places a change is met, 2.4): an
 * account that changed reads so on its second line, with Review, and its role
 * waits until then. No verification text otherwise.
 */
function PersonRow({
    userId,
    entry,
    pin,
    disabled,
    onRole,
    onCheck,
    onStop,
    onReview,
}: {
    userId: string;
    entry: ShareView;
    pin: Pin | null;
    disabled: boolean;
    onRole: (role: ShareRole) => void;
    onCheck: () => void;
    onStop: () => void;
    onReview: (change: AccountChange) => void;
}) {
    const standing = useQuery({
        queryKey: ['contacts', 'sharee', userId, entry.grantee.id],
        queryFn: () => shareeStanding(userId, pin!),
        enabled: pin !== null,
        staleTime: 60_000,
        retry: false,
    });
    const change =
        accountChangeOf(userId, entry.grantee.id) ??
        (standing.data === 'changed' && pin
            ? { contactId: pin.userId, name: pin.name, email: pin.email }
            : null);
    const first = firstName(entry.grantee.name);
    return (
        <div
            data-share={entry.grantee.email}
            data-suite={entry.suite}
            data-standing={change ? 'changed' : undefined}
            className="flex h-16 items-center gap-3 border-b border-rule last:border-0"
        >
            <PersonAvatar name={entry.grantee.name} seed={entry.grantee.id} />
            <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[15px] font-medium">{entry.grantee.name}</span>
                {change ? (
                    <span className="truncate text-[13px] text-muted-foreground">
                        {first}’s account changed ·{' '}
                        <Button
                            variant="link"
                            className="text-[13px] font-semibold"
                            onClick={() => onReview(change)}
                        >
                            Review
                        </Button>
                    </span>
                ) : (
                    <span className="truncate text-[13px] text-muted-foreground">
                        {entry.grantee.email}
                    </span>
                )}
            </span>
            <Select<string>
                value={entry.role}
                disabled={disabled}
                onValueChange={(value) => {
                    if (value === 'stop') onStop();
                    else if (value === 'check') onCheck();
                    else if (value) onRole(value as ShareRole);
                }}
                items={[
                    ...ROLES,
                    { value: 'check', label: `Check it’s ${first}` },
                    { value: 'stop', label: 'Stop sharing' },
                ]}
            >
                <SelectTrigger
                    className="h-9 w-[128px] pointer-coarse:h-11"
                    aria-label={`What ${entry.grantee.name} can do`}
                >
                    <SelectValue />
                </SelectTrigger>
                <SelectContent>
                    {ROLES.map((option) => (
                        <SelectItem
                            key={option.value}
                            value={option.value}
                            disabled={(!pin || change !== null) && option.value !== entry.role}
                        >
                            {option.label}
                        </SelectItem>
                    ))}
                    <SelectSeparator />
                    {pin && <SelectItem value="check">Check it’s {first}</SelectItem>}
                    <SelectItem
                        value="stop"
                        className="text-destructive data-highlighted:text-destructive"
                    >
                        Stop sharing
                    </SelectItem>
                </SelectContent>
            </Select>
        </div>
    );
}

function RoleSelect({
    value,
    onChange,
    label,
}: {
    value: ShareRole;
    onChange: (role: ShareRole) => void;
    label: string;
}) {
    return (
        <Select
            value={value}
            onValueChange={(next) => next && onChange(next as ShareRole)}
            items={ROLES}
        >
            <SelectTrigger className="h-9 w-[128px] pointer-coarse:h-11" aria-label={label}>
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {ROLES.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                        {option.label}
                    </SelectItem>
                ))}
            </SelectContent>
        </Select>
    );
}

/*
 * The field to add someone: type a name or an email, pick from your contacts as you
 * type, or add someone new by their email without leaving. Arrows and Enter work.
 */
function PeopleField({
    loading,
    busy,
    contacts,
    anyContacts,
    role,
    onRole,
    onPick,
    onAdd,
}: {
    loading: boolean;
    busy: boolean;
    contacts: Pin[];
    anyContacts: boolean;
    /* What whoever is chosen here can do, picked beside the field before anything is shared. */
    role: ShareRole;
    onRole: (role: ShareRole) => void;
    onPick: (contact: Pin) => void;
    onAdd: (email: string) => void;
}) {
    const id = useId();
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const typed = query.trim();
    const isEmail = EMAIL.test(typed);
    // A pin taken on a family's word never matches a typed address: its name and address are the
    // server's, so someone typed by email is always added as their own (decision D10).
    const known = contacts.some(
        (contact) => !familyWord(contact) && contact.email.toLowerCase() === typed.toLowerCase(),
    );
    const matches = contacts.filter((contact) =>
        `${contact.name} ${contact.email}`.toLowerCase().includes(typed.toLowerCase()),
    );
    // The list of matches opens under the field and the picker both, so a long address fits.
    return (
        <div className="relative flex items-center gap-2">
            <CommandPrimitive
                label="Add people"
                shouldFilter={false}
                className="min-w-0 flex-1"
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && open) {
                        // Closes the list, not the dialog.
                        event.stopPropagation();
                        setOpen(false);
                    }
                }}
            >
                <div className="flex h-11 items-center gap-2.5 rounded-md border border-input bg-card px-3 focus-within:outline-2 focus-within:outline-solid focus-within:-outline-offset-1 focus-within:outline-ring">
                    <UserPlusIcon
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <CommandPrimitive.Input
                        id={id}
                        value={query}
                        onValueChange={(value) => {
                            setQuery(value);
                            setOpen(true);
                        }}
                        // Opens when asked for: a click, typing, or the down arrow, never on the
                        // focus the dialog gives it when it opens.
                        onPointerDown={() => setOpen(true)}
                        onKeyDown={(event) => {
                            if (event.key === 'ArrowDown' && !open) setOpen(true);
                        }}
                        onBlur={() => setOpen(false)}
                        disabled={busy}
                        placeholder="Add a name or email"
                        aria-label="Add people"
                        className="h-full min-w-0 flex-1 bg-transparent text-base outline-none sm:text-[15px] placeholder:text-muted-foreground"
                    />
                </div>
                {open && (
                    <CommandList
                        // Pressing an item must not blur the field first, or the list would close under it.
                        onMouseDown={(event) => event.preventDefault()}
                        className="absolute inset-x-0 top-full z-20 mt-1.5 max-h-72 rounded-xl border border-border bg-popover p-1.5 shadow-overlay"
                    >
                        {loading && (
                            <p className="px-2 py-3 text-sm text-muted-foreground">
                                Opening your contacts…
                            </p>
                        )}
                        {!loading && matches.length > 0 && (
                            <CommandGroup heading={typed ? undefined : 'Your contacts'}>
                                {matches.map((contact) => (
                                    <CommandItem
                                        key={contact.userId}
                                        value={contact.userId}
                                        onSelect={() => {
                                            onPick(contact);
                                            setQuery('');
                                            setOpen(false);
                                        }}
                                        className="gap-3 py-2"
                                    >
                                        <PersonAvatar
                                            name={contact.name}
                                            seed={contact.userId}
                                            size={32}
                                        />
                                        <span className="flex min-w-0 flex-col">
                                            <span className="truncate text-sm font-medium">
                                                {contact.name}
                                            </span>
                                            <span className="truncate text-[13px] text-muted-foreground">
                                                {contact.email}
                                            </span>
                                            {vouchLine(contact) && (
                                                <span
                                                    data-vouched
                                                    className="truncate text-[13px] text-muted-foreground"
                                                >
                                                    {vouchLine(contact)}
                                                </span>
                                            )}
                                        </span>
                                    </CommandItem>
                                ))}
                            </CommandGroup>
                        )}
                        {!loading && isEmail && !known && (
                            <CommandItem
                                value={`add:${typed}`}
                                onSelect={() => {
                                    onAdd(typed);
                                    setQuery('');
                                    setOpen(false);
                                }}
                                className="gap-3 py-2"
                            >
                                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-accent-foreground">
                                    <UserPlusIcon className="size-4" aria-hidden="true" />
                                </span>
                                <span className="truncate text-sm font-medium">
                                    Share with {typed}
                                </span>
                            </CommandItem>
                        )}
                        {!loading && matches.length === 0 && !(isEmail && !known) && (
                            <p className="px-2 py-3 text-sm text-muted-foreground">
                                {!anyContacts && !typed
                                    ? 'Type their email to share with someone new.'
                                    : known
                                      ? 'They already have this.'
                                      : typed
                                        ? 'No one by that name yet. Type their full email to add them.'
                                        : 'Everyone in your contacts already has this.'}
                            </p>
                        )}
                    </CommandList>
                )}
            </CommandPrimitive>
            <RoleSelect value={role} onChange={onRole} label="What they can do" />
        </div>
    );
}

/*
 * Links anyone can open. An item can have several, each with its own password,
 * end date and count of opens, so one can be turned off without breaking the
 * others. Each is a row: copy it, show it as a QR code, change its password and
 * end date, or turn it off.
 */
function LinksSection({ node }: { node: DriveNode }) {
    const queryClient = useQueryClient();
    const linksKey = [...driveKeys.all, 'links', node.id];
    const links = useQuery({
        queryKey: linksKey,
        queryFn: () => driveClient.nodeLinks(node),
        staleTime: 0,
    });
    const refresh = async () => {
        await queryClient.invalidateQueries({ queryKey: linksKey });
        await queryClient.invalidateQueries({ queryKey: driveKeys.mine });
    };
    // In the order they were made, so a new link lands at the foot and nothing above it moves.
    const list = links.data ?? [];
    /* Addresses of links made here, known without asking the server to rebuild them. */
    const [made, setMade] = useState<Record<string, string>>({});
    const [creating, setCreating] = useState(false);

    async function create() {
        setCreating(true);
        try {
            const current = await currentNode(queryClient, node);
            const { link, token, secret } = await driveClient.createLink(current, {
                password: null,
                expiresAt: null,
            });
            setMade((all) => ({
                ...all,
                [link.id]: `${window.location.origin}/s/${token}#${secret}`,
            }));
            await refresh();
            cue('success');
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t make a link',
                description: driveError(cause),
            });
        } finally {
            setCreating(false);
        }
    }

    return (
        <section aria-label="Links" className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3">
                <h3 className="text-[15px] font-bold">Links</h3>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={creating || links.isPending}
                    onClick={() => void create()}
                >
                    <Link2Icon />
                    {creating ? 'Making…' : 'New link'}
                </Button>
            </div>
            {links.isError && (
                <p role="alert" className="text-[13px] text-destructive">
                    {driveError(links.error)}
                </p>
            )}
            {links.data && list.length === 0 && (
                <div className="rounded-xl bg-muted p-4">
                    <p className="text-sm text-muted-foreground">
                        No links. A link lets anyone who has it view “{node.name}”, with a password
                        or an end date if you like.
                    </p>
                </div>
            )}
            {list.length > 0 && (
                <ul className="flex flex-col divide-y divide-rule rounded-xl border border-rule">
                    {list.map((link) => (
                        <LinkCard
                            key={link.id}
                            node={node}
                            link={link}
                            url={made[link.id] ?? null}
                            several={list.length > 1}
                            onChanged={refresh}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}

/* One link as a row: what it does, how it's been used, Copy link, and the rest in a menu. */
function LinkCard({
    node,
    link,
    url,
    several,
    onChanged,
}: {
    node: DriveNode;
    link: LinkView;
    /* Its address, when it was made here and so is already known. */
    url: string | null;
    /* More than one link: each says when it was made, so they can be told apart. */
    several: boolean;
    onChanged: () => Promise<unknown>;
}) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const [copied, setCopied] = useState(false);
    const [qr, setQr] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const qrNote = useId();
    const [options, setOptions] = useState(false);
    const [confirmOff, setConfirmOff] = useState(false);

    async function address() {
        if (url) return url;
        const value = await driveClient.linkUrl(node, link, window.location.origin);
        if (!value)
            throw new Error(
                'This link was made before links could be shown again. Turn it off and make a new one.',
            );
        return value;
    }
    async function copy() {
        setBusy(true);
        try {
            await copySecret(await address());
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
            cue('success', { volume: 0.4 });
            toast.add({
                type: 'success',
                title: 'Link copied',
                description: link.expiresAt
                    ? `Anyone with it can view “${node.name}” until ${formatDay(link.expiresAt)}.`
                    : `Anyone with it can view “${node.name}”.`,
            });
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t copy the link',
                description: driveError(cause),
            });
        } finally {
            setBusy(false);
        }
    }
    async function toggleQr() {
        if (qr) {
            setQr(null);
            return;
        }
        setBusy(true);
        try {
            setQr(await address());
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t show the code',
                description: driveError(cause),
            });
        } finally {
            setBusy(false);
        }
    }
    /*
     * The code as a PNG, to print or put on a slide. The image is the link, key and
     * all, so the note beside the button says so; the file is named after the item,
     * on the person's own device. (The phones show the code but offer no file.)
     */
    async function saveQr() {
        if (!qr || saving) return;
        setSaving(true);
        // Async, so a canvas the browser cannot draw (no roundRect) rejects instead of throwing,
        // and the button is free again whatever happened.
        const image = await shareQrImage(qr)
            .catch(() => null)
            .finally(() => setSaving(false));
        if (!image) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t download the QR code',
                description: 'Try again, or use Copy link instead.',
            });
            return;
        }
        saveBlob(image, `${safeFileName(node.name)} QR code.png`);
        cue('success', { volume: 0.4 });
    }
    async function turnOff() {
        setBusy(true);
        try {
            await oweRotation(node.id);
            await driveClient.revokeLink(node, link.id);
            await onChanged();
            cue('droplet');
            toast.add({
                type: 'success',
                title: 'Link turned off',
                description: `Anyone who has it can’t open “${node.name}” any more.`,
            });
            void rotateAfterRevoke(queryClient, node);
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t turn the link off',
                description: driveError(cause),
            });
        } finally {
            setBusy(false);
        }
    }

    return (
        <li data-link={link.id} className="flex flex-col gap-3 px-3 py-2.5">
            <div className="flex items-center gap-3">
                {/* The blue link icon marks "anyone with the link"; the colour stays on the icon, not the whole row. */}
                <Link2Icon
                    className="size-[18px] shrink-0 text-primary"
                    strokeWidth={2.2}
                    aria-hidden="true"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-sm font-semibold">Anyone with the link can view</span>
                    <span className="truncate text-[13px] text-muted-foreground">
                        {several ? `Made ${formatWhen(link.createdAt, { lower: true })} · ` : ''}
                        {describeLink(link)}
                    </span>
                </span>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    data-url={url ?? undefined}
                    onClick={() => void copy()}
                >
                    {copied ? <CheckIcon /> : <CopyIcon />}
                    {copied ? 'Copied' : 'Copy link'}
                </Button>
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label="More for this link"
                                title="More for this link"
                                disabled={busy}
                            />
                        }
                    >
                        <EllipsisIcon />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-auto min-w-52">
                        <DropdownMenuItem onClick={() => setOptions(true)}>
                            <KeyRoundIcon aria-hidden="true" />
                            Password and end date
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => void toggleQr()}>
                            <QrCodeIcon aria-hidden="true" />
                            {qr ? 'Hide QR code' : 'Show as QR code'}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setConfirmOff(true)}>
                            <Link2OffIcon aria-hidden="true" />
                            Turn off link
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
            {qr && (
                <div className="flex flex-col items-center gap-2 rounded-xl bg-muted p-4">
                    <QrCode value={qr} kind="share" title={`Link to ${node.name}`} />
                    <p id={qrNote} className="text-center text-[13px] text-muted-foreground">
                        Whoever scans it can open “{node.name}”
                        {link.hasPassword ? ' with the password' : ''}. A downloaded copy works the
                        same way until you turn the link off or it ends, and photo apps may back it
                        up like any other picture.
                    </p>
                    <Button
                        variant="outline"
                        disabled={saving}
                        aria-describedby={qrNote}
                        onClick={() => void saveQr()}
                    >
                        <DownloadIcon aria-hidden="true" />
                        Download QR code
                    </Button>
                </div>
            )}
            <LinkOptionsDialog
                node={node}
                link={link}
                open={options}
                onOpenChange={setOptions}
                onChanged={onChanged}
                onTurnOff={() => {
                    setOptions(false);
                    setConfirmOff(true);
                }}
            />
            <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Turn off this link?</AlertDialogTitle>
                        <AlertDialogDescription>
                            Anyone who has it can’t open “{node.name}” any more. Other links keep
                            working.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            onClick={() => {
                                setConfirmOff(false);
                                void turnOff();
                            }}
                        >
                            Turn off link
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </li>
    );
}

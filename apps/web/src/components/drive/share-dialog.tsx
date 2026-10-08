import type { ContactPin } from '@hushos/auth/api';
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
    QrCodeIcon,
    UserPlusIcon,
    XIcon,
} from 'lucide-react';
import { useId, useState } from 'react';
import { CheckContact } from '@/components/drive/check-contact';
import { useDrive } from '@/components/drive/drive-shell';
import { describeLink, LinkOptionsDialog } from '@/components/drive/link-row';
import { PersonAvatar } from '@/components/person-avatar';
import { QrCode } from '@/components/qr-code';
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
import { granteeKeys, settingsQueryOptions } from '@/lib/contacts';
import {
    displayName,
    driveClient,
    driveError,
    driveKeys,
    formatDay,
    formatWhen,
} from '@/lib/drive';
import { currentNode, rotateAfterRevoke } from '@/lib/rotation';
import { sessionQueryOptions } from '@/lib/session';
import { cue } from '@/lib/sounds';

const ROLES: { value: ShareRole; label: string }[] = [
    { value: 'viewer', label: 'Can view' },
    { value: 'editor', label: 'Can edit' },
];
const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/*
 * Who can open an item: the people it is shared with, each with what they can
 * do, and the one link anyone can use. Sharing seals the item's key on this
 * device to a contact's checked key, so only contacts can be chosen; someone new
 * is added and checked right here, without leaving.
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
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[92svh] overflow-y-auto sm:max-w-[560px]">
                {node && <ShareForm key={node.id} node={node} onOpenChange={onOpenChange} />}
            </DialogContent>
        </Dialog>
    );
}

function ShareForm({
    node,
    onOpenChange,
}: {
    node: DriveNode;
    onOpenChange: (open: boolean) => void;
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
    /* An email being added as a contact: the dialog shows the check in its place. */
    const [adding, setAdding] = useState<string | null>(null);
    const [chosen, setChosen] = useState<ContactPin | null>(null);
    const [role, setRole] = useState<ShareRole>('viewer');
    /* 'share' while sealing, else the id of the share whose role is changing. */
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState('');
    const [stopping, setStopping] = useState<ShareView | null>(null);

    const contacts = Object.values(settings.data?.settings.contacts ?? {}).sort((a, b) =>
        a.name.localeCompare(b.name),
    );
    const already = new Set(shares.data?.map((share) => share.grantee.id) ?? []);
    const choices = contacts.filter((contact) => !already.has(contact.userId));
    const refresh = () => queryClient.invalidateQueries({ queryKey: sharesKey });

    async function share() {
        if (!chosen) return;
        setPending('share');
        setError('');
        try {
            const current = await currentNode(queryClient, node);
            await driveClient.share(current, await granteeKeys(userId, chosen), role);
            await refresh();
            await queryClient.invalidateQueries({ queryKey: driveKeys.mine });
            cue('success');
            toast.add({
                type: 'success',
                title: `“${node.name}” shared with ${chosen.name}`,
                description:
                    role === 'editor'
                        ? `${firstName(chosen.name)} can open, add and change what’s inside.`
                        : `${firstName(chosen.name)} can open and download it.`,
            });
            setChosen(null);
            setRole('viewer');
        } catch (cause) {
            cue('error');
            setError(driveError(cause));
        } finally {
            setPending(null);
        }
    }
    /* A new role is the same share sealed again with it; the server replaces the old one. */
    async function changeRole(target: ShareView, next: ShareRole) {
        const pin = settings.data?.settings.contacts[target.grantee.id];
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

    if (adding !== null)
        return (
            <>
                <DialogHeader>
                    <DialogTitle>Add a contact</DialogTitle>
                    <DialogDescription>
                        Then you can share “{node.name}” with them.
                    </DialogDescription>
                </DialogHeader>
                <CheckContact
                    userId={userId}
                    email={adding}
                    onCancel={() => setAdding(null)}
                    onAdded={(pin) => {
                        toast.add({ type: 'success', title: `${pin.name} added to your contacts` });
                        setAdding(null);
                        setChosen(pin);
                    }}
                />
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
                        <Button disabled={pending !== null} onClick={() => void share()}>
                            {pending === 'share' ? 'Sharing…' : 'Share'}
                        </Button>
                    </div>
                </div>
            ) : (
                <PeopleField
                    loading={settings.isPending}
                    contacts={choices}
                    anyContacts={contacts.length > 0}
                    onPick={setChosen}
                    onAdd={setAdding}
                />
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
                {shares.data?.map((entry) => {
                    const pinned = Boolean(settings.data?.settings.contacts[entry.grantee.id]);
                    return (
                        <div
                            key={entry.id}
                            data-share={entry.grantee.email}
                            data-suite={entry.suite}
                            className="flex h-16 items-center gap-3 border-b border-rule last:border-0"
                        >
                            <PersonAvatar name={entry.grantee.name} seed={entry.grantee.id} />
                            <span className="flex min-w-0 flex-1 flex-col">
                                <span className="truncate text-[15px] font-medium">
                                    {entry.grantee.name}
                                </span>
                                <span className="truncate text-[13px] text-muted-foreground">
                                    {entry.grantee.email}
                                </span>
                            </span>
                            <Select<string>
                                value={entry.role}
                                disabled={pending !== null}
                                onValueChange={(value) => {
                                    if (value === 'stop') setStopping(entry);
                                    else if (value) void changeRole(entry, value as ShareRole);
                                }}
                                items={[...ROLES, { value: 'stop', label: 'Stop sharing' }]}
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
                                            disabled={!pinned && option.value !== entry.role}
                                        >
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                    <SelectSeparator />
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
                })}
            </div>

            <LinksSection node={node} />

            <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Done
                </Button>
            </DialogFooter>

            <AlertDialog
                open={stopping !== null}
                onOpenChange={(value) => !value && setStopping(null)}
            >
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            Stop sharing with {stopping ? firstName(stopping.grantee.name) : ''}?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            They can’t open “{node.name}” in HushOS any more. Copies they already
                            downloaded stay with them. You can share it again later.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            onClick={() => {
                                const target = stopping;
                                setStopping(null);
                                if (target) void stop(target);
                            }}
                        >
                            Stop sharing
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
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
    contacts,
    anyContacts,
    onPick,
    onAdd,
}: {
    loading: boolean;
    contacts: ContactPin[];
    anyContacts: boolean;
    onPick: (contact: ContactPin) => void;
    onAdd: (email: string) => void;
}) {
    const id = useId();
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const typed = query.trim();
    const isEmail = EMAIL.test(typed);
    const known = contacts.some((contact) => contact.email.toLowerCase() === typed.toLowerCase());
    const matches = contacts.filter((contact) =>
        `${contact.name} ${contact.email}`.toLowerCase().includes(typed.toLowerCase()),
    );
    return (
        <CommandPrimitive
            label="Add people"
            shouldFilter={false}
            className="relative"
            onKeyDown={(event) => {
                if (event.key === 'Escape' && open) {
                    // Closes the list, not the dialog.
                    event.stopPropagation();
                    setOpen(false);
                }
            }}
        >
            <div className="flex h-11 items-center gap-2.5 rounded-md border border-input bg-card px-3 focus-within:outline-2 focus-within:-outline-offset-1 focus-within:outline-ring">
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
                            <span className="flex min-w-0 flex-col">
                                <span className="truncate text-sm font-medium">
                                    Add “{typed}” as a contact
                                </span>
                                <span className="text-[13px] text-muted-foreground">
                                    You’ll check it’s them first
                                </span>
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
                <div className="flex items-center gap-3 rounded-xl bg-muted p-4">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-card text-muted-foreground">
                        <Link2Icon className="size-[18px]" strokeWidth={2.2} aria-hidden="true" />
                    </span>
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
            await navigator.clipboard.writeText(await address());
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
    async function turnOff() {
        setBusy(true);
        try {
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
                {/* Amber marks "anyone with the link"; it stays on the icon, not the whole row. */}
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
                    <p className="text-[13px] text-muted-foreground">
                        Whoever scans it can open “{node.name}”
                        {link.hasPassword ? ' with the password' : ''}.
                    </p>
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

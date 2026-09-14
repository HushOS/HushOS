import type { DriveNode } from '@hushos/drive/client';
import type { ShareRole } from '@hushos/drive/api';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LinkIcon, Share2Icon, Trash2Icon, UserPlusIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useDrive } from '@/components/drive/drive-shell';
import { PendingLabel, Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { CopyValue } from '@/components/copy-value';
import { EXPIRIES, expiryDate, LinkRow, type Expiry } from '@/components/drive/link-row';
import { QrCode } from '@/components/qr-code';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { settingsQueryOptions } from '@/lib/contacts';
import { driveClient, driveError, driveKeys, formatWhen } from '@/lib/drive';
import { rotateAfterRevoke } from '@/lib/rotation';
import { cue } from '@/lib/sounds';

/*
 * Sharing a folder or file with a pinned contact. The node's key is sealed on
 * this device to the contact's identity key, so only someone whose fingerprint
 * was pinned can be chosen here; the server never sees the key. Existing
 * shares are listed with their role and can be revoked.
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
            <DialogContent className="sm:max-w-lg">
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
    const id = useId();
    const settings = useQuery(settingsQueryOptions(userId));
    const shares = useQuery({
        queryKey: [...driveKeys.all, 'shares', node.id],
        queryFn: () => driveClient.nodeShares(node),
        staleTime: 0,
    });
    const [contactId, setContactId] = useState('');
    const [role, setRole] = useState<ShareRole>('viewer');
    /* 'share' while sealing, else the id of the share being revoked. */
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState('');
    const contacts = Object.values(settings.data?.settings.contacts ?? {}).sort((a, b) =>
        a.name.localeCompare(b.name),
    );
    const already = new Set(shares.data?.map((share) => share.grantee.id) ?? []);
    const choices = contacts.filter((contact) => !already.has(contact.userId));

    async function share() {
        const contact = contacts.find((entry) => entry.userId === contactId);
        if (!contact) return;
        setPending('share');
        setError('');
        try {
            await driveClient.share(node, contact, role);
            await queryClient.invalidateQueries({
                queryKey: [...driveKeys.all, 'shares', node.id],
            });
            cue('success');
            toast.add({
                type: 'success',
                title: `“${node.name}” shared with ${contact.name}`,
                description:
                    role === 'editor'
                        ? 'They can view, add and change what is inside.'
                        : 'They can view and download what is inside.',
            });
            setContactId('');
        } catch (cause) {
            cue('error');
            setError(driveError(cause));
        } finally {
            setPending(null);
        }
    }
    async function revoke(shareId: string, name: string) {
        setPending(shareId);
        try {
            await driveClient.revokeShare(node, shareId);
            await queryClient.invalidateQueries({
                queryKey: [...driveKeys.all, 'shares', node.id],
            });
            cue('droplet');
            toast.add({
                type: 'success',
                title: `Sharing with ${name} stopped`,
                description: 'They lose access on their next request.',
            });
            void rotateAfterRevoke(queryClient, node);
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not stop sharing',
                description: driveError(cause),
            });
        } finally {
            setPending(null);
        }
    }

    return (
        <>
            <DialogHeader>
                <DialogTitle>Share “{node.name}”</DialogTitle>
                <DialogDescription>
                    The key is sealed on this device to a contact you have pinned; the server only
                    ever holds the sealed copy. Everything inside is included.
                </DialogDescription>
            </DialogHeader>
            <div className="flex min-w-0 flex-col border bg-card">
                <div className="grid sm:grid-cols-[9.5rem_minmax(0,1fr)]">
                    <label
                        htmlFor={id}
                        className="eyebrow flex h-12 items-center px-4 text-muted-foreground sm:border-r"
                    >
                        Contact
                    </label>
                    {settings.isPending ? (
                        <div className="flex h-12 items-center px-4">
                            <Spinner className="size-4 text-muted-foreground" />
                        </div>
                    ) : choices.length === 0 ? (
                        <p className="flex min-h-12 items-center px-4 font-mono text-xs text-muted-foreground">
                            {contacts.length === 0 ? (
                                <span>
                                    Nobody pinned yet.{' '}
                                    <Link to="/app/contacts" className="text-link">
                                        Add a contact
                                    </Link>{' '}
                                    first.
                                </span>
                            ) : (
                                'Every pinned contact already has this.'
                            )}
                        </p>
                    ) : (
                        <Select
                            value={contactId}
                            onValueChange={(value) => setContactId(value ?? '')}
                            items={choices.map((contact) => ({
                                value: contact.userId,
                                label: `${contact.name} · ${contact.email}`,
                            }))}
                        >
                            <SelectTrigger
                                id={id}
                                aria-label="Contact"
                                className="h-12 border-0 bg-transparent px-4 hover:bg-muted"
                            >
                                <SelectValue placeholder="Choose a pinned contact" />
                            </SelectTrigger>
                            <SelectContent>
                                {choices.map((contact) => (
                                    <SelectItem key={contact.userId} value={contact.userId}>
                                        {contact.name} · {contact.email}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    )}
                </div>
                <div className="grid border-t sm:grid-cols-[9.5rem_minmax(0,1fr)]">
                    <span className="eyebrow flex h-12 items-center px-4 text-muted-foreground sm:border-r">
                        Role
                    </span>
                    <div className="flex items-center gap-4 px-4 font-mono text-xs">
                        {(['viewer', 'editor'] as const).map((option) => (
                            <label key={option} className="flex h-12 items-center gap-2">
                                <input
                                    type="radio"
                                    name={`${id}-role`}
                                    value={option}
                                    checked={role === option}
                                    onChange={() => setRole(option)}
                                />
                                {option === 'viewer' ? 'Can view' : 'Can edit'}
                            </label>
                        ))}
                    </div>
                </div>
                {error && (
                    <p
                        role="alert"
                        className="border-t px-4 py-3 font-mono text-[11px] text-destructive"
                    >
                        {error}
                    </p>
                )}
            </div>
            <section className="flex flex-col gap-2">
                <h3 className="eyebrow text-muted-foreground">Shared with</h3>
                <div className="border bg-card">
                    {shares.isPending && (
                        <div className="flex h-12 items-center px-4">
                            <Spinner className="size-4 text-muted-foreground" />
                        </div>
                    )}
                    {shares.data && shares.data.length === 0 && (
                        <p className="px-4 py-3 font-mono text-xs text-muted-foreground">
                            Nobody yet.
                        </p>
                    )}
                    {shares.data && shares.data.length > 0 && (
                        <ul className="divide-y">
                            {shares.data.map((share) => (
                                <li
                                    key={share.id}
                                    data-share={share.grantee.email}
                                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm">{share.grantee.name}</p>
                                        <p className="font-mono text-[11px] text-muted-foreground">
                                            {share.grantee.email} ·{' '}
                                            {share.role === 'editor' ? 'can edit' : 'can view'} ·
                                            since {formatWhen(share.createdAt)}
                                        </p>
                                    </div>
                                    <Button
                                        variant="ghost"
                                        size="xs"
                                        aria-label={`Stop sharing with ${share.grantee.name}`}
                                        disabled={pending !== null}
                                        onClick={() => void revoke(share.id, share.grantee.name)}
                                    >
                                        <Trash2Icon />
                                        <span className="max-sm:sr-only">Stop</span>
                                    </Button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </section>
            <Links node={node} />
            <DialogFooter>
                <Button
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                    disabled={pending === 'share'}
                >
                    Done
                </Button>
                <Button onClick={() => void share()} disabled={pending !== null || !contactId}>
                    <PendingLabel pending={pending === 'share'} idle="Share" busy="Sealing" />
                    <UserPlusIcon aria-hidden="true" />
                </Button>
            </DialogFooter>
        </>
    );
}

/*
 * Links for anyone. The secret that opens the key rides in the URL fragment;
 * the server keeps a hash of the path token, the sealed key, and a copy of
 * the secret sealed under the node key that only the owner can open, which is
 * how a link can be shown again or changed later.
 */
function Links({ node }: { node: DriveNode }) {
    const queryClient = useQueryClient();
    const id = useId();
    const links = useQuery({
        queryKey: [...driveKeys.all, 'links', node.id],
        queryFn: () => driveClient.nodeLinks(node),
        staleTime: 0,
    });
    const refresh = () =>
        queryClient.invalidateQueries({ queryKey: [...driveKeys.all, 'links', node.id] });
    const [password, setPassword] = useState('');
    const [expiry, setExpiry] = useState<Expiry>('');
    const [pending, setPending] = useState(false);
    const [made, setMade] = useState<string | null>(null);
    const [error, setError] = useState('');
    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

    async function create() {
        setPending(true);
        setError('');
        try {
            const { token, secret } = await driveClient.createLink(node, {
                password: password.trim() ? password : null,
                expiresAt: expiryDate(expiry),
            });
            setMade(`${window.location.origin}/s/${token}#${secret}`);
            setPassword('');
            await refresh();
            cue('success');
        } catch (cause) {
            cue('error');
            setError(driveError(cause));
        } finally {
            setPending(false);
        }
    }

    return (
        <section className="flex flex-col gap-2">
            <h3 className="eyebrow text-muted-foreground">Links for anyone</h3>
            <div className="flex min-w-0 flex-col border bg-card">
                {made ? (
                    <div className="flex min-w-0 flex-col gap-3 px-4 py-3">
                        <CopyValue value={made} label="Link" wrap className="text-[13px]" />
                        <div className="flex flex-wrap items-center gap-2">
                            {canShare && (
                                <Button
                                    variant="outline"
                                    size="xs"
                                    onClick={() =>
                                        void navigator
                                            .share({ title: `${node.name} · HushOS`, url: made })
                                            .catch(() => {})
                                    }
                                >
                                    <Share2Icon />
                                    Share…
                                </Button>
                            )}
                            <Button variant="outline" size="xs" onClick={() => setMade(null)}>
                                Done
                            </Button>
                        </div>
                        <div className="flex flex-col items-center gap-2 border-t pt-3">
                            <div className="border bg-white p-3">
                                <QrCode value={made} kind="share" title={`Link to ${node.name}`} />
                            </div>
                            <p className="font-mono text-[11px] text-muted-foreground">
                                You can copy or show this link again from the list below.
                            </p>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="grid sm:grid-cols-[9.5rem_minmax(0,1fr)]">
                            <label
                                htmlFor={`${id}-password`}
                                className="eyebrow flex h-12 items-center px-4 text-muted-foreground sm:border-r"
                            >
                                Password
                            </label>
                            <Input
                                id={`${id}-password`}
                                type="password"
                                autoComplete="new-password"
                                placeholder="Optional"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                className="h-12 border-0 bg-transparent px-4 shadow-none focus-visible:ring-0"
                            />
                        </div>
                        <div className="grid border-t sm:grid-cols-[9.5rem_minmax(0,1fr)]">
                            <label
                                htmlFor={`${id}-expiry`}
                                className="eyebrow flex h-12 items-center px-4 text-muted-foreground sm:border-r"
                            >
                                Expires
                            </label>
                            <Select
                                value={expiry}
                                onValueChange={(value) => setExpiry((value ?? '') as Expiry)}
                                items={EXPIRIES.map((option) => ({
                                    value: option.value,
                                    label: option.label,
                                }))}
                            >
                                <SelectTrigger
                                    id={`${id}-expiry`}
                                    aria-label="Expires"
                                    className="h-12 border-0 bg-transparent px-4 hover:bg-muted"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    {EXPIRIES.map((option) => (
                                        <SelectItem key={option.value} value={option.value}>
                                            {option.label}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        {error && (
                            <p
                                role="alert"
                                className="border-t px-4 py-3 font-mono text-[11px] text-destructive"
                            >
                                {error}
                            </p>
                        )}
                        <div className="flex justify-end border-t px-4 py-2">
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={pending}
                                onClick={() => void create()}
                            >
                                <LinkIcon />
                                <PendingLabel pending={pending} idle="Create link" busy="Sealing" />
                            </Button>
                        </div>
                    </>
                )}
                {links.data && links.data.length > 0 && (
                    <ul className="divide-y border-t">
                        {links.data.map((link) => (
                            <LinkRow key={link.id} node={node} link={link} onChanged={refresh} />
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}

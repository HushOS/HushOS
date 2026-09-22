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
import { EXPIRIES, expiryDate, FIELD_ROW, LinkRow, type Expiry } from '@/components/drive/link-row';
import { QrCode } from '@/components/qr-code';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioItem } from '@/components/ui/radio-group';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { granteeKeys, settingsQueryOptions } from '@/lib/contacts';
import { driveClient, driveError, driveKeys, formatWhen } from '@/lib/drive';
import { currentNode, rotateAfterRevoke } from '@/lib/rotation';
import { cue } from '@/lib/sounds';

type Tab = 'people' | 'link';
const TABS: { value: Tab; label: string }[] = [
    { value: 'people', label: 'People' },
    { value: 'link', label: 'Link' },
];

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
    const [tab, setTab] = useState<Tab | null>(null);
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
            const current = await currentNode(queryClient, node);
            await driveClient.share(current, await granteeKeys(userId, contact), role);
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

    /* People first, always: sharing with someone you know is the safer default, and Link is one click away. */
    const active: Tab = tab ?? 'people';

    return (
        <>
            <DialogHeader>
                <DialogTitle>Share “{node.name}”</DialogTitle>
                <DialogDescription>
                    Choose someone from your contacts, or make a link anyone can open. Everything
                    inside is included.
                </DialogDescription>
            </DialogHeader>
            <fieldset
                aria-label="Share with"
                className="m-0 grid min-w-0 grid-cols-2 gap-0.5 rounded-md border-0 bg-muted p-0.5"
            >
                {TABS.map((entry) => (
                    <button
                        key={entry.value}
                        type="button"
                        aria-pressed={active === entry.value}
                        aria-controls={`${id}-${entry.value}`}
                        onClick={() => setTab(entry.value)}
                        className="h-8 rounded-xs text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-pressed:bg-card aria-pressed:font-semibold aria-pressed:text-foreground"
                    >
                        {entry.label}
                    </button>
                ))}
            </fieldset>
            {/* Both panels stay mounted so a link just made is still there after a look at People. */}
            <div
                id={`${id}-people`}
                hidden={active !== 'people'}
                className={active === 'people' ? 'flex min-w-0 flex-col gap-5' : 'hidden'}
            >
                <div className="flex min-w-0 flex-col divide-y divide-rule border-y border-rule">
                    <div className={FIELD_ROW}>
                        <label htmlFor={id} className="eyebrow text-muted-foreground">
                            Contact
                        </label>
                        {settings.isPending ? (
                            <div className="flex h-11 items-center">
                                <Spinner className="size-4 text-muted-foreground" />
                            </div>
                        ) : choices.length === 0 ? (
                            <p className="flex min-h-11 items-center text-sm text-muted-foreground">
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
                                    className="w-full min-w-0"
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
                    <div className={FIELD_ROW}>
                        <span className="eyebrow text-muted-foreground">Role</span>
                        <RadioGroup
                            name={`${id}-role`}
                            value={role}
                            onValueChange={(value) => setRole(value as ShareRole)}
                        >
                            <RadioItem value="viewer">Can view</RadioItem>
                            <RadioItem value="editor">Can edit</RadioItem>
                        </RadioGroup>
                    </div>
                    {error && (
                        <p role="alert" className="py-3 text-xs text-destructive">
                            {error}
                        </p>
                    )}
                </div>
                <section className="flex flex-col gap-1">
                    <h3 className="eyebrow text-muted-foreground">Shared with</h3>
                    {shares.isPending && (
                        <div className="flex h-11 items-center">
                            <Spinner className="size-4 text-muted-foreground" />
                        </div>
                    )}
                    {shares.data && shares.data.length === 0 && (
                        <p className="py-2 text-sm text-muted-foreground">Nobody yet.</p>
                    )}
                    {shares.data && shares.data.length > 0 && (
                        <ul className="divide-y divide-rule">
                            {shares.data.map((share) => (
                                <li
                                    key={share.id}
                                    data-share={share.grantee.email}
                                    className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5"
                                >
                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-semibold">
                                            {share.grantee.name}
                                        </p>
                                        <p className="text-xs text-muted-foreground tabular-nums">
                                            {share.grantee.email} ·{' '}
                                            {share.role === 'editor' ? 'can edit' : 'can view'} ·
                                            since {formatWhen(share.createdAt)} ·{' '}
                                            {share.suite === 2 ? 'post-quantum' : 'X25519 only'}
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
                </section>
            </div>
            <div id={`${id}-link`} hidden={active !== 'link'} className="min-w-0">
                <Links node={node} />
            </div>
            <DialogFooter>
                <Button
                    variant="outline"
                    onClick={() => onOpenChange(false)}
                    disabled={pending === 'share'}
                >
                    Done
                </Button>
                {active === 'people' && (
                    <Button onClick={() => void share()} disabled={pending !== null || !contactId}>
                        <PendingLabel pending={pending === 'share'} idle="Share" busy="Sealing" />
                        <UserPlusIcon aria-hidden="true" />
                    </Button>
                )}
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
    /* The link just made, shown once in full; gone again when it leaves the list. */
    const [made, setMade] = useState<{ id: string; url: string } | null>(null);
    const [error, setError] = useState('');
    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
    const shown = made && links.data?.some((link) => link.id === made.id) ? made.url : null;

    async function create() {
        setPending(true);
        setError('');
        try {
            const current = await currentNode(queryClient, node);
            const { link, token, secret } = await driveClient.createLink(current, {
                password: password.trim() ? password : null,
                expiresAt: expiryDate(expiry),
            });
            await refresh();
            setMade({ id: link.id, url: `${window.location.origin}/s/${token}#${secret}` });
            setPassword('');
            cue('success');
        } catch (cause) {
            cue('error');
            setError(driveError(cause));
        } finally {
            setPending(false);
        }
    }

    return (
        <section className="flex min-w-0 flex-col gap-1">
            <h3 className="eyebrow text-muted-foreground">Links for anyone</h3>
            <div className="flex min-w-0 flex-col">
                {shown ? (
                    <div className="flex min-w-0 flex-col gap-3 border-y border-rule py-3">
                        <CopyValue value={shown} label="Link" wrap className="text-[13px]" />
                        <div className="flex flex-wrap items-center gap-2">
                            {canShare && (
                                <Button
                                    variant="outline"
                                    size="xs"
                                    onClick={() =>
                                        void navigator
                                            .share({ title: `${node.name} · HushOS`, url: shown })
                                            .catch(() => {})
                                    }
                                >
                                    <Share2Icon />
                                    Share…
                                </Button>
                            )}
                            {/* Collapses the fresh link; "Done" here read as a second way to close the dialog. */}
                            <Button variant="outline" size="xs" onClick={() => setMade(null)}>
                                Hide
                            </Button>
                        </div>
                        <div className="flex flex-col items-center gap-2 border-t border-rule pt-3">
                            <div className="rounded-xs border border-rule bg-white p-3">
                                <QrCode value={shown} kind="share" title={`Link to ${node.name}`} />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                You can copy or show this link again from the list below.
                            </p>
                        </div>
                    </div>
                ) : (
                    <div className="flex min-w-0 flex-col divide-y divide-rule border-y border-rule">
                        <div className={FIELD_ROW}>
                            <label
                                htmlFor={`${id}-password`}
                                className="eyebrow text-muted-foreground"
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
                            />
                        </div>
                        <div className={FIELD_ROW}>
                            <label
                                htmlFor={`${id}-expiry`}
                                className="eyebrow text-muted-foreground"
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
                                    className="w-full min-w-0"
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
                            <p role="alert" className="py-3 text-xs text-destructive">
                                {error}
                            </p>
                        )}
                        <div className="flex justify-end py-3">
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
                    </div>
                )}
                {links.data && links.data.length > 0 && (
                    <ul className="divide-y divide-rule">
                        {links.data.map((link) => (
                            <LinkRow
                                key={link.id}
                                node={node}
                                link={link}
                                onChanged={refresh}
                                className="px-0"
                            />
                        ))}
                    </ul>
                )}
            </div>
        </section>
    );
}

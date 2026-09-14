import type { LinkView } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { useQueryClient } from '@tanstack/react-query';
import { CopyIcon, PencilIcon, QrCodeIcon, Share2Icon, Trash2Icon } from 'lucide-react';
import { useId, useState } from 'react';
import { QrCode } from '@/components/qr-code';
import { PendingLabel } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { toast } from '@/components/ui/toast';
import { driveClient, driveError, driveKeys, formatWhen } from '@/lib/drive';
import { rotateAfterRevoke } from '@/lib/rotation';
import { cue } from '@/lib/sounds';

/*
 * One link the owner made, wherever it is listed: copy it again, show it as a
 * QR code, hand it to the device's share sheet, change its password or expiry
 * without changing the link, or stop it. The URL is rebuilt on this device
 * from the sealed copy the server holds but cannot open.
 */

export const EXPIRIES = [
    { value: '', label: 'Never' },
    { value: '7', label: '7 days' },
    { value: '30', label: '30 days' },
    { value: '365', label: 'A year' },
] as const;
export type Expiry = (typeof EXPIRIES)[number]['value'];
export function expiryDate(expiry: Expiry) {
    return expiry ? new Date(Date.now() + Number(expiry) * 24 * 3600 * 1000).toISOString() : null;
}

export function describeLink(link: LinkView) {
    return [
        `Made ${formatWhen(link.createdAt)}`,
        link.hasPassword ? 'password' : null,
        link.expiresAt ? `until ${formatWhen(link.expiresAt)}` : null,
        link.useCount === 0
            ? 'not opened yet'
            : `opened ${link.useCount} ${link.useCount === 1 ? 'time' : 'times'}`,
    ]
        .filter(Boolean)
        .join(' · ');
}

export function LinkRow({
    node,
    link,
    title,
    onChanged,
}: {
    node: DriveNode;
    link: LinkView;
    /* Shown above the details when the row stands outside the node's own dialog. */
    title?: React.ReactNode;
    onChanged: () => Promise<unknown>;
}) {
    const queryClient = useQueryClient();
    const id = useId();
    const [pending, setPending] = useState<string | null>(null);
    const [qr, setQr] = useState<string | null>(null);
    const [editing, setEditing] = useState(false);
    const [password, setPassword] = useState('');
    const [clearPassword, setClearPassword] = useState(false);
    const [expiry, setExpiry] = useState<Expiry>('');
    const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

    async function url() {
        const value = await driveClient.linkUrl(node, link, window.location.origin);
        if (!value)
            throw new Error(
                'This link was made before links could be shown again. Make a new one.',
            );
        return value;
    }
    async function copy() {
        setPending('copy');
        try {
            await navigator.clipboard.writeText(await url());
            cue('success', { volume: 0.4 });
            toast.add({ type: 'success', title: 'Link copied' });
        } catch (error) {
            cue('error');
            toast.add({ type: 'error', title: 'Could not copy', description: driveError(error) });
        } finally {
            setPending(null);
        }
    }
    async function showQr() {
        setPending('qr');
        try {
            setQr(await url());
        } catch (error) {
            cue('error');
            toast.add({ type: 'error', title: 'Could not show', description: driveError(error) });
        } finally {
            setPending(null);
        }
    }
    async function share() {
        setPending('share');
        try {
            const value = await url();
            await navigator.share({ title: `${node.name} · HushOS`, url: value });
        } catch (error) {
            if (!(error instanceof Error && error.name === 'AbortError')) {
                cue('error');
                toast.add({
                    type: 'error',
                    title: 'Could not share',
                    description: driveError(error),
                });
            }
        } finally {
            setPending(null);
        }
    }
    async function save() {
        setPending('save');
        try {
            await driveClient.updateLink(node, link, {
                password: clearPassword ? null : password.trim() ? password : undefined,
                expiresAt: expiryDate(expiry),
            });
            await onChanged();
            await queryClient.invalidateQueries({ queryKey: [...driveKeys.all, 'mine'] });
            cue('success');
            toast.add({
                type: 'success',
                title: 'Link updated',
                description: 'The link itself is unchanged.',
            });
            setEditing(false);
            setPassword('');
            setClearPassword(false);
        } catch (error) {
            cue('error');
            toast.add({ type: 'error', title: 'Could not update', description: driveError(error) });
        } finally {
            setPending(null);
        }
    }
    async function stop() {
        setPending('stop');
        try {
            await driveClient.revokeLink(node, link.id);
            await onChanged();
            await queryClient.invalidateQueries({ queryKey: [...driveKeys.all, 'mine'] });
            cue('droplet');
            toast.add({
                type: 'success',
                title: 'Link stopped',
                description: 'It no longer opens.',
            });
            void rotateAfterRevoke(queryClient, node);
        } catch (error) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Could not stop the link',
                description: driveError(error),
            });
        } finally {
            setPending(null);
        }
    }

    const busy = pending !== null;
    return (
        <li data-link={link.id} className="flex flex-col gap-2 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <div className="min-w-0 flex-1">
                    {title}
                    <p className="font-mono text-[11px] text-muted-foreground">
                        {describeLink(link)}
                    </p>
                </div>
                <div className="flex items-center gap-0.5">
                    <Button
                        variant="ghost"
                        size="xs"
                        aria-label="Copy link"
                        disabled={busy}
                        onClick={() => void copy()}
                    >
                        <CopyIcon />
                        <span className="max-sm:sr-only">Copy</span>
                    </Button>
                    <Button
                        variant="ghost"
                        size="xs"
                        aria-label="Show QR code"
                        disabled={busy}
                        onClick={() => (qr ? setQr(null) : void showQr())}
                    >
                        <QrCodeIcon />
                        <span className="max-sm:sr-only">QR</span>
                    </Button>
                    {canShare && (
                        <Button
                            variant="ghost"
                            size="xs"
                            aria-label="Share link"
                            disabled={busy}
                            onClick={() => void share()}
                        >
                            <Share2Icon />
                            <span className="max-sm:sr-only">Share</span>
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="xs"
                        aria-label="Edit link"
                        aria-pressed={editing}
                        disabled={busy}
                        onClick={() => setEditing((on) => !on)}
                    >
                        <PencilIcon />
                        <span className="max-sm:sr-only">Edit</span>
                    </Button>
                    <Button
                        variant="ghost"
                        size="xs"
                        aria-label="Stop this link"
                        disabled={busy}
                        onClick={() => void stop()}
                    >
                        <Trash2Icon />
                        <span className="max-sm:sr-only">Stop</span>
                    </Button>
                </div>
            </div>
            {qr && (
                <div className="flex flex-col items-center gap-2 border-t pt-3">
                    <div className="border bg-white p-3">
                        <QrCode value={qr} kind="share" title={`Link to ${node.name}`} />
                    </div>
                    <p className="font-mono text-[11px] text-muted-foreground">
                        Whoever scans this can open it{link.hasPassword ? ' with the password' : ''}
                        .
                    </p>
                </div>
            )}
            {editing && (
                <form
                    noValidate
                    className="flex flex-col border-t pt-2"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <div className="grid sm:grid-cols-[9.5rem_minmax(0,1fr)]">
                        <label
                            htmlFor={`${id}-password`}
                            className="eyebrow flex h-11 items-center text-muted-foreground"
                        >
                            Password
                        </label>
                        <div className="flex items-center gap-3">
                            <Input
                                id={`${id}-password`}
                                type="password"
                                autoComplete="new-password"
                                placeholder={link.hasPassword ? 'Keep the current one' : 'None'}
                                value={password}
                                disabled={clearPassword}
                                onChange={(event) => setPassword(event.target.value)}
                                className="h-11 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
                            />
                            {link.hasPassword && (
                                <label className="flex items-center gap-2 font-mono text-[11px] whitespace-nowrap text-muted-foreground">
                                    <input
                                        type="checkbox"
                                        checked={clearPassword}
                                        onChange={(event) => setClearPassword(event.target.checked)}
                                    />
                                    Remove password
                                </label>
                            )}
                        </div>
                    </div>
                    <div className="grid sm:grid-cols-[9.5rem_minmax(0,1fr)]">
                        <label
                            htmlFor={`${id}-expiry`}
                            className="eyebrow flex h-11 items-center text-muted-foreground"
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
                                className="h-11 border-0 bg-transparent px-0 hover:bg-muted"
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
                    <div className="flex justify-end gap-2 pt-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="xs"
                            onClick={() => setEditing(false)}
                            disabled={busy}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" size="xs" disabled={busy}>
                            <PendingLabel pending={pending === 'save'} idle="Save" busy="Sealing" />
                        </Button>
                    </div>
                </form>
            )}
        </li>
    );
}

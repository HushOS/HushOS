import type { LinkView } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
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

/* A label beside its field; stacked where the container is narrow. */
export const FIELD_ROW =
    'grid items-center gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[8rem_minmax(0,1fr)]';

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
    className,
    onChanged,
}: {
    node: DriveNode;
    link: LinkView;
    /* Shown above the details when the row stands outside the node's own dialog. */
    title?: React.ReactNode;
    className?: string;
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
        <li data-link={link.id} className={cn('@container flex flex-col px-4 py-2.5', className)}>
            {/* Details on one line and the actions on the next, flush with them; one line only where the row is wide. */}
            <div className="flex flex-col gap-1 @2xl:flex-row @2xl:items-center @2xl:gap-x-3">
                <div className="min-w-0 flex-1">
                    {title}
                    <p className="text-xs text-muted-foreground tabular-nums">
                        {describeLink(link)}
                    </p>
                </div>
                <div className="-ml-2 flex items-center gap-0.5 @2xl:ml-auto">
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
                <div className="mt-2 flex flex-col items-center gap-2 border-t border-rule pt-3">
                    <div className="rounded-xs border border-rule bg-white p-3">
                        <QrCode value={qr} kind="share" title={`Link to ${node.name}`} />
                    </div>
                    <p className="text-xs text-muted-foreground">
                        Whoever scans this can open it{link.hasPassword ? ' with the password' : ''}
                        .
                    </p>
                </div>
            )}
            {editing && (
                <form
                    noValidate
                    className="mt-2.5 flex flex-col divide-y divide-rule border-t border-rule"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <div className={FIELD_ROW}>
                        <label htmlFor={`${id}-password`} className="eyebrow text-muted-foreground">
                            Password
                        </label>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                            <Input
                                id={`${id}-password`}
                                type="password"
                                autoComplete="new-password"
                                placeholder={link.hasPassword ? 'Keep the current one' : 'None'}
                                value={password}
                                disabled={clearPassword}
                                onChange={(event) => setPassword(event.target.value)}
                                className="min-w-40 flex-1"
                            />
                            {link.hasPassword && (
                                <label className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground">
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
                    <div className={FIELD_ROW}>
                        <label htmlFor={`${id}-expiry`} className="eyebrow text-muted-foreground">
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
                    <div className="flex justify-end gap-2 pt-3 pb-0.5">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setEditing(false)}
                            disabled={busy}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" size="sm" disabled={busy}>
                            <PendingLabel pending={pending === 'save'} idle="Save" busy="Sealing" />
                        </Button>
                    </div>
                </form>
            )}
        </li>
    );
}

import type { LinkView } from '@hushos/drive/api';
import type { DriveNode } from '@hushos/drive/client';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { driveClient, driveError, driveKeys, formatDay } from '@/lib/drive';
import { cue } from '@/lib/sounds';

/*
 * A link anyone can open, as its owner sees it: one line saying how it stands,
 * and a small dialog for its password and end date. The link's address never
 * changes when these do. The URL is rebuilt on this device from the sealed copy
 * the server holds but cannot open.
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

const longDate = (iso: string) => formatDay(iso);

/* "Opened 3 times · ends 12 Oct · password", or "Not opened yet". */
export function describeLink(link: LinkView) {
    return [
        link.useCount === 0
            ? 'Not opened yet'
            : `Opened ${link.useCount === 1 ? 'once' : `${link.useCount} times`}`,
        link.expiresAt ? `ends ${longDate(link.expiresAt)}` : null,
        link.hasPassword ? 'password' : null,
    ]
        .filter(Boolean)
        .join(' · ');
}

/*
 * Password and end date for one link. The password is typed into the link on this
 * device by whoever opens it; it never reaches the server. The end date keeps what
 * it was unless another is chosen.
 */
export function LinkOptionsDialog({
    node,
    link,
    open,
    onOpenChange,
    onChanged,
    onTurnOff,
}: {
    node: DriveNode;
    link: LinkView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChanged: () => Promise<unknown>;
    onTurnOff: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[460px]">
                <LinkOptionsForm
                    node={node}
                    link={link}
                    onDone={() => onOpenChange(false)}
                    onChanged={onChanged}
                    onTurnOff={onTurnOff}
                />
            </DialogContent>
        </Dialog>
    );
}

function LinkOptionsForm({
    node,
    link,
    onDone,
    onChanged,
    onTurnOff,
}: {
    node: DriveNode;
    link: LinkView;
    onDone: () => void;
    onChanged: () => Promise<unknown>;
    onTurnOff: () => void;
}) {
    const queryClient = useQueryClient();
    const id = useId();
    const [password, setPassword] = useState('');
    const [removePassword, setRemovePassword] = useState(false);
    /* 'keep' leaves the end date as it is; the rest set a new one from today. */
    const [ends, setEnds] = useState<Expiry | 'keep'>(link.expiresAt ? 'keep' : '');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const options: { value: Expiry | 'keep'; label: string }[] = [
        ...(link.expiresAt ? [{ value: 'keep' as const, label: longDate(link.expiresAt) }] : []),
        ...EXPIRIES,
    ];

    async function save() {
        setSaving(true);
        setError('');
        try {
            await driveClient.updateLink(node, link, {
                password: removePassword ? null : password.trim() ? password : undefined,
                expiresAt: ends === 'keep' ? undefined : expiryDate(ends),
            });
            await onChanged();
            await queryClient.invalidateQueries({ queryKey: driveKeys.mine });
            cue('success');
            toast.add({
                type: 'success',
                title: 'Link updated',
                description: 'The link itself is the same.',
            });
            onDone();
        } catch (cause) {
            cue('error');
            setError(driveError(cause));
        } finally {
            setSaving(false);
        }
    }

    return (
        <form
            noValidate
            className="contents"
            onSubmit={(event) => {
                event.preventDefault();
                void save();
            }}
        >
            <DialogHeader>
                <DialogTitle>Password and end date</DialogTitle>
                <DialogDescription className="wrap-anywhere">{node.name}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
                <label htmlFor={`${id}-password`} className="text-[13px] font-semibold">
                    Password
                </label>
                <Input
                    id={`${id}-password`}
                    type="password"
                    autoComplete="new-password"
                    placeholder={link.hasPassword ? 'Keep the current password' : 'None'}
                    value={password}
                    disabled={removePassword}
                    onChange={(event) => setPassword(event.target.value)}
                    className="text-[15px]"
                />
                <p className="text-[13px] text-muted-foreground">
                    Whoever opens the link types it on their device. It never reaches us.
                </p>
                {link.hasPassword && (
                    <label
                        htmlFor={`${id}-remove`}
                        className="flex items-center gap-2.5 pt-1 text-sm"
                    >
                        <Checkbox
                            id={`${id}-remove`}
                            checked={removePassword}
                            onCheckedChange={(value) => setRemovePassword(value === true)}
                        />
                        Remove the password
                    </label>
                )}
            </div>
            <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
                <legend className="mb-1.5 text-[13px] font-semibold">Ends</legend>
                <div className="flex rounded-md border border-input bg-card p-0.5">
                    {options.map((option) => (
                        <button
                            key={option.value}
                            type="button"
                            aria-pressed={ends === option.value}
                            onClick={() => setEnds(option.value)}
                            className={cn(
                                'flex h-9 min-w-0 flex-1 cursor-pointer items-center justify-center rounded-sm px-2 text-sm whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-ring',
                                ends === option.value
                                    ? 'bg-accent font-semibold text-accent-foreground'
                                    : 'text-muted-foreground hover:text-foreground',
                            )}
                        >
                            {option.label}
                        </button>
                    ))}
                </div>
            </fieldset>
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            )}
            <DialogFooter>
                <button
                    type="button"
                    onClick={onTurnOff}
                    className="mr-auto cursor-pointer text-sm font-semibold text-destructive underline underline-offset-4 max-sm:order-last max-sm:self-center"
                >
                    Turn off link
                </button>
                <Button type="button" variant="outline" disabled={saving} onClick={onDone}>
                    Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                    {saving ? 'Saving…' : 'Save'}
                </Button>
            </DialogFooter>
        </form>
    );
}

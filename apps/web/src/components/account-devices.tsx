import type { AccountDevice, DeviceApproval, DeviceKind } from '@hushos/auth/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { DialogField, Setting, SettingsGroup } from '@/components/settings';
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
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { formatDay } from '@/lib/drive';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

/*
 * Your devices (docs/devices-design.md, step 1): every browser and phone signed
 * in to the account, how each got in and when it was last seen, with Rename and
 * Remove. This browser has no Remove; signing out is how it leaves. The copy
 * says what removal does and what it cannot: a removed device is signed out,
 * but whatever it already holds may stay on it.
 */

export const devicesQueryOptions = {
    queryKey: ['account', 'devices'] as const,
    queryFn: () => authClient.devices(),
    staleTime: 15_000,
};

const kindWords: Record<DeviceKind, string> = {
    web: 'Browser',
    ios: 'iPhone or iPad',
    android: 'Android',
};
const unnamed: Record<DeviceKind, string> = {
    web: 'A web browser',
    ios: 'iPhone',
    android: 'Android phone',
};

export function deviceLabel(device: Pick<AccountDevice, 'kind' | 'name'>) {
    return device.name ?? (device.kind ? unnamed[device.kind] : 'Unknown device');
}

const approvals: Record<DeviceApproval, string> = {
    enrolment: 'Where you created your account',
    password: 'Signed in with your password',
    existing: 'Already signed in when HushOS began listing devices',
    device: 'Approved by another of your devices',
    phrase: 'Approved with your recovery phrase',
    'email-wait': 'Approved after the email wait',
    guardian: 'Approved by a guardian',
};

/*
 * The day only: the server rounds last-seen to the hour, because every session on the
 * account reads this list, and a time of day would say when the owner is up.
 */
function seenOn(iso: string) {
    const date = new Date(iso);
    const now = new Date();
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (date.toDateString() === now.toDateString()) return 'today';
    if (date.toDateString() === yesterday.toDateString()) return 'yesterday';
    return formatDay(iso);
}

function activity(device: AccountDevice) {
    const when = seenOn(device.lastSeenAt);
    return device.signedIn ? `Active ${when}` : `Signed out · Last active ${when}`;
}

type Pending =
    | { kind: 'rename'; device: AccountDevice }
    | { kind: 'remove'; device: AccountDevice }
    | { kind: 'remove-others'; count: number }
    | null;

export function AccountDevices() {
    const queryClient = useQueryClient();
    const devices = useQuery(devicesQueryOptions);
    const [pending, setPending] = useState<Pending>(null);
    const list = devices.data?.devices ?? [];
    const others = list.filter((device) => !device.current);
    const refresh = () => queryClient.invalidateQueries({ queryKey: devicesQueryOptions.queryKey });
    return (
        <div id="devices" className="scroll-mt-20">
            <SettingsGroup title="Your devices" description="Where your account is signed in.">
                {devices.isPending ? (
                    <div className="flex flex-col gap-2 py-4" aria-busy="true">
                        <Skeleton className="h-5 w-48" />
                        <Skeleton className="h-4 w-72" />
                    </div>
                ) : devices.isError ? (
                    <Setting
                        label="Devices"
                        action={
                            <Button variant="outline" onClick={() => void devices.refetch()}>
                                Try again
                            </Button>
                        }
                    >
                        <span role="alert" className="text-destructive">
                            Your devices couldn’t be loaded.
                        </span>
                    </Setting>
                ) : (
                    <>
                        <ul aria-label="Your devices" className="m-0 list-none p-0">
                            {list.map((device) => (
                                <li key={device.id} data-device-id={device.id}>
                                    <DeviceRow
                                        device={device}
                                        onRename={() => setPending({ kind: 'rename', device })}
                                        onRemove={() => setPending({ kind: 'remove', device })}
                                    />
                                </li>
                            ))}
                        </ul>
                        {others.length > 0 && (
                            <div className="flex justify-end pt-2">
                                <Button
                                    variant="destructive-outline"
                                    onClick={() =>
                                        setPending({ kind: 'remove-others', count: others.length })
                                    }
                                >
                                    Remove all other devices
                                </Button>
                            </div>
                        )}
                    </>
                )}
            </SettingsGroup>
            <RenameDialog
                device={pending?.kind === 'rename' ? pending.device : null}
                onClose={() => setPending(null)}
                onDone={refresh}
            />
            <RemoveDialog
                pending={
                    pending?.kind === 'remove' || pending?.kind === 'remove-others' ? pending : null
                }
                onClose={() => setPending(null)}
                onDone={refresh}
            />
        </div>
    );
}

function DeviceRow({
    device,
    onRename,
    onRemove,
}: {
    device: AccountDevice;
    onRename: () => void;
    onRemove: () => void;
}) {
    const name = deviceLabel(device);
    return (
        <Setting
            label={device.kind ? kindWords[device.kind] : 'Unknown'}
            action={
                <>
                    <Button variant="ghost" onClick={onRename} aria-label={`Rename ${name}`}>
                        Rename
                    </Button>
                    {!device.current && (
                        <Button
                            variant="destructive-outline"
                            onClick={onRemove}
                            aria-label={`Remove ${name}`}
                        >
                            Remove
                        </Button>
                    )}
                </>
            }
        >
            <div className="flex min-w-0 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-medium wrap-anywhere">{name}</span>
                    {device.current && <Badge>This browser</Badge>}
                </span>
                <span className="text-[13px] text-muted-foreground">
                    {device.approvedBy ? `${approvals[device.approvedBy]} · ` : ''}
                    {activity(device)}
                </span>
            </div>
        </Setting>
    );
}

function RenameDialog({
    device,
    onClose,
    onDone,
}: {
    device: AccountDevice | null;
    onClose: () => void;
    onDone: () => Promise<unknown>;
}) {
    const [draft, setDraft] = useState('');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [shownFor, setShownFor] = useState<string | null>(null);
    // A dialog opened for another device starts from that device's name.
    if (device && shownFor !== device.id) {
        setShownFor(device.id);
        setDraft(device.name ?? '');
        setError('');
    }
    async function save() {
        if (!device) return;
        const name = draft.trim();
        if (!name) return setError('Enter a name.');
        if (Array.from(name).length > 40) return setError('Use no more than 40 characters.');
        setSaving(true);
        setError('');
        try {
            await authClient.renameDevice(device.id, name);
            cue('success');
            await onDone();
            onClose();
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setSaving(false);
        }
    }
    return (
        <Dialog
            open={device !== null}
            onOpenChange={(open) => {
                if (!open && !saving) {
                    setShownFor(null);
                    onClose();
                }
            }}
        >
            <DialogContent className="sm:max-w-[440px]">
                <form
                    noValidate
                    className="flex flex-col gap-5"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>Rename device</DialogTitle>
                        <DialogDescription>
                            Shown in your list of devices. Device names aren’t encrypted.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogField
                        label="Name"
                        value={draft}
                        maxLength={40}
                        autoComplete="off"
                        disabled={saving}
                        error={error}
                        onChange={(event) => setDraft(event.target.value)}
                    />
                    <DialogFooter>
                        <Button
                            type="button"
                            variant="ghost"
                            disabled={saving}
                            onClick={() => {
                                setShownFor(null);
                                onClose();
                            }}
                        >
                            Cancel
                        </Button>
                        <Button type="submit" disabled={saving}>
                            {saving ? 'Saving…' : 'Save name'}
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

function RemoveDialog({
    pending,
    onClose,
    onDone,
}: {
    pending:
        | { kind: 'remove'; device: AccountDevice }
        | { kind: 'remove-others'; count: number }
        | null;
    onClose: () => void;
    onDone: () => Promise<unknown>;
}) {
    const [removing, setRemoving] = useState(false);
    const [error, setError] = useState('');
    const [password, setPassword] = useState('');
    const single = pending?.kind === 'remove' ? pending.device : null;
    const count = pending?.kind === 'remove-others' ? pending.count : 1;
    const many = count > 1;
    const title = single ? `Remove ${deviceLabel(single)}?` : 'Remove all other devices?';
    const verb = single ? 'Remove' : 'Remove all other devices';
    async function remove() {
        if (!pending) return;
        if (!password) return setError('Enter your password.');
        setRemoving(true);
        setError('');
        try {
            if (pending.kind === 'remove')
                await authClient.removeDevice(pending.device.id, password);
            else await authClient.removeOtherDevices(password);
            setPassword('');
            cue('close');
            toast.add({
                title: pending.kind === 'remove' ? 'Device removed' : 'Other devices removed',
            });
            await onDone();
            onClose();
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setRemoving(false);
        }
    }
    return (
        <AlertDialog
            open={pending !== null}
            onOpenChange={(open) => {
                if (!open && !removing) {
                    setError('');
                    setPassword('');
                    onClose();
                }
            }}
        >
            <AlertDialogContent>
                <form
                    noValidate
                    className="contents"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void remove();
                    }}
                >
                    <AlertDialogHeader>
                        <AlertDialogTitle>{title}</AlertDialogTitle>
                        <AlertDialogDescription>
                            {many
                                ? `${count} devices are signed out at once and need your password to sign in again. Anything already on them, such as files kept there, may stay there. If one was lost or stolen, change your password too.`
                                : 'It’s signed out at once and needs your password to sign in again. Anything already on it, such as files kept there, may stay there. If it was lost or stolen, change your password too.'}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <DialogField
                        label="Your password"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        disabled={removing}
                        error={error}
                        hint="Removing a device asks for your password."
                        onChange={(event) => setPassword(event.target.value)}
                    />
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
                        <Button
                            type="submit"
                            variant="destructive"
                            disabled={removing || !password}
                        >
                            {removing ? 'Removing…' : verb}
                        </Button>
                    </AlertDialogFooter>
                </form>
            </AlertDialogContent>
        </AlertDialog>
    );
}

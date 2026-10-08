import type { SessionUser } from '@hushos/auth/protocol';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@hushos/auth/protocol';
import { useRouter } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { DialogField } from '@/components/settings';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

/*
 * The account's heavy actions, each a dialog that asks once: change the
 * password, make a new recovery phrase, reset sharing keys (a new master key),
 * delete the account. They change what the password and phrase unlock, so
 * every one asks for the password; the server proves it with OPAQUE and it
 * never leaves this device.
 */

function Shell({
    open,
    onOpenChange,
    pending,
    title,
    description,
    children,
    footer,
    onSubmit,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    pending: boolean;
    title: string;
    description?: ReactNode;
    children: ReactNode;
    footer: ReactNode;
    onSubmit: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
            <DialogContent className="sm:max-w-[480px]">
                <form
                    noValidate
                    aria-busy={pending}
                    className="contents"
                    onSubmit={(event) => {
                        event.preventDefault();
                        onSubmit();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        {description && <DialogDescription>{description}</DialogDescription>}
                    </DialogHeader>
                    {children}
                    <DialogFooter>{footer}</DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

export function ChangePasswordDialog({
    user,
    open,
    onOpenChange,
    onChanged,
}: {
    user: SessionUser;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChanged: () => void;
}) {
    const router = useRouter();
    const [current, setCurrent] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [tried, setTried] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const errors = {
        current: current ? '' : 'Enter your current password.',
        next:
            next.length < PASSWORD_MIN_LENGTH
                ? `Use at least ${PASSWORD_MIN_LENGTH} characters.`
                : next === current
                  ? 'Choose a password you haven’t used here.'
                  : '',
        confirm: confirm === next ? '' : 'The new passwords don’t match.',
    };
    function reset() {
        setCurrent('');
        setNext('');
        setConfirm('');
        setTried(false);
        setError('');
    }
    async function submit() {
        setTried(true);
        if (errors.current || errors.next || errors.confirm) return;
        setPending(true);
        setError('');
        try {
            const result = await authClient.changeSecurity(user, 'password', current, next);
            cue('success');
            router.options.context.queryClient.clear();
            if (!result.signedIn) {
                await router.navigate({
                    to: '/login',
                    search: { securityChanged: result.uncertain ? 'uncertain' : 'password' },
                    replace: true,
                });
                return;
            }
            await router.invalidate();
            reset();
            onOpenChange(false);
            onChanged();
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <Shell
            open={open}
            onOpenChange={(value) => {
                if (!value) reset();
                onOpenChange(value);
            }}
            pending={pending}
            title="Change password"
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={pending}
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" disabled={pending}>
                        {pending ? 'Changing…' : 'Change password'}
                    </Button>
                </>
            }
        >
            <DialogField
                label="Current password"
                type="password"
                autoComplete="current-password"
                maxLength={PASSWORD_MAX_LENGTH}
                value={current}
                disabled={pending}
                onChange={(event) => setCurrent(event.target.value)}
                error={tried ? errors.current : undefined}
            />
            <DialogField
                label="New password"
                type="password"
                autoComplete="new-password"
                maxLength={PASSWORD_MAX_LENGTH}
                value={next}
                disabled={pending}
                onChange={(event) => setNext(event.target.value)}
                hint={`At least ${PASSWORD_MIN_LENGTH} characters. A few unrelated words work well.`}
                error={tried ? errors.next : undefined}
            />
            <DialogField
                label="Confirm new password"
                type="password"
                autoComplete="new-password"
                maxLength={PASSWORD_MAX_LENGTH}
                value={confirm}
                disabled={pending}
                onChange={(event) => setConfirm(event.target.value)}
                error={
                    (tried || confirm.length >= next.length) && confirm ? errors.confirm : undefined
                }
            />
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            )}
            <p className="text-[13px] text-muted-foreground">
                Your other devices will be signed out. Your recovery phrase stays the same.
            </p>
        </Shell>
    );
}

/*
 * A new recovery phrase, or a new master key (said as "reset sharing keys").
 * Both end on the page that shows the new 24 words and waits until they are saved.
 */
export function NewKeyDialog({
    user,
    action,
    open,
    onOpenChange,
}: {
    user: SessionUser;
    action: 'recovery-key' | 'master-key';
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const [password, setPassword] = useState('');
    const [tried, setTried] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const keys = action === 'master-key';
    async function submit() {
        setTried(true);
        if (!password) return;
        setPending(true);
        setError('');
        try {
            const result = await authClient.changeSecurity(user, action, password, '');
            cue('success');
            router.options.context.queryClient.clear();
            if (!result.signedIn) {
                await router.navigate({
                    to: '/login',
                    search: { securityChanged: result.uncertain ? 'uncertain' : action },
                    replace: true,
                });
                return;
            }
            await router.navigate({
                to: '/setup/recovery-key',
                search: { reason: action },
                replace: true,
            });
        } catch (cause) {
            cue('error');
            setError(authError(cause));
            setPending(false);
        }
    }
    return (
        <Shell
            open={open}
            onOpenChange={(value) => {
                if (!value) {
                    setPassword('');
                    setTried(false);
                    setError('');
                }
                onOpenChange(value);
            }}
            pending={pending}
            title={keys ? 'Reset sharing keys?' : 'Make a new recovery phrase?'}
            description={
                keys
                    ? undefined
                    : 'Your current phrase and any kit you saved stop working. You’ll save the new one straight away.'
            }
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={pending}
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" disabled={pending}>
                        {pending
                            ? keys
                                ? 'Resetting…'
                                : 'Making…'
                            : keys
                              ? 'Reset sharing keys'
                              : 'Make a new phrase'}
                    </Button>
                </>
            }
        >
            {keys && (
                <div className="flex flex-col gap-2 text-[15px]">
                    <p>Use this if you think someone saw your password or recovery phrase.</p>
                    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
                        <li>You get a new recovery phrase. The old one stops working.</li>
                        <li>Your other devices are signed out.</li>
                        <li>Your files, shares and links stay as they are.</li>
                    </ul>
                </div>
            )}
            <DialogField
                label="Password"
                type="password"
                autoComplete="current-password"
                maxLength={PASSWORD_MAX_LENGTH}
                value={password}
                disabled={pending}
                onChange={(event) => setPassword(event.target.value)}
                hint="Enter your password to confirm."
                error={tried && !password ? 'Enter your password.' : undefined}
            />
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            )}
        </Shell>
    );
}

/* Delete account: the password and DELETE, the same two things the phones ask for. */
export function DeleteAccountDialog({
    open,
    onOpenChange,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const [password, setPassword] = useState('');
    const [typed, setTyped] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const ready = password.length > 0 && typed === 'DELETE';
    async function submit() {
        if (!ready) return;
        setPending(true);
        setError('');
        try {
            await authClient.deleteAccount(password);
            router.options.context.queryClient.clear();
            await router.invalidate();
            await router.navigate({ to: '/account-deleted', replace: true });
        } catch (cause) {
            cue('error');
            setError(authError(cause));
            setPending(false);
        }
    }
    return (
        <Shell
            open={open}
            onOpenChange={(value) => {
                if (!value) {
                    setPassword('');
                    setTyped('');
                    setError('');
                }
                onOpenChange(value);
            }}
            pending={pending}
            title="Delete your account?"
            description="Deleting removes every file, every earlier version, every share and link, and the account itself. It can’t be undone."
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={pending}
                        onClick={() => onOpenChange(false)}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" variant="destructive" disabled={!ready || pending}>
                        {pending ? 'Deleting…' : 'Delete forever'}
                    </Button>
                </>
            }
        >
            <DialogField
                label="Password"
                type="password"
                autoComplete="current-password"
                maxLength={PASSWORD_MAX_LENGTH}
                value={password}
                disabled={pending}
                onChange={(event) => setPassword(event.target.value)}
            />
            <DialogField
                label="Type DELETE to confirm"
                autoComplete="off"
                spellCheck={false}
                placeholder="DELETE"
                className="font-mono"
                value={typed}
                disabled={pending}
                onChange={(event) => setTyped(event.target.value)}
            />
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            )}
        </Shell>
    );
}

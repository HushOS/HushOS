import type { SessionUser } from '@hushos/auth/protocol';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@hushos/auth/protocol';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { StepCancelled } from '@hushos/auth/client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DialogField } from '@/components/settings';
import {
    STEP_LIMIT_MS,
    StepChoices,
    StepField,
    useStepPrompt,
    type StepPrompt,
} from '@/components/two-step-prompt';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { succeedIdentity } from '@/lib/contacts';
import { driveClient, driveError, driveOpenQueryOptions } from '@/lib/drive';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';
import { forgetDevice } from '@/lib/sign-out';
import { holdPhrase } from '@/lib/unconfirmed-phrase';
import { LostReplyPhrase } from '@/components/recovery-phrase';

/*
 * The account's heavy actions, each a dialog that asks once: change the
 * password, make a new recovery phrase, rotate the account key (a new master
 * key), replace sharing keys (a new identity), delete the account. Those that
 * change what the password and phrase unlock ask for the password; the server
 * proves it with OPAQUE and it never leaves this device. On an account with
 * two-step sign-in they then ask for the second step, in the same dialog, before
 * anything changes (docs/two-step-design.md 4).
 */

/*
 * Proving the password for one of these changes locks this browser first, as it always has.
 * Someone who then backs out of the second step changed nothing, so the saved unlock opens
 * it again rather than leave them to type the password once more. The dialog stays busy
 * until that has settled: a second try started while it runs would cut it short, and be
 * refused as a lock.
 */
function reopen(user: SessionUser) {
    return authClient.restore(user).catch(() => {});
}

/*
 * Said when a dialog gives up on a step left unanswered (STEP_LIMIT_MS): it was holding the
 * password, and what was typed is cleared with it.
 */
export const STEP_GAVE_UP = 'That took too long, so nothing was changed. Start again.';

/* The server's words for a change that needs the second step. */
export const STEP_ASKED = 'Confirm it’s you with your second step.';

/*
 * What a dialog shows while the auth client asks for the second step: the field, the other
 * ways to answer, Back, and the dialog's own action, since the answer is what commits it.
 */
export function StepView({
    step,
    action,
    busy,
    destructive = false,
}: {
    step: StepPrompt;
    action: string;
    busy: string;
    destructive?: boolean;
}) {
    return (
        <>
            <StepField prompt={step} />
            <StepChoices prompt={step} />
            <DialogFooter>
                <Button
                    type="button"
                    variant="outline"
                    disabled={step.checking}
                    onClick={step.cancel}
                >
                    Back
                </Button>
                <Button
                    type="submit"
                    variant={destructive ? 'destructive' : 'default'}
                    disabled={step.checking}
                >
                    {step.checking ? busy : action}
                </Button>
            </DialogFooter>
        </>
    );
}

/* One of the account's dialogs: a form with its title, what it asks for, and its actions. */
export function AccountDialog({
    open,
    onOpenChange,
    pending,
    locked = false,
    title,
    description,
    children,
    footer,
    onSubmit,
    step,
    stepAction,
    sticky = false,
    view = '',
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    pending: boolean;
    /* It shows something shown only once: nothing but its own button closes it. */
    locked?: boolean;
    /*
     * It holds something a stray click or Esc must not throw away (an authenticator app half
     * set up): only its buttons and its close control close it.
     */
    sticky?: boolean;
    /* Which of its views a dialog with several is showing: focus moves in when it changes. */
    view?: string;
    title: string;
    description?: ReactNode;
    children: ReactNode;
    footer: ReactNode;
    onSubmit: () => void;
    /* The second step, and what the dialog's action is called while it is asked for. */
    step?: StepPrompt;
    stepAction?: { action: string; busy: string; destructive?: boolean };
}) {
    const asking = Boolean(step?.request);
    /*
     * A dialog that swaps what it shows (the password, then the step, then what came of it)
     * takes the focus with it: the view's own starting point (`data-focus`), else its first
     * field. Without this the focus stays on a field that is gone, which is nowhere.
     */
    const form = useRef<HTMLFormElement>(null);
    const opened = useRef(false);
    useEffect(() => {
        const first = !opened.current;
        opened.current = open;
        // Opening is the dialog's own to handle; the step's field takes the focus itself.
        if (!open || first || asking) return;
        const enter = () =>
            form.current
                ?.querySelector<HTMLElement>(
                    '[data-focus], input:not([disabled]), textarea:not([disabled])',
                )
                ?.focus();
        enter();
        // Once more a frame later: the dialog itself takes the focus back to its frame when
        // the element that held it is removed, and that can come after this.
        const frame = requestAnimationFrame(enter);
        return () => cancelAnimationFrame(frame);
        // Also when it stops being busy: its fields were disabled meanwhile, and lost the focus.
    }, [open, view, asking, pending]);
    return (
        <Dialog
            open={open}
            onOpenChange={(next, details) => {
                if (locked) return;
                if (
                    sticky &&
                    !next &&
                    (details.reason === 'escape-key' || details.reason === 'outside-press')
                )
                    return;
                // Closing while the step is asked backs out of the step, to the form before it.
                if (!next && step?.request && !step.checking) step.cancel();
                else if (!pending) onOpenChange(next);
            }}
        >
            <DialogContent className="sm:max-w-[480px]" showCloseButton={!locked}>
                <form
                    ref={form}
                    noValidate
                    aria-busy={pending}
                    className="contents"
                    onSubmit={(event) => {
                        event.preventDefault();
                        if (step?.request) step.submit();
                        else onSubmit();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>{title}</DialogTitle>
                        {asking ? (
                            <DialogDescription>{STEP_ASKED}</DialogDescription>
                        ) : (
                            description && <DialogDescription>{description}</DialogDescription>
                        )}
                    </DialogHeader>
                    {asking && step && stepAction ? (
                        <StepView step={step} {...stepAction} />
                    ) : (
                        <>
                            {children}
                            <DialogFooter>{footer}</DialogFooter>
                        </>
                    )}
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
    const step = useStepPrompt({
        limitMs: STEP_LIMIT_MS,
        onExpired: () => {
            reset();
            setError(STEP_GAVE_UP);
        },
    });
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
            const result = await authClient.changeSecurity(user, 'password', current, next, {
                step: step.ask,
            });
            cue('success');
            router.options.context.queryClient.clear();
            if (!result.signedIn) {
                await router.navigate({
                    to: '/login',
                    // The reply never arrived, so the change may or may not have been made.
                    search: { securityChanged: 'uncertain' },
                    replace: true,
                });
                return;
            }
            await router.invalidate();
            reset();
            onOpenChange(false);
            onChanged();
        } catch (cause) {
            // Backed out of the second step: the form is as it was.
            if (cause instanceof StepCancelled) {
                step.done();
                await reopen(user);
                return;
            }
            cue('error');
            setError(authError(cause));
        } finally {
            step.done();
            setPending(false);
        }
    }
    return (
        <AccountDialog
            open={open}
            onOpenChange={(value) => {
                if (!value) reset();
                onOpenChange(value);
            }}
            pending={pending}
            title="Change password"
            step={step}
            stepAction={{ action: 'Change password', busy: 'Changing…' }}
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
        </AccountDialog>
    );
}

/*
 * New sharing keys: a new identity at the next key version, signed by the
 * current one, so the people this account shares with follow the change
 * without comparing words again; then everything it shares is sealed again,
 * to the same people, under the new keys. The account key, password and
 * recovery phrase stay as they are, so no password is asked for.
 */
export function ReplaceSharingKeysDialog({
    userId,
    open,
    onOpenChange,
}: {
    userId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const queryClient = useQueryClient();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function submit() {
        setPending(true);
        setError('');
        try {
            await queryClient.fetchQuery(driveOpenQueryOptions(userId));
            await succeedIdentity(queryClient, userId);
            let resealed = 0;
            let failed = false;
            try {
                ({ resealed } = await driveClient.upgradeShares({ all: true }));
            } catch {
                failed = true;
            }
            cue('success');
            toast.add({
                type: failed ? 'warning' : 'success',
                title: 'Sharing keys replaced',
                description: failed
                    ? 'Some shares weren’t sealed again yet. HushOS tries again the next time you open your files.'
                    : resealed
                      ? `${resealed} ${resealed === 1 ? 'share' : 'shares'} sealed again to your new keys. Your twelve words changed too.`
                      : 'Your twelve words changed too.',
            });
            onOpenChange(false);
        } catch (cause) {
            cue('error');
            setError(driveError(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <AccountDialog
            open={open}
            onOpenChange={(value) => {
                if (!value) setError('');
                onOpenChange(value);
            }}
            pending={pending}
            title="Replace sharing keys?"
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
                        {pending ? 'Replacing…' : 'Replace sharing keys'}
                    </Button>
                </>
            }
        >
            <div className="flex flex-col gap-2 text-[15px]">
                <p>
                    Use this if you think your sharing keys were exposed, for example on a device
                    someone else used while it was unlocked.
                </p>
                <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
                    <li>
                        Your current keys sign the new ones, so the people you share with follow the
                        change without comparing words again.
                    </li>
                    <li>Everything you share is sealed again to the new keys.</li>
                    <li>Your twelve words change. Your password and recovery phrase don’t.</li>
                </ul>
            </div>
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            )}
        </AccountDialog>
    );
}

/*
 * A new recovery phrase, or a new master key (said as "rotate account key").
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
    const step = useStepPrompt({
        limitMs: STEP_LIMIT_MS,
        onExpired: () => {
            setPassword('');
            setTried(false);
            setError(STEP_GAVE_UP);
        },
    });
    const keys = action === 'master-key';
    async function submit() {
        setTried(true);
        if (!password) return;
        setPending(true);
        setError('');
        try {
            const result = await authClient.changeSecurity(user, action, password, '', {
                step: step.ask,
            });
            /*
             * The reply never arrived. The phrase this device made for the change is the only
             * copy, and the next sign-in's second step may ask for it. It goes on screen now,
             * before anything else here can fail: the root document draws it in place of the
             * page, from this tab's memory, with the screen this file already loaded. The
             * connection has just failed, so nothing that shows it may need one.
             */
            const kit = result.signedIn ? undefined : result.kit;
            if (kit)
                holdPhrase({
                    account: { id: user.id, email: user.email },
                    ...kit,
                    Screen: LostReplyPhrase,
                });
            cue('success');
            router.options.context.queryClient.clear();
            if (!result.signedIn) {
                // Underneath the phrase, or in its place when there is none to show (the
                // worker had locked): the sign-in page, which says what is known, so a reload
                // lands there. It may fail to load; the phrase does not wait for it.
                await router.navigate({
                    to: '/login',
                    search: { securityChanged: 'uncertain-phrase' },
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
            step.done();
            // Backed out of the second step: the form is as it was.
            const backedOut = cause instanceof StepCancelled;
            if (backedOut) await reopen(user);
            setPending(false);
            if (backedOut) return;
            cue('error');
            setError(authError(cause));
        }
    }
    return (
        <AccountDialog
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
            title={keys ? 'Rotate account key?' : 'Make a new recovery phrase?'}
            step={step}
            stepAction={
                keys
                    ? { action: 'Rotate account key', busy: 'Rotating…' }
                    : { action: 'Make a new phrase', busy: 'Making…' }
            }
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
                                ? 'Rotating…'
                                : 'Making…'
                            : keys
                              ? 'Rotate account key'
                              : 'Make a new phrase'}
                    </Button>
                </>
            }
        >
            {keys && (
                <div className="flex flex-col gap-2 text-[15px]">
                    <p>
                        A new master key for your account. Use this if you think someone saw your
                        password or recovery phrase.
                    </p>
                    <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted-foreground">
                        <li>You get a new recovery phrase. The old one stops working.</li>
                        <li>Your other devices are signed out.</li>
                        <li>Your files, sharing keys and links stay as they are.</li>
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
        </AccountDialog>
    );
}

/* Delete account: the password and DELETE, the same two things the phones ask for. */
export function DeleteAccountDialog({
    user,
    open,
    onOpenChange,
}: {
    user: SessionUser;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const router = useRouter();
    const [password, setPassword] = useState('');
    const [typed, setTyped] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const step = useStepPrompt({
        limitMs: STEP_LIMIT_MS,
        onExpired: () => {
            setPassword('');
            setTyped('');
            setError(STEP_GAVE_UP);
        },
    });
    const ready = password.length > 0 && typed === 'DELETE';
    async function submit() {
        if (!ready) return;
        setPending(true);
        setError('');
        try {
            await authClient.deleteAccount(password, { step: step.ask });
            // The account is gone; what Drive kept of it on this device goes too.
            await forgetDevice();
            router.options.context.queryClient.clear();
            await router.invalidate();
            await router.navigate({ to: '/account-deleted', replace: true });
        } catch (cause) {
            step.done();
            // Backed out of the second step: nothing was deleted.
            const backedOut = cause instanceof StepCancelled;
            if (backedOut) await reopen(user);
            setPending(false);
            if (backedOut) return;
            cue('error');
            setError(authError(cause));
        }
    }
    return (
        <AccountDialog
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
            step={step}
            stepAction={{ action: 'Delete forever', busy: 'Deleting…', destructive: true }}
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
        </AccountDialog>
    );
}

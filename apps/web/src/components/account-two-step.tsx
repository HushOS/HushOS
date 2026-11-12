import type { SecurityEvent, TwoStepStatus } from '@hushos/auth/api';
import { LostReply } from '@hushos/auth/client';
import type { SessionUser } from '@hushos/auth/protocol';
import { PASSWORD_MAX_LENGTH } from '@hushos/auth/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { devicesQueryOptions } from '@/components/account-devices';
import { CopyCheckIcon } from '@/components/copy-button';
import { SECRET_FIELD } from '@/components/password-input';
import { QrCode } from '@/components/qr-code';
import { DialogField, Done, Setting, SettingsGroup } from '@/components/settings';
import { StepUpFields } from '@/components/two-step-answer';
import { Badge } from '@/components/ui/badge';
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
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { copySecret } from '@/lib/clipboard';
import { formatDay, formatTime } from '@/lib/drive';
import { authError } from '@/lib/form';
import { saveBlob } from '@/lib/save-file';
import { cue } from '@/lib/sounds';
import {
    securityEventsQueryOptions,
    twoStepQueryOptions,
    useStepUp,
    useTwoStepEnabled,
} from '@/lib/two-step';

/*
 * Two-step sign-in in Account (docs/two-step-design.md 2, 4, 7): turning it on with an
 * authenticator app, the backup codes shown once, replacing the app, new codes, turning it
 * off, and the account's recent security activity. Every change asks for the password again,
 * and, once the step is on, for the step. Nothing shows on a server that has two-step off.
 */

type Open = 'on' | 'replace' | 'off' | 'codes' | null;

export function AccountTwoStep({ user }: { user: SessionUser }) {
    const enabled = useTwoStepEnabled();
    const queryClient = useQueryClient();
    const status = useQuery({ ...twoStepQueryOptions, enabled });
    const [open, setOpen] = useState<Open>(null);
    const [done, setDone] = useState('');
    if (!enabled) return null;
    const refresh = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: twoStepQueryOptions.queryKey }),
            queryClient.invalidateQueries({ queryKey: securityEventsQueryOptions.queryKey }),
            queryClient.invalidateQueries({ queryKey: devicesQueryOptions.queryKey }),
        ]);
    const finish = (said: string) => {
        setDone(said);
        void refresh();
    };
    const begin = (next: Open) => {
        setDone('');
        setOpen(next);
    };
    const close = () => setOpen(null);
    const app = status.data?.methods.find((method) => method.kind === 'totp');
    return (
        <div id="two-step" className="scroll-mt-20">
            <SettingsGroup
                title="Two-step sign-in"
                description="A second step stops someone who has your password from signing in. It doesn’t change how your files are encrypted."
            >
                {status.isPending ? (
                    <div className="flex flex-col gap-2 py-3" aria-busy="true">
                        <Skeleton className="h-5 w-48" />
                        <Skeleton className="h-4 w-72" />
                    </div>
                ) : status.isError ? (
                    <Setting
                        label="Status"
                        action={
                            <Button variant="outline" onClick={() => void status.refetch()}>
                                Try again
                            </Button>
                        }
                    >
                        <span role="alert" className="text-destructive">
                            Two-step sign-in couldn’t be loaded.
                        </span>
                    </Setting>
                ) : !status.data.on ? (
                    <Setting
                        label="Status"
                        data={{ 'data-two-step': 'off' }}
                        action={
                            <Button variant="outline" onClick={() => begin('on')}>
                                Turn on
                            </Button>
                        }
                        below={done && <Done>{done}</Done>}
                    >
                        <span className="text-muted-foreground">
                            Off. Your password alone signs you in.
                        </span>
                    </Setting>
                ) : (
                    <>
                        <Setting
                            label="Authenticator app"
                            data={{ 'data-two-step': 'on' }}
                            action={
                                <>
                                    <Button variant="ghost" onClick={() => begin('replace')}>
                                        Replace
                                    </Button>
                                    <Button
                                        variant="destructive-outline"
                                        onClick={() => begin('off')}
                                    >
                                        Turn off
                                    </Button>
                                </>
                            }
                            below={
                                <>
                                    {status.data.totpFrozen && (
                                        <p className="text-[13px] text-muted-foreground">
                                            Its codes are refused on devices HushOS doesn’t
                                            recognise, after many wrong ones. A backup code or your
                                            recovery phrase works there, and lifts the pause.
                                        </p>
                                    )}
                                    {done && <Done>{done}</Done>}
                                </>
                            }
                        >
                            <span className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="font-medium">On</span>
                                {status.data.totpFrozen && <Badge variant="warning">Paused</Badge>}
                                {app && (
                                    <span className="text-[13px] text-muted-foreground">
                                        {used(app)}
                                    </span>
                                )}
                            </span>
                        </Setting>
                        <Setting
                            label="Backup codes"
                            action={
                                <Button variant="outline" onClick={() => begin('codes')}>
                                    New codes
                                </Button>
                            }
                        >
                            <span className="text-muted-foreground">{codesLeft(status.data)}</span>
                        </Setting>
                    </>
                )}
                {status.isSuccess && <SecurityActivity />}
            </SettingsGroup>
            <AppDialog
                // A new dialog each time it opens: nothing of a secret or a password is kept.
                key={`app-${open === 'on' || open === 'replace' ? open : 'closed'}`}
                user={user}
                mode={open === 'replace' ? 'replace' : 'on'}
                open={open === 'on' || open === 'replace'}
                onClose={close}
                onDone={finish}
            />
            <TurnOffDialog
                key={`off-${open === 'off'}`}
                factorId={app?.id ?? null}
                open={open === 'off'}
                onClose={close}
                onDone={finish}
            />
            <NewCodesDialog
                key={`codes-${open === 'codes'}`}
                user={user}
                open={open === 'codes'}
                onClose={close}
                onDone={finish}
            />
        </div>
    );
}

function used(app: TwoStepStatus['methods'][number]) {
    const added = `Added ${formatDay(app.createdAt)}`;
    return app.lastUsedAt ? `${added} · Last used ${formatDay(app.lastUsedAt)}` : added;
}

function codesLeft(status: TwoStepStatus) {
    const left = status.backupCodesLeft;
    if (left === 0) return 'None left. Make a new set.';
    return left <= 2 ? `${left} of 10 left. Make a new set soon.` : `${left} of 10 left`;
}

/* ------------------------------------------------------------------------- */
/* Recent security activity                                                   */
/* ------------------------------------------------------------------------- */

const withMethod: Record<NonNullable<SecurityEvent['method']>, string> = {
    totp: 'an authenticator code',
    backup: 'a backup code',
    phrase: 'your recovery phrase',
    webauthn: 'a security key',
};
const deviceWords = { web: 'Browser', ios: 'iPhone or iPad', android: 'Android' } as const;

/* What happened, in the account's own words; a kind this page does not know is still listed. */
function eventWords(event: SecurityEvent) {
    const method = event.method ? withMethod[event.method] : null;
    switch (event.kind) {
        case 'sign-in':
            return method ? `Signed in with your password and ${method}` : 'Signed in';
        case 'step-failed':
            return method
                ? `Wrong answer to the second step, with ${method}`
                : 'Wrong answer to the second step';
        case 'totp-frozen':
            return 'Authenticator app paused after many wrong answers';
        case 'backup-code-used':
            return 'Backup code used';
        case 'phrase-used':
            return 'Recovery phrase used for the second step';
        case 'two-step-on':
            return 'Two-step sign-in turned on';
        case 'two-step-off':
            return 'Two-step sign-in turned off';
        // Said by the kind of method, so the line is right for a security key too.
        case 'method-added':
            return event.method === 'webauthn'
                ? 'Security key added'
                : event.method === 'totp'
                  ? 'Authenticator app replaced'
                  : 'Second-step method added';
        case 'method-removed':
            return event.method === 'webauthn'
                ? 'Security key removed'
                : event.method === 'totp'
                  ? 'Authenticator app removed'
                  : 'Second-step method removed';
        case 'backup-codes-made':
            return 'New backup codes made';
        default:
            return 'Security change';
    }
}

/* The minute, as the emails carry it: "13 Nov, 14:08". */
const eventWhen = (iso: string) => `${formatDay(iso)}, ${formatTime(iso)}`;

const SHOWN = 5;

function SecurityActivity() {
    const events = useQuery(securityEventsQueryOptions);
    const [all, setAll] = useState(false);
    const list = events.data ?? [];
    if (events.isPending || events.isError || list.length === 0) return null;
    const shown = all ? list : list.slice(0, SHOWN);
    return (
        <Setting
            label="Recent activity"
            below={
                list.length > SHOWN && (
                    <Button
                        variant="ghost"
                        className="-ms-3.5"
                        aria-expanded={all}
                        onClick={() => setAll((value) => !value)}
                    >
                        {all ? 'Show fewer' : `Show all ${list.length}`}
                    </Button>
                )
            }
        >
            <ul
                aria-label="Recent security activity"
                className="m-0 flex list-none flex-col gap-2 p-0"
            >
                {shown.map((event) => (
                    <li key={event.id} className="flex min-w-0 flex-col gap-0.5">
                        <span className="wrap-anywhere">{eventWords(event)}</span>
                        <span className="text-[13px] text-muted-foreground">
                            {event.deviceKind ? `${deviceWords[event.deviceKind]} · ` : ''}
                            {eventWhen(event.createdAt)}
                        </span>
                    </li>
                ))}
            </ul>
        </Setting>
    );
}

/* ------------------------------------------------------------------------- */
/* Dialogs                                                                    */
/* ------------------------------------------------------------------------- */

function Shell({
    open,
    locked = false,
    pending,
    title,
    description,
    children,
    footer,
    onClose,
    onSubmit,
}: {
    open: boolean;
    /* Showing something that is shown once: only its own button closes it. */
    locked?: boolean;
    pending: boolean;
    title: string;
    description?: ReactNode;
    children: ReactNode;
    footer: ReactNode;
    onClose: () => void;
    onSubmit: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={(next) => !next && !pending && !locked && onClose()}>
            <DialogContent className="sm:max-w-[480px]" showCloseButton={!locked}>
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

const Problem = ({ children }: { children: ReactNode }) =>
    children ? (
        <p role="alert" className="text-[13px] text-destructive">
            {children}
        </p>
    ) : null;

function PasswordField({
    value,
    onChange,
    disabled,
    tried,
}: {
    value: string;
    onChange: (value: string) => void;
    disabled: boolean;
    tried: boolean;
}) {
    return (
        <DialogField
            label="Password"
            type="password"
            autoComplete="current-password"
            maxLength={PASSWORD_MAX_LENGTH}
            value={value}
            disabled={disabled}
            onChange={(event) => onChange(event.target.value)}
            hint="Enter your password to confirm."
            error={tried && !value ? 'Enter your password.' : undefined}
        />
    );
}

/*
 * A secret copied the way the others are (lib/clipboard.ts): cleared from the clipboard two
 * minutes later, and said so. Returns whether it was copied.
 */
async function copyAsSecret(value: string, what: string) {
    try {
        await copySecret(value);
        cue('success', { volume: 0.4 });
        toast.add({
            type: 'success',
            title: `${what} copied`,
            description: 'Cleared from the clipboard in two minutes.',
        });
        return true;
    } catch {
        cue('error');
        toast.add({
            type: 'error',
            title: 'Copy failed',
            description:
                'Your browser blocked clipboard access. Select the text and copy it instead.',
        });
        return false;
    }
}

/* The ten codes, shown once: to copy, or to keep as a file made on this device. */
function BackupCodes({ codes, email }: { codes: string[]; email: string }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 1_600);
        return () => window.clearTimeout(timer);
    }, [copied]);
    async function copy() {
        setCopied(await copyAsSecret(codes.join('\n'), 'Backup codes'));
    }
    function download() {
        const made = new Intl.DateTimeFormat('en-GB', { dateStyle: 'long' }).format(new Date());
        const text = [
            'HushOS backup codes',
            `Account: ${email}`,
            `Made: ${made}`,
            '',
            'Each code works once, in place of a code from your authenticator app.',
            '',
            ...codes,
            '',
        ].join('\n');
        saveBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), 'hushos-backup-codes.txt');
        cue('success', { volume: 0.4 });
    }
    return (
        <div className="flex flex-col gap-3">
            <ul
                aria-label="Backup codes"
                className="m-0 grid list-none grid-cols-2 gap-x-6 gap-y-2 rounded-md bg-muted px-4 py-3.5 font-mono text-[15px]"
            >
                {codes.map((code) => (
                    <li key={code}>{code}</li>
                ))}
            </ul>
            <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" onClick={() => void copy()}>
                    {copied ? 'Copied' : 'Copy'}
                </Button>
                <Button type="button" variant="outline" onClick={download}>
                    Download
                </Button>
            </div>
            <p className="text-[13px] text-muted-foreground">
                Each code works once, when you can’t use your authenticator app. They aren’t shown
                again, so keep them somewhere apart from your password.
            </p>
        </div>
    );
}

/* Copies the app's key: a secret, so by `copyAsSecret`. Looks as CopyButton does. */
function CopyKey({ value }: { value: string }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 1_600);
        return () => window.clearTimeout(timer);
    }, [copied]);
    return (
        <button
            type="button"
            onClick={() => void copyAsSecret(value, 'Key').then(setCopied)}
            aria-label={copied ? 'Copied' : 'Copy key'}
            title="Copy key"
            className={`grid size-8 shrink-0 cursor-pointer place-items-center rounded-md border border-input bg-card text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${copied ? 'text-success' : ''}`}
        >
            <CopyCheckIcon done={copied} className="size-3.5" />
        </button>
    );
}

/* The app's key in groups of four, as authenticator apps show it for typing. */
const grouped = (secret: string) => secret.match(/.{1,4}/g)?.join(' ') ?? secret;

/*
 * Turning the step on, or replacing the app: the password (and the step, once it is on), the
 * QR code with the key to type beneath it, a code from the app to confirm, and, the first
 * time, the backup codes.
 */
function AppDialog({
    user,
    mode,
    open,
    onClose,
    onDone,
}: {
    user: SessionUser;
    mode: 'on' | 'replace';
    open: boolean;
    onClose: () => void;
    onDone: (said: string) => void;
}) {
    const codeId = useId();
    const othersId = useId();
    const devices = useQuery({ ...devicesQueryOptions, enabled: open && mode === 'on' });
    // How many other devices the list shows, when it could be read. It only words the offer:
    // whether they are removed is the tick box's to say, since the list may have failed to
    // load or be a moment behind a device that signed in since.
    const others = devices.isSuccess
        ? devices.data.devices.filter((device) => !device.current).length
        : null;
    const step = useStepUp('two-step');
    const [password, setPassword] = useState('');
    const [tried, setTried] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [app, setApp] = useState<{ id: string; secret: string; uri: string } | null>(null);
    const [code, setCode] = useState('');
    const [signOutOthers, setSignOutOthers] = useState(true);
    const [codes, setCodes] = useState<string[] | null>(null);
    // Removing the other devices, after the codes are on screen: running, done, or failed.
    const [removing, setRemoving] = useState<'no' | 'running' | 'failed'>('no');
    const codeNote = useId();
    const replacing = mode === 'replace';
    // Replacing needs the step from the start: its fields are there when the dialog opens.
    const { ask } = step;
    useEffect(() => {
        if (open && replacing) void ask().catch(() => {});
        // Only when the dialog opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, replacing]);

    async function start() {
        setTried(true);
        if (!password) return;
        setPending(true);
        setError('');
        try {
            if (await step.ask()) return;
            const twoStep = await step.prove();
            if (twoStep === null) return;
            setApp(await authClient.startAuthenticator(password, twoStep));
            setTried(false);
        } catch (cause) {
            cue('error');
            if (!(await step.failed(cause))) setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    async function confirm() {
        if (!app) return;
        setTried(true);
        const typed = code.replace(/\s/g, '');
        if (!/^\d{6}$/.test(typed)) return;
        setPending(true);
        setError('');
        try {
            const confirmed = await authClient.confirmAuthenticator(app.id, typed);
            const backupCodes = 'backupCodes' in confirmed ? confirmed.backupCodes : null;
            cue('success');
            if (!backupCodes) {
                // Turning the step on always comes back with the codes. An answer without
                // them is not the server's answer to that: nothing is claimed, and the
                // section behind this dialog is read again (below).
                if (!replacing)
                    throw new LostReply(
                        'The server’s answer didn’t arrive, so HushOS can’t tell whether two-step sign-in was turned on. Check before you try again.',
                    );
                onDone('Authenticator app replaced.');
                onClose();
                return;
            }
            // The codes first: they are shown once, and nothing that follows may cost them.
            setCodes(backupCodes);
            onDone('');
            // Then the other devices, which signed in before the step was on: removed whenever
            // the box is ticked, whatever the list said (the server removes none when there
            // are none). It runs behind the codes and never holds them or the dialog: a
            // failure is said beside the codes, and in a notice if the dialog has closed.
            if (signOutOthers) {
                setRemoving('running');
                void authClient.removeOtherDevices(password).then(
                    () => {
                        setRemoving('no');
                        onDone('');
                    },
                    () => {
                        setRemoving('failed');
                        toast.add({
                            type: 'error',
                            title: 'Your other devices weren’t removed',
                            description: 'You can remove them under Your devices.',
                        });
                    },
                );
            }
        } catch (cause) {
            cue('error');
            // The setup ran out (ten minutes): back to the start, with why.
            if ((cause as { status?: unknown } | null)?.status === 404) {
                setApp(null);
                setCode('');
                setTried(false);
            }
            // A reply that was not the server's own says nothing: the section behind this
            // dialog is read again, and shows whether the step is on.
            if (cause instanceof LostReply) onDone('');
            setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    const cancel = (
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
            Cancel
        </Button>
    );
    if (codes)
        return (
            <Shell
                open={open}
                locked
                pending={false}
                title="Save your backup codes"
                description="Two-step sign-in is on."
                onClose={onClose}
                onSubmit={() => {
                    onDone('Two-step sign-in is on.');
                    onClose();
                }}
                // Never held by the removal: a request that hangs must not keep the person here.
                footer={<Button type="submit">Done</Button>}
            >
                <BackupCodes codes={codes} email={user.email} />
                {removing === 'running' && (
                    <output className="text-[13px] text-muted-foreground">
                        Removing your other devices
                    </output>
                )}
                {removing === 'failed' && (
                    <p role="alert" className="text-[13px] text-destructive">
                        Your other devices weren’t removed. You can remove them under Your devices.
                    </p>
                )}
            </Shell>
        );
    if (app) {
        const invalid = tried && !/^\d{6}$/.test(code.replace(/\s/g, ''));
        return (
            <Shell
                open={open}
                pending={pending}
                title={replacing ? 'Add your new authenticator app' : 'Add your authenticator app'}
                description="Scan this code with your authenticator app, then enter the code it shows."
                onClose={onClose}
                onSubmit={() => void confirm()}
                footer={
                    <>
                        {cancel}
                        <Button type="submit" disabled={pending}>
                            {pending ? 'Checking' : replacing ? 'Replace app' : 'Turn on'}
                        </Button>
                    </>
                }
            >
                <div className="flex flex-col items-center gap-3">
                    <div className="rounded-md border border-rule bg-white p-2">
                        <QrCode
                            value={app.uri}
                            kind="recovery"
                            size={184}
                            title="A code for your authenticator app"
                        />
                    </div>
                    <div className="flex w-full flex-col items-center gap-1.5">
                        <span className="text-[13px] text-muted-foreground">
                            Or type this key into the app
                        </span>
                        <span className="flex max-w-full items-center gap-2">
                            <span
                                data-two-step-key
                                className="font-mono text-sm tracking-[0.04em] wrap-anywhere"
                            >
                                {grouped(app.secret)}
                            </span>
                            <CopyKey value={app.secret} />
                        </span>
                    </div>
                </div>
                <div className="flex flex-col gap-1.5">
                    <label htmlFor={codeId} className="text-[13px] font-semibold">
                        Code from your authenticator app
                    </label>
                    <Input
                        id={codeId}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={7}
                        placeholder="000000"
                        value={code}
                        // Read-only while it is checked, not disabled: the cursor stays in it.
                        readOnly={pending}
                        aria-invalid={invalid || Boolean(error)}
                        aria-describedby={invalid || error ? codeNote : undefined}
                        onChange={(event) => {
                            setCode(event.target.value.replace(/[^\d\s]/g, ''));
                            setError('');
                        }}
                        className="font-mono text-[15px] tracking-[0.2em]"
                        {...SECRET_FIELD}
                    />
                    {(invalid || error) && (
                        <p id={codeNote} role="alert" className="text-[13px] text-destructive">
                            {invalid ? 'Enter the 6-digit code the app shows.' : error}
                        </p>
                    )}
                </div>
                {!replacing && (
                    <div className="flex items-start gap-3">
                        <Checkbox
                            id={othersId}
                            checked={signOutOthers}
                            disabled={pending}
                            onCheckedChange={(checked) => setSignOutOthers(checked === true)}
                            className="mt-0.5"
                        />
                        <label htmlFor={othersId} className="flex flex-col gap-0.5 text-sm">
                            <span className="font-semibold">Remove my other devices</span>
                            <span className="text-[13px] text-muted-foreground">
                                {others
                                    ? `${others === 1 ? 'One other device is' : `${others} other devices are`} signed in without the second step. They’ll need to sign in again, and will be asked for it.`
                                    : 'Any other device signed in to your account will need to sign in again, and will be asked for the second step.'}
                            </span>
                        </label>
                    </div>
                )}
            </Shell>
        );
    }
    return (
        <Shell
            open={open}
            pending={pending}
            title={replacing ? 'Replace your authenticator app?' : 'Turn on two-step sign-in?'}
            description={
                replacing
                    ? 'The new app takes over once you confirm it. Your backup codes stay as they are.'
                    : 'After your password, HushOS will ask for a code from an authenticator app on your phone. Your recovery phrase works as the second step too, so keep it apart from your password.'
            }
            onClose={onClose}
            onSubmit={() => void start()}
            footer={
                <>
                    {cancel}
                    <Button type="submit" disabled={pending}>
                        {pending ? 'Checking' : 'Continue'}
                    </Button>
                </>
            }
        >
            <PasswordField
                value={password}
                onChange={setPassword}
                disabled={pending}
                tried={tried}
            />
            <StepUpFields step={step} disabled={pending} />
            <Problem>{error}</Problem>
        </Shell>
    );
}

/* Turning the step off is removing its last method: the password and the step itself. */
function TurnOffDialog({
    factorId,
    open,
    onClose,
    onDone,
}: {
    factorId: string | null;
    open: boolean;
    onClose: () => void;
    onDone: (said: string) => void;
}) {
    const step = useStepUp('two-step');
    const [password, setPassword] = useState('');
    const [tried, setTried] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const { ask } = step;
    useEffect(() => {
        if (open) void ask().catch(() => {});
        // Only when the dialog opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    async function submit() {
        setTried(true);
        if (!password || !factorId) return;
        setPending(true);
        setError('');
        try {
            if (await step.ask()) return;
            const twoStep = await step.prove();
            if (twoStep === null) return;
            await authClient.removeTwoStepMethod(factorId, password, twoStep);
            cue('success');
            onDone('Two-step sign-in is off.');
            onClose();
        } catch (cause) {
            cue('error');
            if (!(await step.failed(cause))) setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <Shell
            open={open}
            pending={pending}
            title="Turn off two-step sign-in?"
            description="Your password alone will sign you in, and your backup codes will stop working."
            onClose={onClose}
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" variant="destructive" disabled={pending}>
                        {pending ? 'Turning off' : 'Turn off'}
                    </Button>
                </>
            }
        >
            <PasswordField
                value={password}
                onChange={setPassword}
                disabled={pending}
                tried={tried}
            />
            <StepUpFields step={step} disabled={pending} />
            <Problem>{error}</Problem>
        </Shell>
    );
}

/* A new set of ten, which replaces the old one: the password and the step, then the codes once. */
function NewCodesDialog({
    user,
    open,
    onClose,
    onDone,
}: {
    user: SessionUser;
    open: boolean;
    onClose: () => void;
    onDone: (said: string) => void;
}) {
    const step = useStepUp('two-step');
    const [password, setPassword] = useState('');
    const [tried, setTried] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [codes, setCodes] = useState<string[] | null>(null);
    const { ask } = step;
    useEffect(() => {
        if (open) void ask().catch(() => {});
        // Only when the dialog opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);
    async function submit() {
        setTried(true);
        if (!password) return;
        setPending(true);
        setError('');
        try {
            if (await step.ask()) return;
            const twoStep = await step.prove();
            if (twoStep === null) return;
            if (!twoStep) throw new Error('Turn on two-step sign-in first.');
            setCodes((await authClient.newBackupCodes(password, twoStep)).codes);
            cue('success');
            onDone('');
        } catch (cause) {
            cue('error');
            if (!(await step.failed(cause))) setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    if (codes)
        return (
            <Shell
                open={open}
                locked
                pending={false}
                title="Save your new backup codes"
                description="Your earlier codes no longer work."
                onClose={onClose}
                onSubmit={() => {
                    onDone('New backup codes made.');
                    onClose();
                }}
                footer={<Button type="submit">Done</Button>}
            >
                <BackupCodes codes={codes} email={user.email} />
            </Shell>
        );
    return (
        <Shell
            open={open}
            pending={pending}
            title="Make new backup codes?"
            description="You get ten new codes, and the ones you have now stop working."
            onClose={onClose}
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" disabled={pending}>
                        {pending ? 'Making' : 'Make new codes'}
                    </Button>
                </>
            }
        >
            <PasswordField
                value={password}
                onChange={setPassword}
                disabled={pending}
                tried={tried}
            />
            <StepUpFields step={step} disabled={pending} />
            <Problem>{error}</Problem>
        </Shell>
    );
}

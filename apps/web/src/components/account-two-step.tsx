import type { TwoStepMethod } from '@hushos/auth/api';
import { StepCancelled } from '@hushos/auth/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { CopyIcon, DownloadIcon, QrCodeIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { devicesQueryOptions } from '@/components/account-devices';
import { AccountDialog, STEP_GAVE_UP } from '@/components/account-dialogs';
import { QrCode } from '@/components/qr-code';
import { DialogField, Done, Setting, SettingsGroup } from '@/components/settings';
import { STEP_LIMIT_MS, useStepPrompt } from '@/components/two-step-prompt';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { copySecret } from '@/lib/clipboard';
import { authError } from '@/lib/form';
import { saveBlob } from '@/lib/save-file';
import { cue } from '@/lib/sounds';
import {
    addedOn,
    backupCodesText,
    codesLeft,
    FEW_CODES,
    groupSecret,
    notePhraseSignIn,
    usedOn,
    usePhraseSignIn,
} from '@/lib/two-step';
import { twoStepQueryOptions } from '@/lib/two-step-status';

/*
 * Two-step sign-in (docs/two-step-design.md): a code from an authenticator app, asked for
 * after the password. Off, the section offers to turn it on; on, it lists the method with
 * Remove, says how many backup codes are left, and makes a new set. (Renaming waits for
 * security keys: there is only ever one app to name.) Every change
 * asks for the password, and for the second step once there is one. On a server that does
 * not offer it (TWO_STEP_ENABLED off) the section draws nothing: only the place the security
 * notices link to (`/app/account#two-step`).
 */

/* The design's sentence for what the step is, and what it is not. */
const WHAT_IT_DOES =
    'A second step stops someone who has your password from signing in. It doesn’t change how your files are encrypted.';

const kindWords: Record<TwoStepMethod['kind'], string> = {
    totp: 'Authenticator app',
    webauthn: 'Security key',
};

type Open =
    | { kind: 'on' }
    | { kind: 'remove'; method: TwoStepMethod; last: boolean }
    | { kind: 'codes' }
    | null;

export function AccountTwoStep({ user }: { user: { email: string } }) {
    const queryClient = useQueryClient();
    const status = useQuery(twoStepQueryOptions);
    const [open, setOpen] = useState<Open>(null);
    // What just happened here, said once beside the rows it concerns.
    const [turnedOn, setTurnedOn] = useState<{ signedOut: boolean } | null>(null);
    // Signed in with the recovery phrase a moment ago: the sign-in page left a note for this section.
    const viaPhrase = usePhraseSignIn();
    const refresh = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: twoStepQueryOptions.queryKey }),
            queryClient.invalidateQueries({ queryKey: devicesQueryOptions.queryKey }),
        ]);
    const close = () => setOpen(null);
    const data = status.data;
    // Not offered here, or not known yet: nothing that could not work, only the notices' anchor.
    if (data === null || status.isPending) return <span id="two-step" hidden />;
    return (
        <div id="two-step" className="scroll-mt-20">
            <SettingsGroup title="Two-step sign-in" description={WHAT_IT_DOES}>
                {status.isError || !data ? (
                    <Setting
                        label="Two-step sign-in"
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
                ) : !data.on ? (
                    <Setting
                        label="Authenticator app"
                        action={
                            <Button variant="outline" onClick={() => setOpen({ kind: 'on' })}>
                                Turn on
                            </Button>
                        }
                    >
                        <span className="text-muted-foreground">
                            Off. When it’s on, signing in asks for your password, then a code from
                            an app on your phone.
                        </span>
                    </Setting>
                ) : (
                    <>
                        {(turnedOn || viaPhrase || data.totpFrozen) && (
                            <div className="flex flex-col gap-3 py-3">
                                {turnedOn && (
                                    <Done>
                                        Two-step sign-in is on.
                                        {turnedOn.signedOut
                                            ? ' Your other devices were signed out.'
                                            : ''}
                                    </Done>
                                )}
                                {viaPhrase && (
                                    <Alert variant="info">
                                        <AlertTitle>
                                            You signed in with your recovery phrase
                                        </AlertTitle>
                                        <AlertDescription>
                                            If you’ve lost your authenticator app, remove it here
                                            and turn two-step sign-in on again. You’ll get new
                                            backup codes when you do.
                                        </AlertDescription>
                                    </Alert>
                                )}
                                {data.totpFrozen && (
                                    <Alert variant="warning">
                                        <AlertTitle>
                                            Authenticator codes are paused on new devices
                                        </AlertTitle>
                                        <AlertDescription>
                                            Too many wrong codes were entered. Devices you already
                                            use still take your codes. To sign in on a new device,
                                            use a backup code or your recovery phrase; that turns
                                            codes back on. If the wrong codes weren’t yours, change
                                            your password.
                                        </AlertDescription>
                                    </Alert>
                                )}
                            </div>
                        )}
                        <ul
                            aria-label="Ways to pass your second step"
                            className="m-0 list-none p-0"
                        >
                            {data.methods.map((method) => (
                                <li key={method.id} data-method-id={method.id}>
                                    <MethodRow
                                        method={method}
                                        onRemove={() =>
                                            setOpen({
                                                kind: 'remove',
                                                method,
                                                last: data.methods.length === 1,
                                            })
                                        }
                                    />
                                </li>
                            ))}
                        </ul>
                        <Setting
                            label="Backup codes"
                            action={
                                <Button
                                    variant="outline"
                                    onClick={() => setOpen({ kind: 'codes' })}
                                >
                                    Make new codes
                                </Button>
                            }
                            below={
                                data.backupCodesLeft <= FEW_CODES && (
                                    <p className="text-[13px] text-muted-foreground">
                                        Each code works once. Make a new set so you have one when
                                        you need it.
                                    </p>
                                )
                            }
                        >
                            <span className="flex items-center gap-1.5">
                                {data.backupCodesLeft <= FEW_CODES && (
                                    <TriangleAlertIcon
                                        className="size-4 shrink-0 text-warning"
                                        aria-hidden="true"
                                    />
                                )}
                                {codesLeft(data.backupCodesLeft)}
                            </span>
                        </Setting>
                        <Setting label="Recovery phrase">
                            <span className="text-muted-foreground">
                                Also works as your second step. Keep it apart from your password.
                            </span>
                        </Setting>
                    </>
                )}
            </SettingsGroup>
            <TurnOnDialog
                open={open?.kind === 'on'}
                email={user.email}
                onClose={close}
                onDone={(signedOut) => {
                    setTurnedOn({ signedOut });
                    return refresh();
                }}
            />
            <RemoveDialog
                pending={open?.kind === 'remove' ? open : null}
                onClose={close}
                onDone={() => {
                    setTurnedOn(null);
                    // The lost method is gone: the suggestion to remove it has been followed.
                    notePhraseSignIn(false);
                    return refresh();
                }}
            />
            <NewCodesDialog
                open={open?.kind === 'codes'}
                email={user.email}
                onClose={close}
                onDone={refresh}
            />
        </div>
    );
}

/*
 * One method, as a device is listed: what it is, its name, and when it was added and last used.
 * A name that only repeats the label ("Authenticator app", the default) is left out.
 */
function MethodRow({ method, onRemove }: { method: TwoStepMethod; onRemove: () => void }) {
    const named = method.name !== kindWords[method.kind];
    return (
        <Setting
            label={kindWords[method.kind]}
            action={
                <Button
                    variant="destructive-outline"
                    onClick={onRemove}
                    aria-label={`Remove ${method.name}`}
                >
                    Remove
                </Button>
            }
        >
            <div className="flex min-w-0 flex-col gap-0.5">
                {named ? <span className="font-medium wrap-anywhere">{method.name}</span> : null}
                {/* Both days in the server's calendar (UTC), so they agree with each other. */}
                <span
                    className={
                        named ? 'text-[13px] text-muted-foreground' : 'text-muted-foreground'
                    }
                >
                    Added {addedOn(method.createdAt)} ·{' '}
                    {method.lastUsedAt ? `Last used ${usedOn(method.lastUsedAt)}` : 'Never used'}
                </span>
            </div>
        </Setting>
    );
}

function Problem({ children }: { children: string }) {
    return children ? (
        <p role="alert" className="text-[13px] text-destructive">
            {children}
        </p>
    ) : null;
}

/* Copies something secret (it leaves the clipboard again after a while) and says so, or says why not. */
function useSecretCopy(failed: string) {
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 2_000);
        return () => window.clearTimeout(timer);
    }, [copied]);
    async function copy(text: string) {
        setError('');
        try {
            await copySecret(text);
            cue('success', { volume: 0.4 });
            setCopied(true);
        } catch {
            cue('error');
            setError(failed);
        }
    }
    return { copied, error, copy, clear: () => setError('') };
}

/* The ten codes, shown once: read them, copy them, or keep them as a file. */
function BackupCodes({ codes, email }: { codes: string[]; email: string }) {
    const copying = useSecretCopy('Copying isn’t available here. Download the codes instead.');
    function download() {
        copying.clear();
        saveBlob(
            new Blob([backupCodesText({ email }, codes, window.location.host)], {
                type: 'text/plain;charset=utf-8',
            }),
            'hushos-backup-codes.txt',
        );
        cue('success', { volume: 0.4 });
    }
    return (
        <div className="flex flex-col gap-3">
            <ol aria-label="Backup codes" className="m-0 grid list-none grid-cols-2 gap-1.5 p-0">
                {codes.map((code) => (
                    <li
                        key={code}
                        className="rounded-md bg-muted px-3 py-2.5 text-center font-mono text-[15px] font-medium"
                    >
                        {code}
                    </li>
                ))}
            </ol>
            <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" data-focus onClick={download}>
                    <DownloadIcon />
                    Download
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    onClick={() => void copying.copy(codes.join('\n'))}
                >
                    <CopyIcon />
                    {copying.copied ? 'Copied' : 'Copy codes'}
                </Button>
            </div>
            <Problem>{copying.error}</Problem>
        </div>
    );
}

/*
 * The key an authenticator app is set up with. Beside a computer the phone scans the QR code,
 * so it comes first, with the key for typing under it. On a phone the authenticator is on the
 * same device and cannot scan its own screen: the key leads, with a Copy across the width, and
 * the QR code waits behind a button for someone whose app is on another device.
 */
function SetupKey({ secret, uri }: { secret: string; uri: string }) {
    const [showQr, setShowQr] = useState(false);
    const panel = useId();
    const copying = useSecretCopy('Copying isn’t available here. Type the key instead.');
    return (
        <li className="flex flex-col gap-3">
            <p>
                <span className="font-semibold">1.</span>{' '}
                <span className="pointer-coarse:hidden">
                    In your authenticator app, add an account and scan this QR code.
                </span>
                <span className="hidden pointer-coarse:inline">
                    In your authenticator app, add an account and enter this key.
                </span>
            </p>
            {/* White under the code in either theme, so a camera reads it (DESIGN.md, Colors). */}
            <div
                id={panel}
                className={cn(
                    'order-1 w-fit max-w-full rounded-md bg-white p-2 pointer-coarse:order-3 [&>svg]:h-auto [&>svg]:max-w-full',
                    !showQr && 'pointer-coarse:hidden',
                )}
            >
                <QrCode
                    value={uri}
                    cell={3}
                    kind="recovery"
                    title="QR code for your authenticator app"
                />
            </div>
            <div className="order-2 flex flex-col gap-1.5 pointer-coarse:order-1">
                <p className="text-[13px] text-muted-foreground pointer-coarse:hidden">
                    Can’t scan it? Type this key into the app instead.
                </p>
                <div className="flex flex-wrap items-center gap-2 pointer-coarse:flex-col pointer-coarse:items-stretch">
                    <code
                        data-setup-key
                        className="min-w-0 rounded-md bg-muted px-3 py-2 font-mono text-sm wrap-anywhere"
                    >
                        {groupSecret(secret)}
                    </code>
                    <Button
                        type="button"
                        variant="outline"
                        onClick={() => void copying.copy(secret)}
                    >
                        <CopyIcon />
                        {copying.copied ? 'Copied' : 'Copy key'}
                    </Button>
                </div>
                <Problem>{copying.error}</Problem>
            </div>
            <Button
                type="button"
                variant="ghost"
                aria-expanded={showQr}
                aria-controls={panel}
                className="order-3 hidden w-fit pointer-coarse:order-2 pointer-coarse:inline-flex"
                onClick={() => setShowQr((value) => !value)}
            >
                <QrCodeIcon />
                {showQr ? 'Hide QR code' : 'Show QR code'}
            </Button>
        </li>
    );
}

const CODES_ABOUT =
    'Each code signs you in once when you can’t use your authenticator app. Save them somewhere private, apart from your password. They aren’t shown again.';

/*
 * Turning it on: the password, then the app's key to scan or type with a code from the app to
 * confirm it, then the ten backup codes, once.
 */
function TurnOnDialog({
    open,
    email,
    onClose,
    onDone,
}: {
    open: boolean;
    email: string;
    onClose: () => void;
    onDone: (signedOut: boolean) => Promise<unknown>;
}) {
    const codeId = useId();
    const othersId = useId();
    const [password, setPassword] = useState('');
    const [setup, setSetup] = useState<{ id: string; secret: string; uri: string } | null>(null);
    const [code, setCode] = useState('');
    const [signOutOthers, setSignOutOthers] = useState(true);
    const [codes, setCodes] = useState<string[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const step = useStepPrompt({
        limitMs: STEP_LIMIT_MS,
        onExpired: () => {
            setPassword('');
            setError(STEP_GAVE_UP);
        },
    });
    // The offer to sign the other devices out is made only when there are some.
    const devices = useQuery({ ...devicesQueryOptions, enabled: open });
    const others = devices.data ? devices.data.devices.some((device) => !device.current) : true;
    function leave() {
        setPassword('');
        setSetup(null);
        setCode('');
        setSignOutOthers(true);
        setCodes(null);
        setError('');
        onClose();
    }
    async function begin() {
        if (!password) return setError('Enter your password.');
        setBusy(true);
        setError('');
        try {
            setSetup(await authClient.startTotp(password, { step: step.ask }));
            setPassword('');
        } catch (cause) {
            if (cause instanceof StepCancelled) return;
            cue('error');
            setError(authError(cause));
        } finally {
            step.done();
            setBusy(false);
        }
    }
    async function confirm() {
        if (!setup) return;
        setBusy(true);
        setError('');
        const signOut = signOutOthers && others;
        try {
            const { backupCodes } = await authClient.confirmTotp(setup.id, code, signOut);
            cue('success');
            // The codes first: they exist only in this reply, and nothing that can fail (a
            // refresh on a dropped connection) may stand between it and the screen. The key
            // has done its work and goes from memory.
            setSetup(null);
            setCode('');
            if (backupCodes) setCodes(backupCodes);
            void onDone(signOut).catch(() => {});
            if (!backupCodes) leave();
        } catch (cause) {
            cue('error');
            // The ten minutes ran out: back to the start, with the server's words.
            if ((cause as { status?: unknown } | null)?.status === 404) setSetup(null);
            setError(authError(cause));
        } finally {
            setBusy(false);
        }
    }
    const view = codes ? 'codes' : setup ? 'setup' : 'password';
    const cancel = (
        <Button type="button" variant="outline" disabled={busy} onClick={leave}>
            Cancel
        </Button>
    );
    return (
        <AccountDialog
            open={open}
            onOpenChange={(next) => !next && leave()}
            pending={busy}
            locked={view === 'codes'}
            // A stray click must not drop an app half set up: it would stay in the
            // authenticator as an entry that opens nothing.
            sticky={view === 'setup'}
            view={view}
            step={step}
            stepAction={{ action: 'Continue', busy: 'Checking…' }}
            title={
                view === 'codes'
                    ? 'Save your backup codes'
                    : view === 'setup'
                      ? 'Set up your authenticator app'
                      : 'Turn on two-step sign-in'
            }
            description={
                view === 'codes'
                    ? CODES_ABOUT
                    : view === 'setup'
                      ? undefined
                      : 'You’ll need an authenticator app on your phone. It shows a new six-digit code every 30 seconds.'
            }
            onSubmit={() => {
                if (view === 'password') void begin();
                else if (view === 'setup') void confirm();
                else leave();
            }}
            footer={
                view === 'codes' ? (
                    <Button type="submit">I’ve saved them</Button>
                ) : view === 'setup' ? (
                    <>
                        {cancel}
                        <Button type="submit" disabled={busy}>
                            {busy ? 'Turning on…' : 'Turn on'}
                        </Button>
                    </>
                ) : (
                    <>
                        {cancel}
                        <Button type="submit" disabled={busy}>
                            {busy ? 'Checking…' : 'Continue'}
                        </Button>
                    </>
                )
            }
        >
            {view === 'password' && (
                <DialogField
                    label="Your password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    disabled={busy}
                    error={error}
                    onChange={(event) => setPassword(event.target.value)}
                />
            )}
            {view === 'setup' && setup && (
                <>
                    <ol className="m-0 flex list-none flex-col gap-5 p-0">
                        <SetupKey secret={setup.secret} uri={setup.uri} />
                        <li className="flex flex-col gap-1.5">
                            <label htmlFor={codeId}>
                                <span className="font-semibold">2.</span> Enter the six-digit code
                                the app shows.
                            </label>
                            <Input
                                id={codeId}
                                data-focus
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                maxLength={12}
                                spellCheck={false}
                                value={code}
                                disabled={busy}
                                aria-invalid={Boolean(error)}
                                aria-describedby={error ? `${codeId}-error` : undefined}
                                onChange={(event) => setCode(event.target.value)}
                                className="font-mono text-[15px]"
                            />
                            {error && (
                                <p
                                    id={`${codeId}-error`}
                                    role="alert"
                                    className="text-[13px] text-destructive"
                                >
                                    {error}
                                </p>
                            )}
                        </li>
                    </ol>
                    {others && (
                        <label
                            htmlFor={othersId}
                            className="flex cursor-pointer items-start gap-2.5 text-sm leading-snug"
                        >
                            <Checkbox
                                id={othersId}
                                checked={signOutOthers}
                                disabled={busy}
                                onCheckedChange={(value) => setSignOutOthers(value === true)}
                                className="mt-px"
                            />
                            <span className="flex flex-col gap-0.5">
                                Sign out my other devices
                                <span className="text-[13px] text-muted-foreground">
                                    They signed in with your password alone. They’ll need your
                                    password and a code to sign in again.
                                </span>
                            </span>
                        </label>
                    )}
                </>
            )}
            {view === 'codes' && codes && <BackupCodes codes={codes} email={email} />}
        </AccountDialog>
    );
}

/* Removing a method asks for the password and the second step; the last one turns the step off. */
function RemoveDialog({
    pending,
    onClose,
    onDone,
}: {
    pending: { method: TwoStepMethod; last: boolean } | null;
    onClose: () => void;
    onDone: () => Promise<unknown>;
}) {
    const [password, setPassword] = useState('');
    const [removing, setRemoving] = useState(false);
    const [error, setError] = useState('');
    const step = useStepPrompt({
        limitMs: STEP_LIMIT_MS,
        onExpired: () => {
            setPassword('');
            setError(STEP_GAVE_UP);
        },
    });
    const kind = pending ? kindWords[pending.method.kind] : '';
    // A name the person chose is said; the name every app starts with reads as what it is.
    const named = pending !== null && pending.method.name !== kind;
    function leave() {
        setPassword('');
        setError('');
        onClose();
    }
    async function remove() {
        if (!pending) return;
        if (!password) return setError('Enter your password.');
        setRemoving(true);
        setError('');
        try {
            await authClient.removeTwoStepMethod(pending.method.id, password, { step: step.ask });
            cue('close');
            toast.add({ title: `${kind} removed` });
            // Done: the dialog goes, and the section behind it catches up.
            leave();
            void onDone().catch(() => {});
        } catch (cause) {
            if (cause instanceof StepCancelled) return;
            cue('error');
            setError(authError(cause));
        } finally {
            step.done();
            setRemoving(false);
        }
    }
    return (
        <AccountDialog
            open={pending !== null}
            onOpenChange={(next) => !next && leave()}
            pending={removing}
            step={step}
            stepAction={{ action: 'Remove', busy: 'Removing…', destructive: true }}
            title={
                named
                    ? `Remove ${pending.method.name}?`
                    : `Remove your ${kind.toLowerCase() || 'method'}?`
            }
            description={
                pending?.last
                    ? 'This turns two-step sign-in off. You’ll sign in with your password alone, and your backup codes stop working.'
                    : 'It can no longer be used to sign in.'
            }
            onSubmit={() => void remove()}
            footer={
                <>
                    <Button type="button" variant="outline" disabled={removing} onClick={leave}>
                        Cancel
                    </Button>
                    <Button type="submit" variant="destructive" disabled={removing || !password}>
                        {removing ? 'Removing…' : 'Remove'}
                    </Button>
                </>
            }
        >
            <DialogField
                label="Your password"
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={removing}
                error={error}
                onChange={(event) => setPassword(event.target.value)}
            />
        </AccountDialog>
    );
}

/* A new set of ten: the password, the second step, then the codes, once. */
function NewCodesDialog({
    open,
    email,
    onClose,
    onDone,
}: {
    open: boolean;
    email: string;
    onClose: () => void;
    onDone: () => Promise<unknown>;
}) {
    const [password, setPassword] = useState('');
    const [codes, setCodes] = useState<string[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const step = useStepPrompt({
        limitMs: STEP_LIMIT_MS,
        onExpired: () => {
            setPassword('');
            setError(STEP_GAVE_UP);
        },
    });
    function leave() {
        setPassword('');
        setCodes(null);
        setError('');
        onClose();
    }
    async function make() {
        if (!password) return setError('Enter your password.');
        setBusy(true);
        setError('');
        try {
            const made = await authClient.newBackupCodes(password, { step: step.ask });
            cue('success');
            setPassword('');
            // The codes first; the count behind the dialog catches up after.
            setCodes(made.codes);
            void onDone().catch(() => {});
        } catch (cause) {
            if (cause instanceof StepCancelled) return;
            cue('error');
            setError(authError(cause));
        } finally {
            step.done();
            setBusy(false);
        }
    }
    return (
        <AccountDialog
            open={open}
            onOpenChange={(next) => !next && leave()}
            pending={busy}
            locked={codes !== null}
            view={codes ? 'codes' : 'password'}
            step={step}
            stepAction={{ action: 'Make new codes', busy: 'Making…' }}
            title={codes ? 'Save your backup codes' : 'Make new backup codes?'}
            description={
                codes ? CODES_ABOUT : 'You get ten new codes. The ones you have now stop working.'
            }
            onSubmit={() => (codes ? leave() : void make())}
            footer={
                codes ? (
                    <Button type="submit">I’ve saved them</Button>
                ) : (
                    <>
                        <Button type="button" variant="outline" disabled={busy} onClick={leave}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={busy}>
                            {busy ? 'Making…' : 'Make new codes'}
                        </Button>
                    </>
                )
            }
        >
            {codes ? (
                <BackupCodes codes={codes} email={email} />
            ) : (
                <DialogField
                    label="Your password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    disabled={busy}
                    error={error}
                    onChange={(event) => setPassword(event.target.value)}
                />
            )}
        </AccountDialog>
    );
}

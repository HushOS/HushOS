import type { TwoStepMethod } from '@hushos/auth/api';
import { StepCancelled } from '@hushos/auth/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyIcon, DownloadIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { devicesQueryOptions } from '@/components/account-devices';
import { AccountDialog } from '@/components/account-dialogs';
import { CopyButton } from '@/components/copy-button';
import { QrCode } from '@/components/qr-code';
import { DialogField, Done, Setting, SettingsGroup } from '@/components/settings';
import { useStepPrompt } from '@/components/two-step-prompt';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { copySecret } from '@/lib/clipboard';
import { formatDay } from '@/lib/drive';
import { authError } from '@/lib/form';
import { saveBlob } from '@/lib/save-file';
import { cue } from '@/lib/sounds';
import {
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
 * Rename and Remove, says how many backup codes are left, and makes a new set. Every change
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
    | { kind: 'rename'; method: TwoStepMethod }
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
                                            and turn two-step sign-in on again with a new one. Then
                                            make new backup codes.
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
                        <ul aria-label="Your second steps" className="m-0 list-none p-0">
                            {data.methods.map((method) => (
                                <li key={method.id} data-method-id={method.id}>
                                    <MethodRow
                                        method={method}
                                        onRename={() => setOpen({ kind: 'rename', method })}
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
                            data={{ 'data-backup-codes': String(data.backupCodesLeft) }}
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
                                Also works as your second step. Keep it somewhere other than your
                                password.
                            </span>
                        </Setting>
                    </>
                )}
            </SettingsGroup>
            <TurnOnDialog
                open={open?.kind === 'on'}
                email={user.email}
                onClose={close}
                onDone={async (signedOut) => {
                    setTurnedOn({ signedOut });
                    await refresh();
                }}
            />
            <RenameDialog
                method={open?.kind === 'rename' ? open.method : null}
                onClose={close}
                onDone={refresh}
            />
            <RemoveDialog
                pending={open?.kind === 'remove' ? open : null}
                onClose={close}
                onDone={async () => {
                    setTurnedOn(null);
                    // The lost method is gone: the suggestion to remove it has been followed.
                    notePhraseSignIn(false);
                    await refresh();
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

function MethodRow({
    method,
    onRename,
    onRemove,
}: {
    method: TwoStepMethod;
    onRename: () => void;
    onRemove: () => void;
}) {
    const kind = kindWords[method.kind];
    const facts = [
        // The name says what it is until it is renamed.
        method.name === kind ? null : kind,
        `Added ${formatDay(method.createdAt)}`,
        method.lastUsedAt ? `Last used ${usedOn(method.lastUsedAt)}` : 'Not used yet',
    ].filter(Boolean);
    return (
        <Setting
            label={method.name}
            action={
                <>
                    <Button variant="ghost" onClick={onRename} aria-label={`Rename ${method.name}`}>
                        Rename
                    </Button>
                    <Button
                        variant="destructive-outline"
                        onClick={onRemove}
                        aria-label={`Remove ${method.name}`}
                    >
                        Remove
                    </Button>
                </>
            }
        >
            <span className="text-muted-foreground">{facts.join(' · ')}</span>
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

/* The ten codes, shown once: read them, copy them, or keep them as a file. */
function BackupCodes({ codes, email }: { codes: string[]; email: string }) {
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 2_000);
        return () => window.clearTimeout(timer);
    }, [copied]);
    async function copy() {
        setError('');
        try {
            await copySecret(codes.join('\n'));
            cue('success', { volume: 0.4 });
            setCopied(true);
        } catch {
            cue('error');
            setError('Copying isn’t available here. Download the codes instead.');
        }
    }
    function download() {
        setError('');
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
                <Button type="button" variant="ghost" onClick={() => void copy()}>
                    <CopyIcon />
                    {copied ? 'Copied' : 'Copy codes'}
                </Button>
            </div>
            <Problem>{error}</Problem>
        </div>
    );
}

const CODES_ABOUT =
    'Each code signs you in once when you can’t use your authenticator app. Save them somewhere private, apart from your password. They aren’t shown again.';

/*
 * Turning it on: the password, then the app's code to scan (or its key to type) with a code
 * from the app to confirm it, then the ten backup codes, once.
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
    const step = useStepPrompt();
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
            await onDone(signOut);
            if (backupCodes) setCodes(backupCodes);
            else leave();
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
                      : 'You’ll need an authenticator app on your phone. It shows a new six-digit code every 30 seconds; many password managers can do this too.'
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
                        <li className="flex flex-col gap-3">
                            <p>
                                <span className="font-semibold">1.</span> In your authenticator app,
                                add an account and scan this code.
                            </p>
                            {/* White under the code in either theme, so a camera reads it. */}
                            <div className="w-fit max-w-full rounded-md bg-white p-2 [&>svg]:h-auto [&>svg]:max-w-full">
                                <QrCode
                                    value={setup.uri}
                                    cell={3}
                                    kind="recovery"
                                    title="Code for your authenticator app"
                                />
                            </div>
                            <div className="flex flex-col gap-1.5">
                                <p className="text-[13px] text-muted-foreground">
                                    Can’t scan it? Type this key into the app instead.
                                </p>
                                <div className="flex items-center gap-2">
                                    <code
                                        data-setup-key
                                        className="min-w-0 rounded-md bg-muted px-3 py-2 font-mono text-sm wrap-anywhere"
                                    >
                                        {groupSecret(setup.secret)}
                                    </code>
                                    <CopyButton value={setup.secret} label="Copy setup key" />
                                </div>
                                <p className="text-[13px] text-muted-foreground">
                                    The app will list it as HushOS, with your email address.
                                </p>
                            </div>
                        </li>
                        <li className="flex flex-col gap-1.5">
                            <label htmlFor={codeId}>
                                <span className="font-semibold">2.</span> Enter the code the app
                                shows.
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
                                    They signed in with your password alone. They’ll need it, and a
                                    code, to sign in again.
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

function RenameDialog({
    method,
    onClose,
    onDone,
}: {
    method: TwoStepMethod | null;
    onClose: () => void;
    onDone: () => Promise<unknown>;
}) {
    const [draft, setDraft] = useState('');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [shownFor, setShownFor] = useState<string | null>(null);
    // A dialog opened for another method starts from that method's name.
    if (method && shownFor !== method.id) {
        setShownFor(method.id);
        setDraft(method.name);
        setError('');
    }
    function leave() {
        setShownFor(null);
        onClose();
    }
    async function save() {
        if (!method) return;
        const name = draft.trim();
        if (!name) return setError('Enter a name.');
        if (Array.from(name).length > 40) return setError('Use no more than 40 characters.');
        setSaving(true);
        setError('');
        try {
            await authClient.renameTwoStepMethod(method.id, name);
            cue('success');
            await onDone();
            leave();
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setSaving(false);
        }
    }
    return (
        <AccountDialog
            open={method !== null}
            onOpenChange={(next) => !next && leave()}
            pending={saving}
            title={`Rename ${method ? kindWords[method.kind].toLowerCase() : 'method'}`}
            description="Shown in this list. Names aren’t encrypted."
            onSubmit={() => void save()}
            footer={
                <>
                    <Button type="button" variant="ghost" disabled={saving} onClick={leave}>
                        Cancel
                    </Button>
                    <Button type="submit" disabled={saving}>
                        {saving ? 'Saving…' : 'Save name'}
                    </Button>
                </>
            }
        >
            <DialogField
                label="Name"
                value={draft}
                maxLength={40}
                autoComplete="off"
                disabled={saving}
                error={error}
                onChange={(event) => setDraft(event.target.value)}
            />
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
    onDone: (on: boolean) => Promise<unknown>;
}) {
    const [password, setPassword] = useState('');
    const [removing, setRemoving] = useState(false);
    const [error, setError] = useState('');
    const step = useStepPrompt();
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
            const { on } = await authClient.removeTwoStepMethod(pending.method.id, password, {
                step: step.ask,
            });
            cue('close');
            toast.add({ title: on ? 'Removed' : 'Two-step sign-in is off' });
            await onDone(on);
            leave();
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
            title={`Remove ${pending?.method.name ?? 'this method'}?`}
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
    const step = useStepPrompt();
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
            setCodes(made.codes);
            await onDone();
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
                codes
                    ? CODES_ABOUT
                    : 'You get ten new codes. The ones you have now stop working, used or not.'
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

import type {
    KeyCreationOptions,
    SecurityEvent,
    TwoStepMethod,
    TwoStepStatus,
} from '@hushos/auth/api';
import { LostReply } from '@hushos/auth/client';
import type { SessionUser } from '@hushos/auth/protocol';
import { PASSWORD_MAX_LENGTH } from '@hushos/auth/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { devicesQueryOptions } from '@/components/account-devices';
import { CopyCheckIcon } from '@/components/copy-button';
import { SECRET_FIELD } from '@/components/password-input';
import { QrCode } from '@/components/qr-code';
import { CodeField, useCodes } from '@/components/device-approvals';
import { DeviceAsk } from '@/components/device-ask';
import { DialogField, Setting, SettingsGroup } from '@/components/settings';
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
import { whenPageLeaves } from '@/lib/new-phrase';
import { preloadPasskeys } from '@/lib/passkeys';
import { whenBrowserLocks } from '@/lib/show-new-phrase';
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
 * Two-step sign-in in Account (docs/two-step-design.md 2, 3, 4, 7, 12): passkeys and security
 * keys (add, name, remove, up to ten), the authenticator app, approving on another device,
 * which of them is offered first, the backup codes shown once, and the account's recent
 * security activity. Every
 * change asks for the password again and, once the step is on, for the step; choosing the
 * default changes only an order and asks for neither. Nothing shows on a server that has
 * two-step off.
 *
 * The section says its state once, beside its title. A kind of method is a row: its label,
 * how many or since when, and its actions in the page's one action column, Add among them.
 * Each key is a row of its own beneath its kind, so Add is never beside the first key. What
 * a change did is a toast; what went wrong stays in the section until the next try. The
 * cautions that were lines here are on /security.
 */

type Open =
    | { kind: 'app'; mode: 'on' | 'add' | 'replace' }
    | { kind: 'key' }
    | { kind: 'device' }
    | { kind: 'rename'; method: TwoStepMethod }
    | { kind: 'remove'; method: TwoStepMethod }
    | { kind: 'codes' }
    | null;

const KEY_LIMIT = 10;
/* At this many backup codes or fewer, the count is shown as a warning: time to make new ones. */
const CODES_LOW = 2;
const kindWords = {
    webauthn: 'Passkey or security key',
    totp: 'Authenticator app',
    device: 'Approve on another device',
} as const;
type Kind = keyof typeof kindWords;
type Approver = NonNullable<TwoStepStatus['approvers']>[number];
/* A device as the person knows it: its name, or what an unnamed one is called in the list. */
const approverName = (device: Approver) => device.name?.trim() || 'Unknown device';

export function AccountTwoStep({ user }: { user: SessionUser }) {
    const enabled = useTwoStepEnabled();
    const queryClient = useQueryClient();
    const status = useQuery({ ...twoStepQueryOptions, enabled });
    const [open, setOpen] = useState<Open>(null);
    const [problem, setProblem] = useState('');
    const [moving, setMoving] = useState(false);
    if (!enabled) return null;
    const refresh = () =>
        Promise.all([
            queryClient.invalidateQueries({ queryKey: twoStepQueryOptions.queryKey }),
            queryClient.invalidateQueries({ queryKey: securityEventsQueryOptions.queryKey }),
            queryClient.invalidateQueries({ queryKey: devicesQueryOptions.queryKey }),
        ]);
    // What a change did is said once, in a toast, and the section is read again either way.
    const finish = (said: string) => {
        if (said) toast.add({ type: 'success', title: said });
        void refresh();
    };
    const begin = (next: Open) => {
        setProblem('');
        setOpen(next);
    };
    const close = () => setOpen(null);
    const methods = status.data?.methods ?? [];
    const app = methods.find((method) => method.kind === 'totp');
    const keys = methods.filter((method) => method.kind === 'webauthn');
    const device = methods.find((method) => method.kind === 'device');
    const on = status.data?.on === true;
    const defaultKind = status.data?.defaultKind ?? null;
    // Which kind is offered first changes only an order: no password, no step.
    async function makeDefault(kind: Kind) {
        setProblem('');
        setMoving(true);
        try {
            await authClient.setTwoStepDefault(kind);
            cue('success');
            finish(`${kindWords[kind]} is now the default`);
        } catch (cause) {
            cue('error');
            setProblem(authError(cause));
            void refresh();
        } finally {
            setMoving(false);
        }
    }
    /*
     * Default beside the kind offered first, Make default among the other's actions, and
     * neither with one kind. The default is a kind, not a key: the badge is on the kind's
     * row, after how many keys there are, and never on one key among several.
     */
    const kinds = Number(Boolean(app)) + Number(keys.length > 0) + Number(Boolean(device));
    const choosing = on && kinds > 1;
    const isDefault = (kind: Kind) =>
        choosing && defaultKind === kind ? <Badge>Default</Badge> : null;
    // Only under a kind the account has: the server refuses any other.
    const has = (kind: Kind) =>
        kind === 'webauthn' ? keys.length > 0 : kind === 'totp' ? Boolean(app) : Boolean(device);
    const makeIt = (kind: Kind) =>
        choosing && has(kind) && defaultKind !== kind ? (
            <Button
                variant="outline"
                disabled={moving}
                aria-label={`Make ${kindWords[kind].toLowerCase()} the default`}
                onClick={() => void makeDefault(kind)}
            >
                Make default
            </Button>
        ) : null;
    // The last method is not removed: turning it off is turning the step off.
    const removeWords = methods.length === 1 ? 'Turn off' : 'Remove';
    const canAdd = authClient.canUsePasskeys();
    return (
        <div id="two-step" className="scroll-mt-20">
            <SettingsGroup
                title="Two-step sign-in"
                status={
                    status.isSuccess && (
                        <Badge
                            variant={on ? 'success' : 'outline'}
                            data-two-step={on ? 'on' : 'off'}
                        >
                            {on ? 'On' : 'Off'}
                        </Badge>
                    )
                }
            >
                {status.isPending ? (
                    <div className="flex flex-col gap-2 py-3" aria-busy="true">
                        <Skeleton className="h-5 w-48" />
                        <Skeleton className="h-4 w-72" />
                    </div>
                ) : status.isError ? (
                    <Setting
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
                ) : (
                    <>
                        {problem && (
                            <p role="alert" className="py-1 text-[13px] text-destructive">
                                {problem}
                            </p>
                        )}
                        <Setting
                            label={kindWords.webauthn}
                            data={{ 'data-two-step-keys': String(keys.length) }}
                            action={
                                <>
                                    {makeIt('webauthn')}
                                    {canAdd && keys.length < KEY_LIMIT && (
                                        <Button
                                            variant="outline"
                                            aria-label="Add passkey or security key"
                                            onClick={() => begin({ kind: 'key' })}
                                        >
                                            Add
                                        </Button>
                                    )}
                                </>
                            }
                        >
                            <span className="flex min-w-0 flex-wrap items-center gap-2">
                                <span className="text-muted-foreground">
                                    {keysCount(keys.length, canAdd)}
                                </span>
                                {isDefault('webauthn')}
                            </span>
                        </Setting>
                        {keys.length > 0 && (
                            <ul
                                aria-label="Passkeys and security keys"
                                className="m-0 list-none p-0"
                            >
                                {keys.map((key) => (
                                    <KeyRow
                                        key={key.id}
                                        method={key}
                                        removeWords={removeWords}
                                        onRename={() => begin({ kind: 'rename', method: key })}
                                        onRemove={() => begin({ kind: 'remove', method: key })}
                                    />
                                ))}
                            </ul>
                        )}
                        <Setting
                            label={kindWords.totp}
                            data={{ 'data-two-step-app': app ? 'on' : 'off' }}
                            action={
                                app ? (
                                    <>
                                        {makeIt('totp')}
                                        <Button
                                            variant="outline"
                                            aria-label="Replace authenticator app"
                                            onClick={() => begin({ kind: 'app', mode: 'replace' })}
                                        >
                                            Replace
                                        </Button>
                                        <Button
                                            variant="destructive-outline"
                                            aria-label={`${removeWords} authenticator app`}
                                            onClick={() => begin({ kind: 'remove', method: app })}
                                        >
                                            {removeWords}
                                        </Button>
                                    </>
                                ) : (
                                    <Button
                                        variant="outline"
                                        aria-label="Add authenticator app"
                                        onClick={() =>
                                            begin({ kind: 'app', mode: on ? 'add' : 'on' })
                                        }
                                    >
                                        Add
                                    </Button>
                                )
                            }
                            below={
                                status.data.totpFrozen && (
                                    <p className="text-[13px] text-muted-foreground">
                                        A backup code or your recovery phrase lifts the pause.
                                    </p>
                                )
                            }
                        >
                            {app ? (
                                <span className="flex min-w-0 flex-wrap items-center gap-2">
                                    {/* One fact, so the value never wraps beside three actions. */}
                                    <span className="whitespace-nowrap text-muted-foreground">
                                        {latest(app)}
                                    </span>
                                    {isDefault('totp')}
                                    {status.data.totpFrozen && (
                                        <Badge variant="warning">Paused</Badge>
                                    )}
                                </span>
                            ) : (
                                <span className="text-muted-foreground">Not added</span>
                            )}
                        </Setting>
                        {/* Only where the server knows the method: a row for it, On or Off. */}
                        {(device || status.data.otherDevice !== undefined) && (
                            <Setting
                                label={kindWords.device}
                                data={{ 'data-two-step-device': device ? 'on' : 'off' }}
                                action={
                                    device ? (
                                        <>
                                            {makeIt('device')}
                                            <Button
                                                variant="destructive-outline"
                                                aria-label="Turn off Approve on another device"
                                                onClick={() =>
                                                    begin({ kind: 'remove', method: device })
                                                }
                                            >
                                                Turn off
                                            </Button>
                                        </>
                                    ) : (
                                        status.data.otherDevice && (
                                            <Button
                                                variant="outline"
                                                aria-label="Turn on Approve on another device"
                                                onClick={() => begin({ kind: 'device' })}
                                            >
                                                Turn on
                                            </Button>
                                        )
                                    )
                                }
                            >
                                <span className="flex min-w-0 flex-wrap items-center gap-2">
                                    <span className="whitespace-nowrap text-muted-foreground">
                                        {device
                                            ? 'On'
                                            : status.data.otherDevice
                                              ? 'Off'
                                              : 'Needs another device'}
                                    </span>
                                    {isDefault('device')}
                                </span>
                            </Setting>
                        )}
                        {on && (
                            <Setting
                                label="Backup codes"
                                action={
                                    <Button
                                        variant="outline"
                                        onClick={() => begin({ kind: 'codes' })}
                                    >
                                        New codes
                                    </Button>
                                }
                            >
                                {/* Two or fewer: the same words, in the warning tone, and no sentence. */}
                                {status.data.backupCodesLeft <= CODES_LOW ? (
                                    <Badge variant="warning" data-codes-low>
                                        {codesLeft(status.data)}
                                    </Badge>
                                ) : (
                                    <span className="text-muted-foreground">
                                        {codesLeft(status.data)}
                                    </span>
                                )}
                            </Setting>
                        )}
                    </>
                )}
                {status.isSuccess && <SecurityActivity />}
            </SettingsGroup>
            <AppDialog
                // A new dialog each time it opens: nothing of a secret or a password is kept.
                key={`app-${open?.kind === 'app' ? open.mode : 'closed'}`}
                user={user}
                mode={open?.kind === 'app' ? open.mode : 'on'}
                open={open?.kind === 'app'}
                onClose={close}
                onDone={finish}
            />
            <KeyDialog
                key={`key-${open?.kind === 'key'}`}
                user={user}
                first={!on}
                open={open?.kind === 'key'}
                onClose={close}
                onDone={finish}
            />
            <DeviceDialog
                key={`device-${open?.kind === 'device'}`}
                user={user}
                first={!on}
                approvers={status.data?.approvers ?? []}
                open={open?.kind === 'device'}
                onClose={close}
                onDone={finish}
            />
            <RenameKeyDialog
                method={open?.kind === 'rename' ? open.method : null}
                onClose={close}
                onDone={finish}
            />
            <RemoveDialog
                key={`remove-${open?.kind === 'remove' ? open.method.id : 'closed'}`}
                method={open?.kind === 'remove' ? open.method : null}
                last={methods.length === 1}
                onClose={close}
                onDone={finish}
            />
            <NewCodesDialog
                key={`codes-${open?.kind === 'codes'}`}
                user={user}
                open={open?.kind === 'codes'}
                onClose={close}
                onDone={finish}
            />
        </div>
    );
}

function used(method: TwoStepMethod) {
    const added = `Added ${formatDay(method.createdAt)}`;
    return method.lastUsedAt ? `${added} · Last used ${formatDay(method.lastUsedAt)}` : added;
}

/* The app's one fact: when it was last used, or when it was added if it never was. */
const latest = (method: TwoStepMethod) =>
    method.lastUsedAt
        ? `Last used ${formatDay(method.lastUsedAt)}`
        : `Added ${formatDay(method.createdAt)}`;

/*
 * How many keys, where a count is the value: none, some, or all an account can have, which
 * is also why Add is gone. A browser that cannot add one says so here, for the same reason.
 */
function keysCount(count: number, canAdd: boolean) {
    if (!canAdd) return 'This browser can’t use passkeys or security keys.';
    if (count === 0) return 'Not added';
    if (count >= KEY_LIMIT) return `${count} keys, the most an account can have`;
    return count === 1 ? '1 key' : `${count} keys`;
}

/*
 * One key, a row beneath its kind: its name, where it lives, when it was added and last
 * used, and its two actions in the page's action column.
 */
function KeyRow({
    method,
    removeWords,
    onRename,
    onRemove,
}: {
    method: TwoStepMethod;
    removeWords: string;
    onRename: () => void;
    onRemove: () => void;
}) {
    const name = method.name ?? 'Security key';
    return (
        <li data-two-step-key-row>
            <Setting
                action={
                    <>
                        <Button variant="outline" onClick={onRename} aria-label={`Rename ${name}`}>
                            Rename
                        </Button>
                        <Button
                            variant="destructive-outline"
                            onClick={onRemove}
                            aria-label={`${removeWords} ${name}`}
                        >
                            {removeWords}
                        </Button>
                    </>
                }
            >
                <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium wrap-anywhere">{name}</span>
                    <span className="text-[13px] text-muted-foreground">
                        {method.synced ? 'Saved in a password manager · ' : ''}
                        {used(method)}
                    </span>
                </div>
            </Setting>
        </li>
    );
}

function codesLeft(status: TwoStepStatus) {
    const left = status.backupCodesLeft;
    return left === 0 ? 'None left' : `${left} of 10 left`;
}

/* ------------------------------------------------------------------------- */
/* Recent security activity                                                   */
/* ------------------------------------------------------------------------- */

const withMethod: Record<NonNullable<SecurityEvent['method']>, string> = {
    totp: 'an authenticator code',
    backup: 'a backup code',
    phrase: 'your recovery phrase',
    webauthn: 'a passkey or security key',
    device: 'another device',
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
        // Said by the kind of method, so the line is right for a key too. An app's line covers
        // both an app added beside a key and one that replaced another.
        case 'method-added':
            return event.method === 'webauthn'
                ? 'Passkey or security key added'
                : event.method === 'totp'
                  ? 'Authenticator app added'
                  : event.method === 'device'
                    ? 'Approve on another device turned on'
                    : 'Second-step method added';
        case 'method-removed':
            return event.method === 'webauthn'
                ? 'Passkey or security key removed'
                : event.method === 'totp'
                  ? 'Authenticator app removed'
                  : event.method === 'device'
                    ? 'Approve on another device turned off'
                    : 'Second-step method removed';
        case 'default-changed':
            return event.method === 'webauthn'
                ? 'Default changed to passkey or security key'
                : event.method === 'totp'
                  ? 'Default changed to authenticator app'
                  : event.method === 'device'
                    ? 'Default changed to another device'
                    : 'Default changed';
        case 'key-counter':
            return 'A security key was refused: it may have been copied';
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
            top
            below={
                list.length > SHOWN && (
                    <Button
                        variant="outline"
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
                Each code works once. They aren’t shown again.
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
/*
 * While a dialog is open with a secret on it (an authenticator key, backup codes): a lock or a
 * sign-out anywhere, here or in another tab, or the page being left, closes it and forgets
 * them. Account stays mounted when the browser locks, so nothing else would. The returned
 * count moves each time: an answer that comes back after it moved is dropped, so a late
 * reply cannot put the secret back on screen.
 */
function useForgottenOnLock(open: boolean, forget: () => void) {
    const era = useRef(0);
    const latest = useRef(forget);
    useEffect(() => {
        latest.current = forget;
    });
    useEffect(() => {
        if (!open) return undefined;
        const gone = () => {
            era.current += 1;
            latest.current();
        };
        const locked = whenBrowserLocks(gone);
        const leaving = whenPageLeaves(gone);
        return () => {
            locked();
            leaving();
        };
    }, [open]);
    return era;
}

function AppDialog({
    user,
    mode,
    open,
    onClose,
    onDone,
}: {
    user: SessionUser;
    /* `on`: the account's first method. `add`: an app beside its keys. `replace`: a new app for the old. */
    mode: 'on' | 'add' | 'replace';
    open: boolean;
    onClose: () => void;
    onDone: (said: string) => void;
}) {
    const codeId = useId();
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
    const turningOn = mode === 'on';
    const era = useForgottenOnLock(open, () => {
        setApp(null);
        setCodes(null);
        setCode('');
        setPassword('');
        onClose();
    });
    // With the step already on it is needed from the start: its fields are there when the dialog opens.
    const { ask } = step;
    useEffect(() => {
        if (open && !turningOn) void ask().catch(() => {});
        // Only when the dialog opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, turningOn]);

    async function start() {
        setTried(true);
        if (!password) return;
        setPending(true);
        setError('');
        try {
            if (await step.ask()) return;
            const twoStep = await step.prove();
            if (twoStep === null) return;
            const at = era.current;
            const started = await authClient.startAuthenticator(password, twoStep);
            if (at !== era.current) return;
            setApp(started);
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
            const at = era.current;
            const confirmed = await authClient.confirmAuthenticator(app.id, typed);
            if (at !== era.current) return;
            const backupCodes = 'backupCodes' in confirmed ? confirmed.backupCodes : null;
            cue('success');
            if (!backupCodes) {
                // Turning the step on always comes back with the codes. An answer without
                // them is not the server's answer to that: nothing is claimed, and the
                // section behind this dialog is read again (below).
                if (turningOn)
                    throw new LostReply(
                        'The server’s answer didn’t arrive, so HushOS can’t tell whether two-step sign-in was turned on. Check before you try again.',
                    );
                onDone(replacing ? 'Authenticator app replaced' : 'Authenticator app added');
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
            // Only when the step is being turned on. Replacing or adding an app never removes
            // a device, even when it comes back with codes: another tab removed the last
            // method meanwhile, and nobody was offered, or agreed to, any removal here.
            if (turningOn && signOutOthers) {
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
            // Any failure may hide a change that went through (a reply that was not the
            // server's own, a dropped connection, a gateway's 502): the section behind this
            // dialog is read again, and shows whether the step is on. Reading it costs nothing.
            onDone('');
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
                    onDone('');
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
                            {pending
                                ? 'Checking'
                                : replacing
                                  ? 'Replace app'
                                  : turningOn
                                    ? 'Turn on'
                                    : 'Add app'}
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
                {turningOn && (
                    <RemoveOthersOffer
                        checked={signOutOthers}
                        onChange={setSignOutOthers}
                        disabled={pending}
                        others={others}
                    />
                )}
            </Shell>
        );
    }
    return (
        <Shell
            open={open}
            pending={pending}
            title={
                replacing
                    ? 'Replace your authenticator app?'
                    : turningOn
                      ? 'Turn on two-step sign-in?'
                      : 'Add an authenticator app?'
            }
            description={
                replacing
                    ? 'The new app takes over once you confirm it.'
                    : turningOn
                      ? 'After your password, HushOS will ask for a code from an authenticator app.'
                      : undefined
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

/* The offer made whenever the step is being turned on: the other devices never passed it. */
function RemoveOthersOffer({
    checked,
    onChange,
    disabled,
    others,
    keeps = false,
}: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    disabled: boolean;
    /* How many other devices the list shows, when it could be read: it only words the offer. */
    others: number | null;
    /* The device that approves stays signed in: it is the method. */
    keeps?: boolean;
}) {
    const id = useId();
    return (
        <div className="flex items-start gap-3">
            <Checkbox
                id={id}
                checked={checked}
                disabled={disabled}
                onCheckedChange={(next) => onChange(next === true)}
                className="mt-0.5"
            />
            <label htmlFor={id} className="flex flex-col gap-0.5 text-sm">
                <span className="font-semibold">Remove my other devices</span>
                <span className="text-[13px] text-muted-foreground">
                    {keeps
                        ? 'All but this one and the one that approves. They’ll need to sign in again.'
                        : others
                          ? `${others === 1 ? 'One other device' : `${others} other devices`} will need to sign in again.`
                          : 'They’ll need to sign in again.'}
                </span>
            </label>
        </div>
    );
}

/*
 * Adding a passkey or security key: the password (and the step, once it is on), then the key
 * itself, asked by the browser on the press of Add, with a name for it if the person wants
 * one. The account's first method turns the step on, and its backup codes follow.
 */
function KeyDialog({
    user,
    first,
    open,
    onClose,
    onDone,
}: {
    user: SessionUser;
    /* The account has no method yet: this key turns the step on. */
    first: boolean;
    open: boolean;
    onClose: () => void;
    onDone: (said: string) => void;
}) {
    const devices = useQuery({ ...devicesQueryOptions, enabled: open && first });
    const others = devices.isSuccess
        ? devices.data.devices.filter((device) => !device.current).length
        : null;
    const step = useStepUp('two-step');
    const [password, setPassword] = useState('');
    const [tried, setTried] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [started, setStarted] = useState<{
        registrationToken: string;
        options: KeyCreationOptions;
    } | null>(null);
    const [name, setName] = useState('');
    const [signOutOthers, setSignOutOthers] = useState(true);
    const [codes, setCodes] = useState<string[] | null>(null);
    const [removing, setRemoving] = useState<'no' | 'running' | 'failed'>('no');
    const era = useForgottenOnLock(open, () => {
        setStarted(null);
        setCodes(null);
        setPassword('');
        onClose();
    });
    const { ask } = step;
    useEffect(() => {
        if (!open) return;
        // The browser's part is fetched now, so the press that adds the key goes straight to it.
        preloadPasskeys();
        if (!first) void ask().catch(() => {});
        // Only when the dialog opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, first]);

    async function start() {
        setTried(true);
        if (!password) return;
        setPending(true);
        setError('');
        try {
            if (await step.ask()) return;
            const twoStep = await step.prove();
            if (twoStep === null) return;
            const at = era.current;
            const next = await authClient.startPasskey(password, twoStep);
            if (at !== era.current) return;
            setStarted(next);
            setTried(false);
        } catch (cause) {
            cue('error');
            if (!(await step.failed(cause))) setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    async function add() {
        if (!started) return;
        const label = name.trim();
        if (Array.from(label).length > 40) return setError('Use no more than 40 characters.');
        setPending(true);
        setError('');
        try {
            const at = era.current;
            // The browser's sheet opens here, on this press.
            const added = await authClient.addPasskey(started, label || undefined);
            if (at !== era.current) return;
            cue('success');
            if (!added.backupCodes) {
                // Turning the step on always comes back with the codes: without them this is
                // not the server's answer to that, and the section behind is read again.
                if (first)
                    throw new LostReply(
                        'The server’s answer didn’t arrive, so HushOS can’t tell whether two-step sign-in was turned on. Check before you try again.',
                    );
                onDone('Passkey or security key added');
                onClose();
                return;
            }
            // The codes first: they are shown once, and nothing that follows may cost them.
            setCodes(added.backupCodes);
            onDone('');
            if (first && signOutOthers) {
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
            // Nothing was sent when the browser's sheet was closed: the same setup still stands.
            // Anything the server answered ends it (a registration is good for one answer),
            // and may hide a key that was added: the section behind is read again.
            if ((cause as { kept?: unknown } | null)?.kept !== true) {
                setStarted(null);
                setTried(false);
                onDone('');
            }
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
                    onDone('');
                    onClose();
                }}
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
    if (started)
        return (
            <Shell
                open={open}
                pending={pending}
                title="Add your passkey or security key"
                description="Your browser will ask for it."
                onClose={onClose}
                onSubmit={() => void add()}
                footer={
                    <>
                        {cancel}
                        <Button type="submit" disabled={pending}>
                            {pending ? 'Waiting for your key' : first ? 'Add and turn on' : 'Add'}
                        </Button>
                    </>
                }
            >
                <DialogField
                    label="Name"
                    value={name}
                    maxLength={40}
                    autoComplete="off"
                    placeholder="Security key"
                    disabled={pending}
                    onChange={(event) => {
                        setName(event.target.value);
                        setError('');
                    }}
                    hint="Optional. Names aren’t encrypted."
                />
                {first && (
                    <RemoveOthersOffer
                        checked={signOutOthers}
                        onChange={setSignOutOthers}
                        disabled={pending}
                        others={others}
                    />
                )}
                <Problem>{error}</Problem>
            </Shell>
        );
    return (
        <Shell
            open={open}
            pending={pending}
            title={first ? 'Turn on two-step sign-in?' : 'Add a passkey or security key?'}
            description={
                first
                    ? 'After your password, HushOS will ask for your passkey or security key.'
                    : undefined
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

/*
 * Turning on Approve on another device (docs/two-step-design.md 12): the password (and the
 * step, once it is on), then one real approval from another device, asked from here the way a
 * sign-in asks. The account's first method turns the step on, and its backup codes follow.
 *
 * The person says which of their devices is to approve, and only that one is asked. With no
 * method yet, every signed-in device looks the same to the server, one someone else opened
 * with the password among them: a request any of them could answer would let that one answer
 * first, and count as the person's own from then on.
 *
 * The list alone proves nothing: a device's name and kind are its own words, and someone with
 * the password can sign in as "Maya’s iPhone". So none is ever chosen for the person, and the
 * approval is not enough: the device that approved shows a code, and the person types it here
 * (the server checks it again). A device they are not holding shows them nothing to type.
 *
 * Turning the step on offers to remove the other devices, ticked, as the authenticator app
 * does: every device but this one and the one that approved, which is the method.
 */
function DeviceDialog({
    user,
    first,
    approvers,
    open,
    onClose,
    onDone,
}: {
    user: SessionUser;
    /* The account has no method yet: this turns the step on. */
    first: boolean;
    /* The devices that could approve, for the person to choose one. */
    approvers: Approver[];
    open: boolean;
    onClose: () => void;
    onDone: (said: string) => void;
}) {
    const group = useId();
    const step = useStepUp('two-step');
    const [password, setPassword] = useState('');
    const [tried, setTried] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [started, setStarted] = useState<{ id: string; token: string } | null>(null);
    // The request the chosen device approved, and the check its code must pass, typed here.
    const [ready, setReady] = useState<{
        requestId: string;
        matches: (typed: string) => Promise<string | null>;
    } | null>(null);
    const [typed, setTyped] = useState('');
    const words = useCodes(started !== null);
    const [codes, setCodes] = useState<string[] | null>(null);
    // Never chosen for the person, even when there is one: the names are the devices' own words.
    const [chosenId, setChosenId] = useState('');
    const chosen = approvers.find((device) => device.id === chosenId);
    const [signOutOthers, setSignOutOthers] = useState(true);
    const [removing, setRemoving] = useState<'no' | 'running' | 'failed'>('no');
    const era = useForgottenOnLock(open, () => {
        setStarted(null);
        setReady(null);
        setTyped('');
        setCodes(null);
        setPassword('');
        onClose();
    });
    const { ask } = step;
    useEffect(() => {
        if (open && !first) void ask().catch(() => {});
        // Only when the dialog opens.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open, first]);

    async function start() {
        setTried(true);
        if (!password || !chosen) return;
        setPending(true);
        setError('');
        try {
            if (await step.ask()) return;
            const twoStep = await step.prove();
            if (twoStep === null) return;
            const at = era.current;
            const next = await authClient.startDeviceMethod(password, twoStep);
            if (at !== era.current) return;
            setStarted(next);
            setTried(false);
        } catch (cause) {
            cue('error');
            if (!(await step.failed(cause))) setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    async function confirm() {
        if (!started || !ready) return;
        setPending(true);
        setError('');
        try {
            const at = era.current;
            // Checked here first, against what this browser itself worked out; the server
            // checks it again. One try: a wrong code is the end of this request.
            const code = await ready.matches(typed);
            if (at !== era.current) return;
            if (!code) {
                cue('error');
                setReady(null);
                setTyped('');
                setError('That code didn’t match, so nothing was turned on.');
                return;
            }
            const confirmed = await authClient.confirmDeviceMethod(started, ready.requestId, code);
            if (at !== era.current) return;
            cue('success');
            if ('backupCodes' in confirmed) {
                // The codes first: they are shown once, and nothing that follows may cost them.
                setCodes(confirmed.backupCodes);
                onDone('');
                if (first && signOutOthers && chosen) {
                    setRemoving('running');
                    // Every other device but the one that approved: it is the method.
                    void authClient.removeOtherDevices(password, chosen.id).then(
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
                return;
            }
            // Turning the step on always comes back with the codes: without them this is not
            // the server's answer to that, and the section behind is read again.
            if (first)
                throw new LostReply(
                    'The server’s answer didn’t arrive, so HushOS can’t tell whether two-step sign-in was turned on. Check before you try again.',
                );
            onDone('Approve on another device is on');
            onClose();
        } catch (cause) {
            cue('error');
            // The approval is used up or over either way: the setup starts again, and the
            // section behind is read again in case it went through.
            setStarted(null);
            setReady(null);
            setTyped('');
            onDone('');
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
                    onDone('');
                    onClose();
                }}
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
    if (started && chosen)
        return (
            <Shell
                open={open}
                pending={pending}
                title={`Approve on ${approverName(chosen)}`}
                onClose={onClose}
                onSubmit={() => void confirm()}
                footer={
                    <>
                        {cancel}
                        {ready && (
                            <Button
                                type="submit"
                                disabled={pending || words?.normalizeApprovalCode(typed) == null}
                            >
                                {pending ? 'Checking' : first ? 'Turn on' : 'Add'}
                            </Button>
                        )}
                    </>
                }
            >
                {/* The press of Continue asked for it: the request goes out as this opens. */}
                <DeviceAsk
                    key={started.token}
                    token={started.token}
                    purpose="device-approval"
                    approved={ready?.requestId ?? ''}
                    auto
                    disabled={pending}
                    approver={{ id: chosen.id, name: approverName(chosen) }}
                    onApproved={(requestId, matches) => {
                        setError('');
                        setReady({ requestId, matches });
                    }}
                />
                {/* That device approved: it now shows the code, and it is typed here. */}
                {ready && (
                    <CodeField
                        label={`Code on ${approverName(chosen)}`}
                        codes={words}
                        value={typed}
                        onChange={(next) => {
                            setTyped(next);
                            setError('');
                        }}
                        readOnly={pending}
                    />
                )}
                <Problem>{error}</Problem>
            </Shell>
        );
    return (
        <Shell
            open={open}
            pending={pending}
            title={first ? 'Turn on two-step sign-in?' : 'Turn on Approve on another device?'}
            description={
                first
                    ? 'After your password, HushOS will ask another of your devices to confirm it’s you.'
                    : undefined
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
            <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0" data-approvers>
                <legend className="mb-1.5 p-0 text-[13px] font-semibold">
                    Device that will approve
                </legend>
                {approvers.map((device) => (
                    <div key={device.id} className="flex items-start gap-3 text-sm">
                        <input
                            id={`${group}-${device.id}`}
                            type="radio"
                            name={group}
                            value={device.id}
                            checked={chosenId === device.id}
                            disabled={pending}
                            onChange={() => setChosenId(device.id)}
                            aria-describedby={`${group}-${device.id}-about`}
                            className="mt-1 size-4 accent-primary"
                        />
                        <span className="flex min-w-0 flex-col">
                            <label
                                htmlFor={`${group}-${device.id}`}
                                className="font-semibold wrap-break-word"
                            >
                                {approverName(device)}
                            </label>
                            <span
                                id={`${group}-${device.id}-about`}
                                className="text-[13px] text-muted-foreground"
                            >
                                {deviceWords[device.kind ?? 'web']} · Added{' '}
                                {formatDay(device.createdAt)}
                            </span>
                        </span>
                    </div>
                ))}
                {tried && !chosen && (
                    <p role="alert" className="text-[13px] text-destructive">
                        Choose the device that will approve.
                    </p>
                )}
            </fieldset>
            <PasswordField
                value={password}
                onChange={setPassword}
                disabled={pending}
                tried={tried}
            />
            <StepUpFields step={step} disabled={pending} />
            {first && (
                <RemoveOthersOffer
                    checked={signOutOthers}
                    onChange={setSignOutOthers}
                    disabled={pending}
                    others={null}
                    keeps
                />
            )}
            <Problem>{error}</Problem>
        </Shell>
    );
}

/* A key's name: a label for this list, by the device-name rules, and not encrypted. */
function RenameKeyDialog({
    method,
    onClose,
    onDone,
}: {
    method: TwoStepMethod | null;
    onClose: () => void;
    onDone: (said: string) => void;
}) {
    const [draft, setDraft] = useState('');
    const [error, setError] = useState('');
    const [saving, setSaving] = useState(false);
    const [shownFor, setShownFor] = useState<string | null>(null);
    // A dialog opened for another key starts from that key's name.
    if (method && shownFor !== method.id) {
        setShownFor(method.id);
        setDraft(method.name ?? '');
        setError('');
    }
    const leave = () => {
        setShownFor(null);
        onClose();
    };
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
            onDone('');
            leave();
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setSaving(false);
        }
    }
    return (
        <Shell
            open={method !== null}
            pending={saving}
            title="Rename passkey or security key"
            description="Names aren’t encrypted."
            onClose={leave}
            onSubmit={() => void save()}
            footer={
                <>
                    <Button type="button" variant="outline" disabled={saving} onClick={leave}>
                        Cancel
                    </Button>
                    <Button type="submit" disabled={saving}>
                        {saving ? 'Saving' : 'Save name'}
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
        </Shell>
    );
}

/*
 * Removing a method: the password and the step, by any method, the one being removed
 * included. Removing the last one is turning the step off, and is said so.
 */
function RemoveDialog({
    method,
    last,
    onClose,
    onDone,
}: {
    method: TwoStepMethod | null;
    /* The account's only method: removing it turns the step off. */
    last: boolean;
    onClose: () => void;
    onDone: (said: string) => void;
}) {
    const open = method !== null;
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
    const app = method?.kind === 'totp';
    const another = method?.kind === 'device';
    async function submit() {
        setTried(true);
        if (!password || !method) return;
        setPending(true);
        setError('');
        try {
            if (await step.ask()) return;
            const twoStep = await step.prove();
            if (twoStep === null) return;
            const removed = await authClient.removeTwoStepMethod(method.id, password, twoStep);
            cue('success');
            onDone(
                !removed.on
                    ? 'Two-step sign-in is off'
                    : app
                      ? 'Authenticator app removed'
                      : another
                        ? 'Approve on another device is off'
                        : 'Passkey or security key removed',
            );
            onClose();
        } catch (cause) {
            cue('error');
            // Any failure may hide a removal that went through (a lost reply, a dropped
            // connection, a gateway's 502): the section behind this dialog is read again.
            onDone('');
            if (!(await step.failed(cause))) setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <Shell
            open={open}
            pending={pending}
            title={
                last
                    ? 'Turn off two-step sign-in?'
                    : app
                      ? 'Remove your authenticator app?'
                      : another
                        ? 'Turn off Approve on another device?'
                        : 'Remove this passkey or security key?'
            }
            description={
                last
                    ? 'Your password alone will sign you in, and your backup codes will stop working.'
                    : app
                      ? 'Its codes will stop working for sign-in.'
                      : `${method?.name ?? 'This key'} will stop working for sign-in.`
            }
            onClose={onClose}
            onSubmit={() => void submit()}
            footer={
                <>
                    <Button type="button" variant="outline" disabled={pending} onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" variant="destructive" disabled={pending}>
                        {last
                            ? pending
                                ? 'Turning off'
                                : 'Turn off'
                            : pending
                              ? 'Removing'
                              : 'Remove'}
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
    const era = useForgottenOnLock(open, () => {
        setCodes(null);
        setPassword('');
        onClose();
    });
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
            const at = era.current;
            const made = await authClient.newBackupCodes(password, twoStep);
            if (at !== era.current) return;
            setCodes(made.codes);
            cue('success');
            onDone('');
        } catch (cause) {
            cue('error');
            // As above, for any failure: new codes may have been made, so how many are left is read again.
            onDone('');
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
                    onDone('');
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

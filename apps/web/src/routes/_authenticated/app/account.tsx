import { createFileRoute, getRouteApi, Link, useRouter } from '@tanstack/react-router';
import { ChevronDownIcon, LockKeyholeIcon, LockKeyholeOpenIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import {
    ChangePasswordDialog,
    DeleteAccountDialog,
    NewKeyDialog,
} from '@/components/account-dialogs';
import { CopyValue } from '@/components/copy-value';
import { openDeviceDialog } from '@/components/device-control';
import { PageHeader } from '@/components/page-header';
import { Done, Segmented, Setting, SettingsGroup } from '@/components/settings';
import { useTheme } from '@/components/theme-provider';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { useBillingEnabled } from '@/lib/queries';
import { forgetSession } from '@/lib/session';
import { cue, setSoundsEnabled, useSoundsEnabled } from '@/lib/sounds';
import type { Theme } from '@/lib/theme';

export const Route = createFileRoute('/_authenticated/app/account')({
    head: () => ({ meta: [{ title: 'Account · HushOS' }] }),
    component: AccountPage,
});

/*
 * Account: somewhere people come rarely and want to leave quickly. Name and
 * password, the recovery phrase, what this browser does, and, folded away,
 * the heavy things: resetting sharing keys, the account ID, deleting the
 * account. Each of those asks once, in a dialog.
 */

const themes = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'Same as this computer' },
] as const satisfies readonly { value: Theme; label: string }[];

function AccountPage() {
    const { user } = Route.useRouteContext();
    const [dialog, setDialog] = useState<
        'password' | 'recovery-key' | 'master-key' | 'delete' | null
    >(null);
    const [passwordChanged, setPasswordChanged] = useState(false);
    const [advanced, setAdvanced] = useState(false);
    const close = (open: boolean) => !open && setDialog(null);
    return (
        <div className="flex flex-col pb-10">
            <PageHeader title="Account" />
            <div className="flex max-w-3xl flex-col gap-9 px-5 sm:px-8">
                <SettingsGroup title="You" description="Your name, email and password.">
                    <NameSetting name={user.name} />
                    <Setting label="Email">
                        <span className="text-muted-foreground wrap-anywhere">{user.email}</span>
                    </Setting>
                    <Setting
                        label="Password"
                        action={
                            <Button variant="outline" onClick={() => setDialog('password')}>
                                Change password
                            </Button>
                        }
                        below={
                            passwordChanged && (
                                <Done>Password changed. Your other devices are signed out.</Done>
                            )
                        }
                    >
                        <span aria-hidden="true" className="tracking-[0.2em] text-muted-foreground">
                            ••••••••••
                        </span>
                    </Setting>
                </SettingsGroup>

                <SettingsGroup
                    title="If you forget your password"
                    description="Your recovery phrase is the only way back in."
                >
                    <Setting
                        label="Recovery phrase"
                        action={
                            <>
                                <Button variant="ghost" onClick={() => setDialog('recovery-key')}>
                                    Make a new phrase
                                </Button>
                                <Link
                                    to="/app/recovery-key"
                                    className={buttonVariants({ variant: 'outline' })}
                                >
                                    View
                                </Link>
                            </>
                        }
                    >
                        <span className="text-muted-foreground">24 words</span>
                    </Setting>
                </SettingsGroup>

                <BrowserSettings />

                <SettingsGroup
                    title="Advanced"
                    description="Rarely needed."
                    action={
                        <button
                            type="button"
                            aria-expanded={advanced}
                            aria-controls="advanced-settings"
                            onClick={() => setAdvanced((value) => !value)}
                            className="flex h-9 cursor-pointer items-center gap-1.5 rounded-md px-3 text-sm font-semibold text-primary outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                        >
                            {advanced ? 'Hide' : 'Show'}
                            <ChevronDownIcon
                                className={`size-4 transition-transform ${advanced ? 'rotate-180' : ''}`}
                                aria-hidden="true"
                            />
                        </button>
                    }
                >
                    <div id="advanced-settings" hidden={!advanced}>
                        <Setting
                            label="Sharing keys"
                            action={
                                <Button variant="outline" onClick={() => setDialog('master-key')}>
                                    Reset sharing keys
                                </Button>
                            }
                            below={
                                <p className="text-[13px] text-muted-foreground">
                                    Only if you think someone saw your password or recovery phrase.
                                    You get a new recovery phrase and your other devices are signed
                                    out. Files, shares and links stay as they are.
                                </p>
                            }
                        >
                            <span className="text-muted-foreground">
                                Used to share with people and links
                            </span>
                        </Setting>
                        <Setting label="Account ID">
                            <span className="font-mono text-sm">
                                <CopyValue value={user.id} label="Account ID" />
                            </span>
                        </Setting>
                        <Setting
                            label="Delete account"
                            action={
                                <Button variant="destructive" onClick={() => setDialog('delete')}>
                                    Delete account
                                </Button>
                            }
                        >
                            <span className="text-muted-foreground">
                                Every file, every earlier version and the account. It can’t be
                                undone.
                            </span>
                        </Setting>
                    </div>
                </SettingsGroup>
            </div>

            <AboutLine />

            <ChangePasswordDialog
                user={user}
                open={dialog === 'password'}
                onOpenChange={close}
                onChanged={() => setPasswordChanged(true)}
            />
            <NewKeyDialog
                user={user}
                action="recovery-key"
                open={dialog === 'recovery-key'}
                onOpenChange={close}
            />
            <NewKeyDialog
                user={user}
                action="master-key"
                open={dialog === 'master-key'}
                onOpenChange={close}
            />
            <DeleteAccountDialog open={dialog === 'delete'} onOpenChange={close} />
        </div>
    );
}

const root = getRouteApi('__root__');
const noSubscription = () => () => {};

/*
 * The foot: which HushOS this is, and on a self-hosted one, which server, so a
 * person with accounts on two knows where they are.
 */
function AboutLine() {
    const release = root.useLoaderData()?.release ?? null;
    const selfHosted = !useBillingEnabled();
    // The server renders without a host; the browser fills it in after hydrating.
    const host = useSyncExternalStore(
        noSubscription,
        () => window.location.host,
        () => '',
    );
    const parts = [
        release ? `HushOS ${release.slice(0, 7)}` : 'HushOS',
        selfHosted && host ? `Server ${host}` : null,
    ].filter(Boolean);
    return (
        <p className="mt-10 px-5 font-mono text-xs text-muted-foreground sm:px-8">
            {parts.join(' · ')}
        </p>
    );
}

/* The name, edited in place: the one profile field the server lets you change. */
function NameSetting({ name }: { name: string }) {
    const router = useRouter();
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(name);
    const [saved, setSaved] = useState(false);
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    async function save() {
        const value = draft.trim();
        if (!value) {
            setError('Enter your name.');
            return;
        }
        if (value.length > 100) {
            setError('Use no more than 100 characters.');
            return;
        }
        setPending(true);
        setError('');
        try {
            await authClient.updateProfile(value);
            cue('success');
            // The name lives in the cached session; forget it so the guard refetches.
            forgetSession(router.options.context.queryClient);
            await router.invalidate();
            setEditing(false);
            setSaved(true);
        } catch (cause) {
            cue('error');
            setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <form
            noValidate
            onSubmit={(event) => {
                event.preventDefault();
                void save();
            }}
        >
            <Setting
                label={editing ? <label htmlFor="settings-name">Name</label> : 'Name'}
                action={
                    editing ? (
                        <>
                            <Button
                                type="button"
                                variant="ghost"
                                disabled={pending}
                                onClick={() => {
                                    setEditing(false);
                                    setError('');
                                }}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={pending}>
                                {pending ? 'Saving…' : 'Save name'}
                            </Button>
                        </>
                    ) : (
                        <Button
                            type="button"
                            variant="outline"
                            aria-label="Edit name"
                            onClick={() => {
                                setDraft(name);
                                setSaved(false);
                                setEditing(true);
                            }}
                        >
                            Edit
                        </Button>
                    )
                }
                below={
                    editing ? (
                        <p
                            className={`text-[13px] ${error ? 'text-destructive' : 'text-muted-foreground'}`}
                            role={error ? 'alert' : undefined}
                        >
                            {error || 'Shown to people you share with.'}
                        </p>
                    ) : (
                        saved && <Done>Name saved.</Done>
                    )
                }
            >
                {editing ? (
                    <Input
                        id="settings-name"
                        autoComplete="name"
                        maxLength={100}
                        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the field Edit just opened
                        autoFocus
                        value={draft}
                        disabled={pending}
                        aria-invalid={Boolean(error)}
                        onChange={(event) => setDraft(event.target.value)}
                        className="text-[15px]"
                    />
                ) : (
                    <span className="wrap-anywhere">{name}</span>
                )}
            </Setting>
        </form>
    );
}

/* What this browser does: how it looks, whether it makes sounds, and locking it. */
function BrowserSettings() {
    const { theme, setTheme, contrast, setContrast, isPending, error } = useTheme();
    const sounds = useSoundsEnabled();
    const restoring = useStore(authClient.store, (state) => state.restoring);
    const { user } = Route.useRouteContext();
    const unlocked = useStore(authClient.store, (state) => state.unlockedUserId) === user.id;
    return (
        <SettingsGroup title="On this browser" description="These stay on this browser only.">
            <Setting
                label="Appearance"
                below={
                    error && (
                        <p role="alert" className="text-[13px] text-destructive">
                            {error}
                        </p>
                    )
                }
            >
                <Segmented
                    label="Appearance"
                    options={themes}
                    value={theme}
                    disabled={isPending}
                    onChange={setTheme}
                />
            </Setting>
            <Setting
                label={<label htmlFor="settings-contrast">High contrast</label>}
                action={
                    <Switch
                        id="settings-contrast"
                        checked={contrast}
                        disabled={isPending}
                        onCheckedChange={setContrast}
                    />
                }
            >
                <span className="text-muted-foreground">
                    Darker text and stronger edges. It also turns on when this computer asks for
                    more contrast.
                </span>
            </Setting>
            <Setting
                label={<label htmlFor="settings-sounds">Interface sounds</label>}
                action={
                    <Switch
                        id="settings-sounds"
                        checked={sounds}
                        onCheckedChange={setSoundsEnabled}
                    />
                }
            >
                <span className="text-muted-foreground">
                    Short sounds when you copy, unlock or save something
                </span>
            </Setting>
            <Setting
                label="Lock"
                action={
                    <Button variant="outline" disabled={restoring} onClick={openDeviceDialog}>
                        {unlocked ? <LockKeyholeIcon /> : <LockKeyholeOpenIcon />}
                        {unlocked ? 'Lock on this browser' : 'Unlock on this browser'}
                    </Button>
                }
            >
                <span className="text-muted-foreground">
                    {unlocked
                        ? 'Ask for your password before showing your files here'
                        : 'Locked. Your password opens your files here again.'}
                </span>
            </Setting>
        </SettingsGroup>
    );
}

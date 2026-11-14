import { createFileRoute, getRouteApi, Link, useRouter } from '@tanstack/react-router';
import { LockKeyholeIcon, LockKeyholeOpenIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import {
    ChangePasswordDialog,
    DeleteAccountDialog,
    NewKeyDialog,
    ReplaceSharingKeysDialog,
} from '@/components/account-dialogs';
import { AccountDevices } from '@/components/account-devices';
import { AccountFamily } from '@/components/account-family';
import { AccountNotifications } from '@/components/account-notifications';
import { AccountTwoStep } from '@/components/account-two-step';
import { CopyValue } from '@/components/copy-value';
import { openDeviceDialog } from '@/components/device-control';
import { PageHeader } from '@/components/page-header';
import {
    Segmented,
    Setting,
    SettingsDisclosure,
    SettingsGroup,
    SettingsPage,
} from '@/components/settings';
import { useTheme } from '@/components/theme-provider';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { useAuthView } from '@/lib/auth-view';
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
 * password, the recovery phrase, two-step sign-in, your family (or making one), the
 * devices signed in, what this browser does, and, folded away, the heavy things:
 * replacing sharing keys, rotating the account key, the account ID, deleting the
 * account. Each of those asks once, in a dialog.
 *
 * A row is its label, what it is now, and its action: no sentence under a title, none
 * beside a switch. What an action costs is said by the dialog it opens, and the security
 * caveats are on /security. What just happened is a toast, not a line that stays.
 */

const themes = [
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
    { value: 'system', label: 'Same as this computer' },
] as const satisfies readonly { value: Theme; label: string }[];

function AccountPage() {
    const { user } = Route.useRouteContext();
    const [dialog, setDialog] = useState<
        'password' | 'recovery-key' | 'master-key' | 'identity' | 'delete' | null
    >(null);
    const close = (open: boolean) => !open && setDialog(null);
    return (
        <SettingsPage className="pb-10">
            <PageHeader title="Account" />
            <div className="flex flex-col gap-9 px-5 sm:px-8">
                <SettingsGroup title="You">
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
                    >
                        <span aria-hidden="true" className="tracking-[0.2em] text-muted-foreground">
                            ••••••••••
                        </span>
                    </Setting>
                </SettingsGroup>

                <SettingsGroup title="If you forget your password">
                    <Setting
                        label="Recovery phrase"
                        action={
                            <>
                                <Button variant="outline" onClick={() => setDialog('recovery-key')}>
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

                <AccountTwoStep user={user} />

                <AccountFamily userId={user.id} />

                <AccountDevices />

                <AccountNotifications userId={user.id} />

                <BrowserSettings />

                <SettingsDisclosure title="Advanced">
                    <>
                        <Setting
                            label="Sharing keys"
                            action={
                                <Button
                                    variant="outline"
                                    aria-label="Replace sharing keys"
                                    onClick={() => setDialog('identity')}
                                >
                                    Replace
                                </Button>
                            }
                        />
                        <Setting
                            label="Account key"
                            action={
                                <Button
                                    variant="outline"
                                    aria-label="Rotate account key"
                                    onClick={() => setDialog('master-key')}
                                >
                                    Rotate
                                </Button>
                            }
                        />
                        <Setting label="Account ID">
                            <span className="font-mono text-sm">
                                <CopyValue value={user.id} label="Account ID" />
                            </span>
                        </Setting>
                        <Setting
                            label="Delete account"
                            action={
                                <Button
                                    variant="destructive-outline"
                                    aria-label="Delete account"
                                    onClick={() => setDialog('delete')}
                                >
                                    Delete
                                </Button>
                            }
                        />
                    </>
                </SettingsDisclosure>
            </div>

            <AboutLine />

            <ChangePasswordDialog
                user={user}
                open={dialog === 'password'}
                onOpenChange={close}
                onChanged={() => toast.add({ type: 'success', title: 'Password changed' })}
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
            <ReplaceSharingKeysDialog
                userId={user.id}
                open={dialog === 'identity'}
                onOpenChange={close}
            />
            <DeleteAccountDialog open={dialog === 'delete'} onOpenChange={close} />
        </SettingsPage>
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
            toast.add({ type: 'success', title: 'Name saved' });
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
                                variant="outline"
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
                                setEditing(true);
                            }}
                        >
                            Edit
                        </Button>
                    )
                }
                below={
                    editing &&
                    error && (
                        <p
                            id="settings-name-error"
                            role="alert"
                            className="text-[13px] text-destructive"
                        >
                            {error}
                        </p>
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
                        aria-describedby={error ? 'settings-name-error' : undefined}
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

/* Whether this computer asks for more contrast (its own accessibility setting), and when that changes. */
const CONTRAST_QUERY = '(prefers-contrast: more)';
const wantsContrast = () => window.matchMedia(CONTRAST_QUERY).matches;
function watchContrast(changed: () => void) {
    const query = window.matchMedia(CONTRAST_QUERY);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
}

/* What this browser does: how it looks, whether it makes sounds, and locking it. */
function BrowserSettings() {
    const { theme, setTheme, contrast, setContrast, isPending, error } = useTheme();
    const sounds = useSoundsEnabled();
    const forced = useSyncExternalStore(watchContrast, wantsContrast, () => false);
    const restoring = useAuthView((state) => state.restoring);
    const { user } = Route.useRouteContext();
    const unlocked = useAuthView((state) => state.unlockedUserId) === user.id;
    return (
        <SettingsGroup title="On this browser">
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
            {/*
             * Off here follows the computer, which may ask for more contrast itself. Then the
             * page is in high contrast whatever this switch was: it shows on, can't be turned
             * off from here, and says whose setting it is.
             */}
            <Setting
                label={<label htmlFor="settings-contrast">High contrast</label>}
                action={
                    <Switch
                        id="settings-contrast"
                        checked={contrast || forced}
                        disabled={isPending || (forced && !contrast)}
                        aria-describedby={
                            forced && !contrast ? 'settings-contrast-forced' : undefined
                        }
                        onCheckedChange={setContrast}
                    />
                }
            >
                {forced && !contrast && (
                    <span id="settings-contrast-forced" className="text-muted-foreground">
                        Set by this computer
                    </span>
                )}
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
            />
            <Setting
                label="Your files"
                action={
                    <Button
                        variant="outline"
                        disabled={restoring}
                        aria-label={unlocked ? 'Lock on this browser' : 'Unlock on this browser'}
                        onClick={openDeviceDialog}
                    >
                        {unlocked ? <LockKeyholeIcon /> : <LockKeyholeOpenIcon />}
                        {unlocked ? 'Lock' : 'Unlock'}
                    </Button>
                }
            />
        </SettingsGroup>
    );
}

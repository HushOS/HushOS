import { useEffect, useState } from 'react';
import { Setting, SettingsGroup } from '@/components/settings';
import { Switch } from '@/components/ui/switch';
import {
    notificationSettings,
    saveNotificationSettings,
    turnOffWebPush,
    turnOnWebPush,
    webPushOn,
    webPushSupported,
} from '@/lib/web-push';

type Toggles = { shared: boolean; family: boolean };

/*
 * Account → Notifications (docs/devices-design.md 5, Settings): whether this browser gets them,
 * and the two kinds a person can turn off. Security notices always come. Hidden on a server with
 * notifications off. The browser asks its permission only from the switch, never on its own.
 */
export function AccountNotifications() {
    // undefined while loading, null on a server with notifications off.
    const [toggles, setToggles] = useState<Toggles | null | undefined>(undefined);
    const [browser, setBrowser] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let current = true;
        void notificationSettings()
            .then((settings) => current && setToggles(settings))
            .catch(() => {
                if (!current) return;
                // Shown with the defaults, so the section never vanishes on a passing error.
                setToggles({ shared: true, family: true });
                setError('Your notification settings couldn’t be read. Please reload the page.');
            });
        void webPushOn()
            .then((on) => current && setBrowser(on))
            .catch(() => {});
        return () => {
            current = false;
        };
    }, []);

    if (!toggles) return null;

    async function setBrowserOn(on: boolean) {
        setBusy(true);
        setError(null);
        try {
            await (on ? turnOnWebPush() : turnOffWebPush());
            setBrowser(on);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Please try again.');
        } finally {
            setBusy(false);
        }
    }

    async function setToggle(key: keyof Toggles, on: boolean) {
        const before = toggles!;
        setToggles({ ...before, [key]: on });
        setError(null);
        try {
            setToggles(await saveNotificationSettings({ ...before, [key]: on }));
        } catch {
            setToggles(before);
            setError('Your notification settings weren’t saved. Please try again.');
        }
    }

    return (
        <SettingsGroup
            title="Notifications"
            description="New sign-ins and removed devices always come. Pushes never say what happened; this browser reads that from HushOS."
        >
            {webPushSupported() && (
                <Setting
                    label={<label htmlFor="notifications-browser">On this browser</label>}
                    action={
                        <Switch
                            id="notifications-browser"
                            checked={browser}
                            disabled={busy}
                            onCheckedChange={(on) => void setBrowserOn(on)}
                        />
                    }
                >
                    <span className="text-muted-foreground">
                        Notices here while HushOS is closed
                    </span>
                </Setting>
            )}
            <Setting
                label={<label htmlFor="notifications-shared">Shared with you</label>}
                action={
                    <Switch
                        id="notifications-shared"
                        checked={toggles.shared}
                        onCheckedChange={(on) => void setToggle('shared', on)}
                    />
                }
            >
                <span className="text-muted-foreground">
                    When someone shares something with you
                </span>
            </Setting>
            <Setting
                label={<label htmlFor="notifications-family">Families</label>}
                action={
                    <Switch
                        id="notifications-family"
                        checked={toggles.family}
                        onCheckedChange={(on) => void setToggle('family', on)}
                    />
                }
            >
                <span className="text-muted-foreground">
                    Invitations, and people waiting to join your family
                </span>
            </Setting>
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
        </SettingsGroup>
    );
}

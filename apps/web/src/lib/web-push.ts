import { apiClient, unwrap } from '@/lib/api-client';
import { unlockedNow } from '@/lib/auth-view';
import { readSettingsForWrite } from '@/lib/contacts';

/*
 * Web Push in this browser (docs/devices-design.md 5). The push service worker (public/push-sw.js)
 * receives only an event id; it asks an open tab, and this tab fetches the event over its session
 * and writes the words from what it can read. A locked tab says nothing more than the worker's
 * generic text.
 */

const SW_SCRIPT = '/push-sw.js';
const SW_SCOPE = '/hushos-push/';

export function webPushSupported() {
    return (
        typeof window !== 'undefined' &&
        'serviceWorker' in navigator &&
        'PushManager' in window &&
        'Notification' in window
    );
}

async function registration() {
    return navigator.serviceWorker.register(SW_SCRIPT, { scope: SW_SCOPE });
}

function keyBytes(base64url: string) {
    const text = atob(base64url.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(text, (char) => char.charCodeAt(0));
}

/* Whether this browser is subscribed now (and the person has not since blocked notifications). */
export async function webPushOn() {
    if (!webPushSupported() || Notification.permission !== 'granted') return false;
    const found = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    return Boolean(await found?.pushManager.getSubscription());
}

/*
 * Asks the browser's permission (only from a click, as browsers require), subscribes with this
 * server's key and hands the subscription to the server for this device.
 */
export async function turnOnWebPush() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted')
        throw new Error('Notifications are blocked for HushOS in this browser’s settings.');
    const { publicKey } = await unwrap(apiClient().notifications['web-push-key'].get());
    const sw = await registration();
    const existing = await sw.pushManager.getSubscription();
    const subscription =
        existing ??
        (await sw.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(publicKey),
        }));
    const json = subscription.toJSON();
    await unwrap(
        apiClient().notifications.registration.put({
            kind: 'webpush',
            subscription: {
                endpoint: subscription.endpoint,
                keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
            },
        }),
    );
}

export async function turnOffWebPush() {
    const found = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    await (await found?.pushManager.getSubscription())?.unsubscribe();
    await unwrap(apiClient().notifications.registration.delete({}));
}

type Notice = { title: string; body: string; url: string };

/* The words for an event, from what this tab can read; the sender only when checked. */
async function noticeFor(id: string): Promise<Notice | null> {
    const userId = unlockedNow();
    if (!userId) return null;
    const { notification } = await unwrap(apiClient().notifications({ id }).get());
    switch (notification.kind) {
        case 'new-device':
            return {
                title: 'New sign-in',
                body: 'A new device signed in to your account.',
                url: '/app/account#devices',
            };
        case 'device-removed':
            return {
                title: 'Device removed',
                body: 'A device was removed from your account.',
                url: '/app/account#devices',
            };
        case 'devices-removed':
            return {
                title: 'Devices removed',
                body: `${notification.data.count} devices were removed from your account.`,
                url: '/app/account#devices',
            };
        case 'password-attempts':
            return {
                title: 'Password attempts',
                body: 'Someone kept trying to confirm your password.',
                url: '/app/account#devices',
            };
        case 'shared': {
            // Named from this person's own contacts: a stranger's choice of words never shows.
            const { settings } = await readSettingsForWrite(userId);
            const pin = settings.contacts[notification.data.granterUserId];
            return {
                title: 'Shared with you',
                body: pin
                    ? `${pin.name} shared something with you.`
                    : 'Someone you haven’t checked shared something with you.',
                url: '/app/shared',
            };
        }
        case 'family-invitation':
            return {
                title: 'Family invitation',
                body: 'You’re invited to join a family.',
                url: '/app/family',
            };
        case 'family-waiting':
            return {
                title: 'Family',
                body: 'Someone is waiting to join your family.',
                url: '/app/family',
            };
    }
}

let listening = false;
/* Answers the push worker's questions from this tab, once per page. */
export function answerPushes() {
    if (listening || !webPushSupported()) return;
    listening = true;
    navigator.serviceWorker.addEventListener('message', (event) => {
        const data = event.data as { type?: string; id?: string } | null;
        const port = event.ports[0];
        if (data?.type !== 'push-notice' || typeof data.id !== 'string' || !port) return;
        void noticeFor(data.id)
            .catch(() => null)
            .then((notice) => port.postMessage(notice));
    });
}

/* The notification settings, or null when this server has notifications off. */
export async function notificationSettings() {
    const { data, error } = await apiClient().notifications.settings.get();
    if (error) {
        const code = (error.value as { code?: string } | undefined)?.code;
        if (code === 'off') return null;
        throw new Error('Notification settings could not be read.');
    }
    return data.settings;
}

export async function saveNotificationSettings(settings: { shared: boolean; family: boolean }) {
    return (await unwrap(apiClient().notifications.settings.put(settings))).settings;
}

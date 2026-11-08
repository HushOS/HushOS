import { apiClient, unwrap } from '@/lib/api-client';
import { unlockedNow } from '@/lib/auth-view';
import { pinTrust } from '@hushos/crypto/pins';
import { readSettingsForWrite } from '@/lib/contacts';
import { pinOf } from '@/lib/family-pin';

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

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array) {
    if (!a || a.byteLength !== b.length) return false;
    const view = new Uint8Array(a);
    return view.every((byte, at) => byte === b[at]);
}

/*
 * This browser's subscription, made with this server's current key: one made with an older key
 * would be refused by the push service on every send, so it is replaced.
 */
async function currentSubscription(sw: ServiceWorkerRegistration) {
    const { publicKey } = await unwrap(apiClient().notifications['web-push-key'].get());
    const key = keyBytes(publicKey);
    const existing = await sw.pushManager.getSubscription();
    if (existing && sameBytes(existing.options.applicationServerKey, key)) return existing;
    await existing?.unsubscribe();
    return sw.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
}

async function register(subscription: PushSubscription) {
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

/*
 * Asks the browser's permission (only from a click, as browsers require), subscribes with this
 * server's key and hands the subscription to the server for this device. When the server does
 * not take it, the subscription goes too, so the switch never reads on with nothing behind it.
 */
export async function turnOnWebPush() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted')
        throw new Error('Notifications are blocked for HushOS in this browser’s settings.');
    const subscription = await currentSubscription(await registration());
    try {
        await register(subscription);
    } catch (error) {
        await subscription.unsubscribe().catch(() => {});
        throw error;
    }
}

/*
 * Hands the server this browser's subscription again, renewed if the push service or the server's
 * key changed it: on every app start and when the worker says the subscription changed. The
 * server drops a subscription its push service calls gone, so without this one rotation would
 * end notifications here while the switch still read on. Quiet: nothing to do when it is off.
 */
async function refreshWebPush() {
    if (!webPushSupported() || Notification.permission !== 'granted') return;
    const found = await navigator.serviceWorker.getRegistration(SW_SCOPE);
    if (!found || !(await found.pushManager.getSubscription())) return;
    await register(await currentSubscription(found));
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
            // Named only from a contact this person checked themselves. A first-seen pin's
            // name is whatever the sharer called themselves, so a stranger's words never show.
            const { settings } = await readSettingsForWrite(userId);
            const pinned = pinOf(settings.contacts, notification.data.granterUserId);
            const checked =
                pinned !== null &&
                !pinned.pin.trustedVia &&
                (await pinTrust(pinned.pin)) === 'verified';
            return {
                title: 'Shared with you',
                body: checked
                    ? `${pinned.pin.name} shared something with you.`
                    : 'Someone shared something with you.',
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
/*
 * Answers the push worker from this tab, once per page: the words for a push, opening what a
 * tapped notice is about (through `open`, the app's router), and renewing the subscription.
 */
export function answerPushes(open: (url: string) => void) {
    if (listening || !webPushSupported()) return;
    listening = true;
    navigator.serviceWorker.addEventListener('message', (event) => {
        // Only this origin's own worker; a page cannot post here as it.
        if (event.origin && event.origin !== window.location.origin) return;
        const data = event.data as { type?: string; id?: string; url?: string } | null;
        if (data?.type === 'push-open') {
            if (typeof data.url === 'string' && data.url.startsWith('/app')) open(data.url);
            return;
        }
        if (data?.type === 'push-resubscribe') {
            void refreshWebPush().catch(() => {});
            return;
        }
        const port = event.ports[0];
        if (data?.type !== 'push-notice' || typeof data.id !== 'string' || !port) return;
        void noticeFor(data.id)
            .catch(() => null)
            .then((notice) => port.postMessage(notice));
    });
    void refreshWebPush().catch(() => {});
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

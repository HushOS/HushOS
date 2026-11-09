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

/*
 * Set when this account turned Web Push on in this browser, `hushos.web-push:<userId>`, and
 * wiped with the rest of the account's data at sign-out (lib/device-data.ts). Only then does an
 * app start renew the subscription: a subscription left behind never enrols another account.
 */
export const WEB_PUSH_PREFIX = 'hushos.web-push:';

function wanted(userId: string) {
    try {
        return localStorage.getItem(WEB_PUSH_PREFIX + userId) === 'on';
    } catch {
        return false;
    }
}

/* Sent on this page whenever this browser's notifications are turned on or off, so the offer to turn them on can go. */
export const WEB_PUSH_CHANGED = 'web-push-changed';

function setWanted(userId: string, on: boolean) {
    // Turned on or off here, from the offer or Account's switch: the person decided, so the offer goes.
    dismissWebPushAsk(userId);
    try {
        if (on) localStorage.setItem(WEB_PUSH_PREFIX + userId, 'on');
        else localStorage.removeItem(WEB_PUSH_PREFIX + userId);
    } catch {
        // Storage refused: the switch still works for this page; it is not renewed later.
    }
    window.dispatchEvent(new Event(WEB_PUSH_CHANGED));
}

/*
 * Set when this account closed the app's offer to turn notifications on in this browser, or the
 * offer's Turn on failed (a browser with no push service): `hushos.web-push-ask:<userId>`, wiped
 * with the account's data at sign-out (lib/device-data.ts). The offer is then never made again.
 */
export const WEB_PUSH_ASK_PREFIX = 'hushos.web-push-ask:';

export function webPushAskDismissed(userId: string) {
    try {
        return localStorage.getItem(WEB_PUSH_ASK_PREFIX + userId) === 'dismissed';
    } catch {
        // Storage refused: never offered, rather than offered on every page.
        return true;
    }
}

export function dismissWebPushAsk(userId: string) {
    try {
        localStorage.setItem(WEB_PUSH_ASK_PREFIX + userId, 'dismissed');
    } catch {
        // Storage refused: the offer goes for this page; webPushAskDismissed then says it is.
    }
}

/*
 * Whether to offer turning notifications on in this browser: a browser that can, whose permission
 * isn't blocked, not subscribed for this account, on a server with notifications on, and an
 * offer this account hasn't closed here. Browsers penalise permission prompts no click asked for,
 * so the offer is a line with a button (components/notifications-ask.tsx), never the prompt itself.
 */
export async function shouldOfferWebPush(userId: string) {
    // Allowed already (for another account, or before a sign-out) is offered too: the offer only turns on from a click.
    if (!webPushSupported() || Notification.permission === 'denied') return false;
    if (webPushAskDismissed(userId)) return false;
    if (await webPushOn(userId)) return false;
    return (await notificationSettings()) !== null;
}

/* Whether this account has notifications on in this browser, and the browser still allows them. */
export async function webPushOn(userId: string) {
    if (!webPushSupported() || Notification.permission !== 'granted' || !wanted(userId))
        return false;
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
    // Kept when its key is this one, or cannot be read: replacing it on every start would fail
    // where a browser allows subscribing only from a click.
    const held = existing?.options?.applicationServerKey;
    if (existing && (!held || sameBytes(held, key))) return existing;
    await existing?.unsubscribe();
    try {
        return await sw.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    } catch (error) {
        // The browser's push service refused or doesn't exist (Chromium says "Registration failed -
        // push service error"; browsers built without Google's services have none): say so plainly.
        if (error instanceof DOMException && error.name === 'AbortError')
            throw new Error(
                'This browser has no push service, so it can’t show notifications while HushOS is closed.',
            );
        throw error;
    }
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
export async function turnOnWebPush(userId: string) {
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
    setWanted(userId, true);
}

/*
 * Hands the server this browser's subscription again, renewed if the push service or the server's
 * key changed it: on every app start and when the worker says the subscription changed. The
 * server drops a subscription its push service calls gone, so without this one rotation would
 * end notifications here while the switch still read on. Only for an account that turned them on
 * here; a subscription the push service ended without a new one is made again.
 */
async function refreshWebPush(userId: string) {
    if (!webPushSupported() || Notification.permission !== 'granted' || !wanted(userId)) return;
    await register(await currentSubscription(await registration()));
}

export async function turnOffWebPush(userId: string) {
    setWanted(userId, false);
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
                body:
                    notification.data.count === 1
                        ? '1 device was removed from your account.'
                        : `${notification.data.count} devices were removed from your account.`,
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

/* The account this page answers for, and its router; the listener reads them when a message comes. */
let answering: { userId: string; open: (url: string) => void } | null = null;
/*
 * Answers the push worker from this tab: the words for a push, opening what a tapped notice is
 * about (through `open`, the app's router), and renewing the subscription. The listener is added
 * once per page; a later call only changes whom it answers for.
 */
export function answerPushes(userId: string, open: (url: string) => void) {
    if (!webPushSupported()) return;
    const first = answering === null;
    answering = { userId, open };
    void refreshWebPush(userId).catch(() => {});
    if (!first) return;
    navigator.serviceWorker.addEventListener('message', (event) => {
        const now = answering;
        if (!now) return;
        const data = event.data as { type?: string; id?: string; url?: string } | null;
        if (data?.type === 'push-open') {
            if (typeof data.url === 'string' && data.url.startsWith('/app')) now.open(data.url);
            return;
        }
        if (data?.type === 'push-resubscribe') {
            void refreshWebPush(now.userId).catch(() => {});
            return;
        }
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

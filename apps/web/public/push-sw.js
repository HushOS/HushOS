/*
 * HushOS push service worker (docs/devices-design.md 5). A push carries one thing: the id of an
 * event, encrypted to this browser. This worker never opens the account key and never fetches the
 * event itself: it asks an open HushOS tab, which fetches the event over its session and writes
 * the words from what it can decrypt. With no tab, or a locked one, it shows the generic text.
 *
 * Every push shows a notification, the generic one included, so a server that pings this browser
 * without reason is seen (docs/devices-design.md 7).
 *
 * Scope is /hushos-push/ only: nothing the app loads passes through here. Plain JavaScript on
 * purpose: served as a static file at its own URL so the browser can register it.
 */

const GENERIC = { title: 'HushOS', body: 'New activity in HushOS', url: '/app' };
const ASK_MS = 3000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

/* An open tab's words for the event, or nothing within ASK_MS. */
async function askTab(id) {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tabs = windows.filter((client) => new URL(client.url).origin === self.location.origin);
    if (!tabs.length) return null;
    // The first tab that can say more than the generic text wins at once. Only app tabs answer,
    // so a public page or sign-in tab costs the wait only when no tab has words.
    return new Promise((resolve) => {
        let waiting = tabs.length;
        const timer = setTimeout(() => resolve(null), ASK_MS);
        const settle = (answer) => {
            waiting -= 1;
            if (answer && answer.title) {
                clearTimeout(timer);
                resolve(answer);
            } else if (waiting === 0) {
                clearTimeout(timer);
                resolve(null);
            }
        };
        for (const tab of tabs) {
            const channel = new MessageChannel();
            channel.port1.onmessage = (event) => settle(event.data || null);
            tab.postMessage({ type: 'push-notice', id }, [channel.port2]);
        }
    });
}

function isEventId(value) {
    return (
        typeof value === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    );
}

self.addEventListener('push', (event) => {
    event.waitUntil(
        (async () => {
            let id = null;
            try {
                id = event.data ? event.data.json().id : null;
            } catch {
                id = null;
            }
            const said = isEventId(id) ? await askTab(id) : null;
            const shown = {
                title: typeof said?.title === 'string' ? said.title.slice(0, 120) : GENERIC.title,
                body: typeof said?.body === 'string' ? said.body.slice(0, 240) : GENERIC.body,
                url:
                    typeof said?.url === 'string' && said.url.startsWith('/app')
                        ? said.url
                        : GENERIC.url,
            };
            await self.registration.showNotification(shown.title, {
                body: shown.body,
                tag: isEventId(id) ? id : undefined,
                icon: '/android-chrome-192x192.png',
                data: { url: shown.url },
            });
        })(),
    );
});

/*
 * The push service replaced or ended this browser's subscription, and the server's copy is now
 * dead. Where the browser made no new one (Firefox, on expiry), subscribe again with the same
 * server key; then an open app tab hands it over, as every app start does too.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil(
        (async () => {
            const key = event.oldSubscription?.options?.applicationServerKey;
            if (
                !event.newSubscription &&
                key &&
                !(await self.registration.pushManager.getSubscription())
            )
                await self.registration.pushManager
                    .subscribe({ userVisibleOnly: true, applicationServerKey: key })
                    .catch(() => {});
            const windows = await self.clients.matchAll({
                type: 'window',
                includeUncontrolled: true,
            });
            for (const client of windows)
                if (new URL(client.url).origin === self.location.origin)
                    client.postMessage({ type: 'push-resubscribe' });
        })(),
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || GENERIC.url;
    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({
                type: 'window',
                includeUncontrolled: true,
            });
            // This worker controls no page (its scope is /hushos-push/), so it cannot navigate a
            // tab itself: an app tab moves through its own router; otherwise a new window opens.
            const open = windows.find(
                (client) =>
                    new URL(client.url).origin === self.location.origin &&
                    new URL(client.url).pathname.startsWith('/app'),
            );
            if (open) {
                await open.focus();
                open.postMessage({ type: 'push-open', url });
                return;
            }
            await self.clients.openWindow(url);
        })(),
    );
});

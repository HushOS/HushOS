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
    const answers = tabs.map(
        (tab) =>
            new Promise((resolve) => {
                const channel = new MessageChannel();
                channel.port1.onmessage = (event) => resolve(event.data || null);
                tab.postMessage({ type: 'push-notice', id }, [channel.port2]);
            }),
    );
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), ASK_MS));
    // The first tab that can say more than the generic text wins.
    const said = await Promise.race([
        Promise.all(answers).then((all) => all.find((answer) => answer && answer.title) || null),
        timeout,
    ]);
    return said;
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

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || GENERIC.url;
    event.waitUntil(
        (async () => {
            const windows = await self.clients.matchAll({
                type: 'window',
                includeUncontrolled: true,
            });
            const open = windows.find(
                (client) => new URL(client.url).origin === self.location.origin,
            );
            if (open) {
                await open.focus();
                if ('navigate' in open) await open.navigate(url).catch(() => {});
                return;
            }
            await self.clients.openWindow(url);
        })(),
    );
});

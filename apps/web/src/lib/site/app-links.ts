import { redirect } from '@tanstack/react-router';
import { createIsomorphicFn } from '@tanstack/react-start';
import { useRequest } from 'nitro/context';

const readAgent = createIsomorphicFn()
    .server(() => useRequest().headers.get('user-agent') ?? '')
    .client(() => navigator.userAgent);

/*
 * What fetches a link to draw its preview, or to index it: WhatsApp (and Signal, which borrows
 * its name), iMessage (as facebookexternalhit and Twitterbot), Slack, Telegram, Discord, X,
 * LinkedIn, Mastodon, Bluesky, search crawlers. None of them is a person on their way to a
 * store, and each reads the page's card. A preview fetcher missed here follows the redirect
 * and shows the store's card instead: the store's, not a broken one.
 */
const PREVIEWS =
    /bot|crawler|spider|preview|facebookexternalhit|facebot|whatsapp|telegram|slack|discord|linkedin|skype|embedly|iframely|pinterest|mastodon|bluesky|cardyb|vkshare|snapchat|google-pagerenderer|applebot|headless/i;

/*
 * /ios and /android: a person goes straight to the store, from the server, before any page is
 * drawn; a link preview, or a request with no user agent, gets the page and its card.
 */
export function appStoreRedirect(url: string) {
    const agent = readAgent();
    if (!agent || PREVIEWS.test(agent)) return;
    // On the redirect itself: Start answers it before the route's own headers run.
    throw redirect({
        href: url,
        statusCode: 302,
        headers: { 'Cache-Control': 'private, no-store', Vary: 'User-Agent' },
    });
}

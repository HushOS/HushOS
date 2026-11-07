import { createFileRoute, notFound } from '@tanstack/react-router';
import { AppLinksPage } from '@/components/app-links-page';
import { appStoreRedirect } from '@/lib/app-links';
import { cardMeta, publicOrigin } from '@/lib/social';

/* The share link for the Android app: a person goes straight to Google Play (appStoreRedirect), a link preview gets this page and its card. Only where this server names the listing. */
export const Route = createFileRoute('/android')({
    beforeLoad: ({ context }) => {
        if (!context.playStoreUrl) throw notFound();
        appStoreRedirect(context.playStoreUrl);
    },
    // Who asked decides the answer (a person is redirected, a preview is not), so nothing keeps it.
    headers: () => ({ 'Cache-Control': 'private, no-store', Vary: 'User-Agent' }),
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: [
            { title: 'HushOS for Android' },
            {
                name: 'description',
                content:
                    'On Google Play. Your files, folders and family, locked on your phone before they upload.',
            },
            // A share link, not a page to find: the post says it all for search.
            { name: 'robots', content: 'noindex' },
            ...(loaderData
                ? cardMeta({
                      origin: loaderData.origin,
                      card: 'android',
                      title: 'HushOS for Android',
                      description:
                          'On Google Play. Your files, folders and family, locked on your phone before they upload.',
                  })
                : []),
        ],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/android` }] : [],
    }),
    component: () => <AppLinksPage only={'play'} />,
});

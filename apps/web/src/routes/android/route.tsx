import { createFileRoute, notFound } from '@tanstack/react-router';
import { AppLinksPage } from '@/components/app-links-page';
import { cardMeta, publicOrigin } from '@/lib/social';

/* The share link for the Android app (AppLinksPage): our card, then on to Google Play. Only where this server names the listing. */
export const Route = createFileRoute('/android')({
    beforeLoad: ({ context }) => {
        if (!context.playStoreUrl) throw notFound();
    },
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

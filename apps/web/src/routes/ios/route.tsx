import { createFileRoute, notFound } from '@tanstack/react-router';
import { AppLinksPage } from '@/components/app-links-page';
import { cardMeta, publicOrigin } from '@/lib/social';

/* The share link for the iPhone app (AppLinksPage): our card, then on to the App Store. Only where this server names the listing. */
export const Route = createFileRoute('/ios')({
    beforeLoad: ({ context }) => {
        if (!context.appStoreUrl) throw notFound();
    },
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: [
            { title: 'HushOS for iPhone' },
            {
                name: 'description',
                content:
                    'On the App Store. Your files, folders and family, locked on your iPhone before they upload.',
            },
            // A share link, not a page to find: the post says it all for search.
            { name: 'robots', content: 'noindex' },
            ...(loaderData
                ? cardMeta({
                      origin: loaderData.origin,
                      card: 'ios',
                      title: 'HushOS for iPhone',
                      description:
                          'On the App Store. Your files, folders and family, locked on your iPhone before they upload.',
                  })
                : []),
        ],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/ios` }] : [],
    }),
    component: () => <AppLinksPage only={'appStore'} />,
});

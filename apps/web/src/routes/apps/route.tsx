import { createFileRoute, notFound } from '@tanstack/react-router';
import { AppLinksPage } from '@/components/app-links-page';
import { cardMeta, publicOrigin } from '@/lib/social';

/* The share link for both phone apps (AppLinksPage): a phone goes on to its own store, a computer sees both badges. Only where this server names a listing. */
export const Route = createFileRoute('/apps')({
    beforeLoad: ({ context }) => {
        if (!context.appStoreUrl && !context.playStoreUrl) throw notFound();
    },
    loader: () => ({ origin: publicOrigin() }),
    head: ({ loaderData }) => ({
        meta: [
            { title: 'HushOS on your phone' },
            {
                name: 'description',
                content:
                    'For iPhone and Android. Your files, folders and family, locked on your phone before they upload.',
            },
            // A share link, not a page to find: the post says it all for search.
            { name: 'robots', content: 'noindex' },
            ...(loaderData
                ? cardMeta({
                      origin: loaderData.origin,
                      card: 'apps',
                      title: 'HushOS on your phone',
                      description:
                          'For iPhone and Android. Your files, folders and family, locked on your phone before they upload.',
                  })
                : []),
        ],
        links: loaderData ? [{ rel: 'canonical', href: `${loaderData.origin}/apps` }] : [],
    }),
    component: () => <AppLinksPage only={null} />,
});

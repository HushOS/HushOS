import { createFileRoute, notFound } from '@tanstack/react-router';
import { AppLinksPage } from '@/components/app-links-page';
import { appStoreRedirect } from '@/lib/app-links';
import { cardMeta, publicOrigin } from '@/lib/social';

/* The share link for the iPhone app: a person goes straight to the App Store (appStoreRedirect), a link preview gets this page and its card. Only where this server names the listing. */
export const Route = createFileRoute('/ios')({
    beforeLoad: ({ context }) => {
        if (!context.appStoreUrl) throw notFound();
        appStoreRedirect(context.appStoreUrl);
    },
    // Who asked decides the answer (a person is redirected, a preview is not), so nothing keeps it.
    headers: () => ({ 'Cache-Control': 'private, no-store', Vary: 'User-Agent' }),
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

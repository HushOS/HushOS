import { Link, useRouteContext } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Phones } from '@/components/screenshot';
import { H1, SitePage } from '@/components/site';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { StoreLinks } from '@/components/store-links';

/*
 * The share links for the phone apps: /ios and /android each send a visitor on to their store,
 * and /apps sends a phone to its own store and shows a computer both badges. They exist for
 * their card: a link straight to a store shows the store's, which messengers crop. The page is
 * HushOS's own, with our card (cardMeta), so a link preview reads it; crawlers run no script,
 * so the move to the store, made here in the browser, never reaches them. Without script the
 * page still has the badge to tap.
 */

export type AppStore = 'appStore' | 'play';

const words = {
    apps: {
        title: 'HushOS on your phone.',
        body: 'Your files, folders and family on iPhone and Android, locked on your phone before they upload.',
    },
    appStore: {
        title: 'HushOS for iPhone.',
        body: 'Your files, folders and family, locked on your iPhone before they upload. On the App Store, for iOS 26 and later.',
    },
    play: {
        title: 'HushOS for Android.',
        body: 'Your files, folders and family, locked on your phone before they upload. On Google Play, for Android 10 and later.',
    },
} as const;

/* Where this visitor should go: the page's own store, or on /apps the store for their phone. */
function destination(
    store: AppStore | null,
    urls: { appStore: string | null; play: string | null },
) {
    if (store) return urls[store];
    const agent = navigator.userAgent;
    // iPadOS reports a Mac, and the app is for iPhone: an iPad stays on the page with both badges.
    if (/iPhone|iPod/.test(agent)) return urls.appStore;
    if (/Android/.test(agent)) return urls.play;
    return null;
}

export function AppLinksPage({ only }: { only: AppStore | null }) {
    const { appStoreUrl, playStoreUrl } = useRouteContext({ from: '__root__' });
    useEffect(() => {
        const url = destination(only, { appStore: appStoreUrl, play: playStoreUrl });
        // Replaced, not pushed: Back from the store returns to where the link was tapped.
        if (url) window.location.replace(url);
    }, [only, appStoreUrl, playStoreUrl]);
    const { title, body } = words[only ?? 'apps'];
    return (
        <SitePage>
            <SiteHeader />
            <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center gap-10 px-4 py-12 text-center sm:px-8 sm:py-20">
                <div className="flex flex-col items-center gap-5">
                    <H1>{title}</H1>
                    <p className="max-w-xl text-base leading-relaxed text-pretty text-muted-foreground sm:text-lg">
                        {body}
                    </p>
                    <StoreLinks only={only ?? undefined} className="justify-center" />
                </div>
                <Phones screen="home" alt="HushOS Home: search, tags and recent files" priority />
                <Link
                    to="/blog/$slug"
                    params={{ slug: 'phone-apps' }}
                    className="inline-flex items-center gap-1.5 font-semibold text-primary hover:text-primary-hover"
                >
                    What the apps do <ArrowRightIcon aria-hidden="true" className="size-4" />
                </Link>
            </main>
            <SiteFooter />
        </SitePage>
    );
}

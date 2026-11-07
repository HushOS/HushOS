import { Link } from '@tanstack/react-router';
import { ArrowRightIcon } from 'lucide-react';
import { Phones } from '@/components/screenshot';
import { H1, SitePage } from '@/components/site';
import { SiteFooter, SiteHeader } from '@/components/site-header';
import { StoreLinks } from '@/components/store-links';

/*
 * The share links for the phone apps. /apps is a page: both badges, for the visitor to tap.
 * /ios and /android send a person straight to their store from the server (appStoreRedirect),
 * and show this page, with our card (cardMeta), only to link previews: a link straight to a
 * store shows the store's card, which messengers crop.
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

export function AppLinksPage({ only }: { only: AppStore | null }) {
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

import { useRouteContext } from '@tanstack/react-router';
import { cn } from 'cn';
import { ArrowUpRightIcon, SmartphoneIcon } from 'lucide-react';

/*
 * Where to get the phone apps: the Android app's Google Play listing, and a note that the iPhone
 * app is coming. Shown only where the server names a listing (PLAY_STORE_URL, set on hushos.com),
 * since the listings are HushOS's own; elsewhere it draws nothing.
 *
 * Google Play: Google's own "Get it on Google Play" badge, unaltered, at least 28px tall (40px
 * here), with a quarter of its height clear around it, linking to the listing
 * (partnermarketinghub.withgoogle.com, Google Play badges). Until that artwork is in the repo
 * (it has to be downloaded from Google's hub, and served locally for the CSP), the link is plain
 * words, which needs no artwork; with the badge, the public pages add Google's trademark line.
 *
 * iPhone: Apple's badge is a call to action for an app on the App Store, and its pre-order badge
 * only for an app open for pre-order (developer.apple.com/app-store/marketing/guidelines), so an
 * app that isn't listed gets neither, and no Apple logo: a quiet HushOS note with no link, never
 * taller than the Google badge beside it, as Google asks of other stores' badges.
 */
export function StoreLinks({ className }: { className?: string }) {
    const { playStoreUrl } = useRouteContext({ from: '__root__' });
    if (!playStoreUrl) return null;
    return (
        <div className={cn('flex flex-wrap items-center gap-x-5 gap-y-3', className)}>
            <a
                href={playStoreUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-1.5 rounded-md border border-input bg-card px-4 text-[15px] font-semibold text-foreground outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring dark:bg-transparent dark:hover:bg-muted pointer-coarse:h-11"
            >
                Get it on Google Play
                <ArrowUpRightIcon className="size-4 shrink-0" aria-hidden="true" />
            </a>
            <span className="inline-flex h-10 items-center gap-2 rounded-md bg-foreground/7 px-3.5 text-sm text-muted-foreground">
                <SmartphoneIcon className="size-4 shrink-0" aria-hidden="true" />
                iPhone app coming soon
            </span>
        </div>
    );
}

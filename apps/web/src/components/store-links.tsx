import { useRouteContext } from '@tanstack/react-router';
import { cn } from 'cn';
import { SmartphoneIcon } from 'lucide-react';
import playBadge from '@/badges/GetItOnGooglePlay_Badge_Web_color_English.svg?url';

/*
 * Where to get the phone apps: the Android app's Google Play listing, and a note that the iPhone
 * app is coming. Shown only where the server names a listing (PLAY_STORE_URL, set on hushos.com),
 * since the listings are HushOS's own; elsewhere it draws nothing.
 *
 * Google Play: Google's own "Get it on Google Play" badge (English, web, colour, from the Google
 * Play badge kit on partnermarketinghub.withgoogle.com), the file unaltered and served from here
 * for the CSP. Its rules: never recoloured, rearranged or rescaled inside; at least 28px tall (40px
 * here); clear space of a quarter of its height (10px) on every side, which the gaps keep; the same
 * size as or larger than another store's mark beside it; linking to the listing. The kit has one
 * web badge for light and dark grounds (black, with its own grey edge). Google's trademark line
 * goes under it wherever it shows.
 *
 * iPhone: Apple's badge is a call to action for an app on the App Store, and its pre-order badge
 * only for an app open for pre-order (developer.apple.com/app-store/marketing/guidelines), so an
 * app that isn't listed gets neither, and no Apple logo: a quiet HushOS note with no link, no
 * taller than the Google badge beside it.
 */
export function StoreLinks({ className }: { className?: string }) {
    const { playStoreUrl } = useRouteContext({ from: '__root__' });
    if (!playStoreUrl) return null;
    return (
        <div className={cn('flex flex-col gap-3', className)}>
            <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
                <a
                    href={playStoreUrl}
                    target="_blank"
                    rel="noreferrer"
                    // The badge's own corners (8.86 of its 70.87 height) for the focus outline.
                    className="block shrink-0 rounded-[5px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
                >
                    <img
                        src={playBadge}
                        alt="Get it on Google Play"
                        width={135}
                        height={40}
                        className="block h-10 w-auto"
                    />
                </a>
                <span className="inline-flex h-10 items-center gap-2 rounded-md bg-foreground/7 px-3.5 text-sm text-muted-foreground">
                    <SmartphoneIcon className="size-4 shrink-0" aria-hidden="true" />
                    iPhone app coming soon
                </span>
            </div>
            <p className="text-xs text-muted-foreground">
                Google Play and the Google Play logo are trademarks of Google LLC.
            </p>
        </div>
    );
}

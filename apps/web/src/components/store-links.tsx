import { useRouteContext } from '@tanstack/react-router';
import { cn } from 'cn';
import appStoreBadge from '@/badges/download-on-the-app-store-black-en-us.svg?url';
import playBadge from '@/badges/GetItOnGooglePlay_Badge_Web_color_English.svg?url';

/*
 * Where to get the phone apps: the stores' own badges, each the official file unaltered and served
 * from here for the CSP, both drawn at one height, BADGE_HEIGHT. Shown only where the server names
 * the Android app's listing (PLAY_STORE_URL, set on hushos.com), since the listings are HushOS's
 * own; elsewhere it draws nothing.
 *
 * Google Play (the English web badge from Google's Play badge kit): never recoloured, rearranged
 * or rescaled inside; at least 28px tall; a quarter of its height clear around it, which the gaps
 * keep; no smaller than another store's badge beside it; linking to the listing.
 *
 * App Store (Apple's black "Download on the App Store", en-US, from Apple's marketing tools): at
 * least 40px tall. The iPhone app isn't on the App Store yet, so it links nowhere and says Coming
 * soon under it, as the owner chose, knowing Apple's guidelines keep the badge for apps that are
 * available or open for pre-order. When the app is listed it becomes a link like Google's.
 */

const BADGE_HEIGHT = 40;

/* Each badge at BADGE_HEIGHT, its width from its own artwork's proportions. */
const BADGES = {
    play: { src: playBadge, width: Math.round((BADGE_HEIGHT * 238.96) / 70.87) },
    appStore: { src: appStoreBadge, width: Math.round((BADGE_HEIGHT * 119.66407) / 40) },
} as const;

function Badge({ badge, alt }: { badge: keyof typeof BADGES; alt: string }) {
    return (
        <img
            src={BADGES[badge].src}
            alt={alt}
            width={BADGES[badge].width}
            height={BADGE_HEIGHT}
            className="block h-10 w-auto"
        />
    );
}

export function StoreLinks({ className }: { className?: string }) {
    const { playStoreUrl } = useRouteContext({ from: '__root__' });
    if (!playStoreUrl) return null;
    return (
        <div className={cn('flex flex-wrap items-start gap-x-5 gap-y-3', className)}>
            <a
                href={playStoreUrl}
                target="_blank"
                rel="noreferrer"
                // The badge's own corners (8.86 of its 70.87 height) for the focus outline.
                className="block shrink-0 rounded-[5px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
            >
                <Badge badge="play" alt="Get it on Google Play" />
            </a>
            {/* Not a link yet, so not focusable: the badge and its note, read as one. */}
            <span className="flex shrink-0 flex-col items-center gap-1.5">
                <Badge badge="appStore" alt="Download on the App Store, coming soon" />
                <span aria-hidden="true" className="text-xs text-muted-foreground">
                    Coming soon
                </span>
            </span>
        </div>
    );
}

import { useRouteContext } from '@tanstack/react-router';
import { cn } from 'cn';
import type { CSSProperties, ReactNode } from 'react';
import appStoreBadge from '@/badges/download-on-the-app-store-black-en-us.svg?url';
import playBadge from '@/badges/GetItOnGooglePlay_Badge_Web_color_English.svg?url';

/*
 * Where to get the phone apps: the stores' own badges, each the official file byte for byte and
 * served from here for the CSP. Shown only where the server names the Android app's listing
 * (PLAY_STORE_URL, set on hushos.com), since the listings are HushOS's own; elsewhere it draws
 * nothing.
 *
 * Both sit in one frame, FRAME: the same width, height and corners, black like the badges, with a
 * 1px border drawn once in CSS, on whole pixels, so it stays crisp at any density. Each artwork's
 * own thin grey outline lands on fractions of a pixel at 40px and blurs, so the frame hides it:
 * Google's badge fills the frame exactly and its outline falls under the border, outside the clip;
 * Apple's is narrower, centred, and its outline is covered by a ring of the frame's black (a
 * clip-path left a faint grey seam where Chrome resamples the artwork). The files are untouched;
 * only layout does this.
 *
 * Google Play (the English web badge from Google's Play badge kit): never recoloured, rearranged
 * or rescaled inside; at least 28px tall; clear space round it; no smaller than another store's
 * badge beside it; linking to the listing.
 *
 * App Store (Apple's black "Download on the App Store", en-US): at least 40px tall. The iPhone app
 * isn't on the App Store yet, so it links nowhere and wears a Coming soon sticker at the frame's
 * corner, as the owner chose, knowing Apple's guidelines keep the badge for apps that are
 * available or open for pre-order. When the app is listed it becomes a link like Google's.
 */

/* The frame both badges share: Google's badge at 40px tall is 135px wide, the wider of the two. */
const FRAME = { width: 135, height: 40, radius: 8 };

/*
 * Each artwork's size in the frame, and where it sits: Google's at the frame's own size, so its
 * outline lies under the border; Apple's at its own 119.66 × 40, centred on a whole pixel, its
 * outline (0.875 of its 40 units, with corners of about 9.5) covered.
 */
const ART = {
    play: { src: playBadge, width: FRAME.width, left: 0, cover: false },
    appStore: {
        src: appStoreBadge,
        width: 119.66407,
        left: Math.round((FRAME.width - 119.66407) / 2),
        cover: true,
    },
} as const;

function Frame({
    art,
    alt,
    children,
}: {
    art: keyof typeof ART;
    alt: string;
    children?: ReactNode;
}) {
    const { src, width, left, cover } = ART[art];
    // Where the artwork sits, from the frame's outer edge (the border is 1px), on whole pixels.
    const place = { top: -1, left: left - 1, width, height: FRAME.height };
    return (
        <span
            className="relative block shrink-0 overflow-hidden border border-field bg-black"
            style={{ width: FRAME.width, height: FRAME.height, borderRadius: FRAME.radius }}
        >
            <img
                src={src}
                alt={alt}
                width={Math.round(width)}
                height={FRAME.height}
                className="absolute block max-w-none"
                style={place}
            />
            {cover && (
                // The artwork's own outline, covered in the frame's black, inside and just outside
                // its edge, so neither it nor its antialiasing shows; its black interior meets this
                // black without a seam.
                <span
                    aria-hidden="true"
                    className="absolute"
                    style={
                        {
                            ...place,
                            borderRadius: 10,
                            boxShadow: 'inset 0 0 0 3px #000, 0 0 0 2px #000',
                        } as CSSProperties
                    }
                />
            )}
            {children}
        </span>
    );
}

export function StoreLinks({ className }: { className?: string }) {
    const { playStoreUrl } = useRouteContext({ from: '__root__' });
    if (!playStoreUrl) return null;
    return (
        <div className={cn('flex flex-wrap items-start gap-2', className)}>
            <a
                href={playStoreUrl}
                target="_blank"
                rel="noreferrer"
                className="block shrink-0 rounded-[8px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid focus-visible:outline-ring"
            >
                <Frame art="play" alt="Get it on Google Play" />
            </a>
            {/*
             * Not a link yet, so not focusable: the badge, read with its sticker as one name. The
             * sticker is the small badge style, tilted, pinned to the frame's top right corner over
             * the frame's own black and border only (Apple's artwork ends 7px in from that edge),
             * and adds no height to the row; the right margin keeps room for it.
             */}
            <span className="relative mr-16 shrink-0">
                <Frame art="appStore" alt="Download on the App Store, coming soon" />
                <span
                    aria-hidden="true"
                    className="absolute -top-2.5 left-32 inline-flex h-5 origin-bottom-left -rotate-8 items-center rounded-full bg-tint px-1.5 text-[11px] leading-none font-semibold whitespace-nowrap text-on-tint hc:border hc:border-edge"
                >
                    Coming soon
                </span>
            </span>
        </div>
    );
}

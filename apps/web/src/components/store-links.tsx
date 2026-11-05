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
 * Apple's is narrower, set by its drawing (ART), and its outline is covered by a ring of the frame's black (a
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
 * Each artwork's size and place in the frame, balanced by its own drawing (measured from the
 * files, in their own units): the wordmarks share one cap height and one baseline, and the icons
 * one left inset.
 *
 * Google's badge (238.96 × 70.87 units) fills the frame, so its outline lies under the border: its
 * capital P is 22.15 units tall, its baseline at 53.15, its Play icon's left edge at 17.54.
 * Apple's (119.66 × 40) is scaled so its capital A (12.418 units, baseline at 30.496) matches
 * Google's cap height, then placed so its apple (left edge at 10.0) starts where the Play icon
 * does and the two wordmarks sit on one baseline; its spare width goes on the right. Its outline
 * (0.875 units, corners of about 9.5) is covered by a ring of the frame's black. The icons can't
 * match exactly as well: at one cap height, Apple's logo is drawn smaller than Google's icon.
 */
const PLAY_SCALE = FRAME.height / 70.87;
const CAP = 22.15 * PLAY_SCALE;
const BASELINE = 53.15 * PLAY_SCALE;
const ICON_LEFT = 17.54 * PLAY_SCALE;
const APPLE_SCALE = CAP / 12.418;

const ART = {
    play: {
        src: playBadge,
        width: 238.96 * PLAY_SCALE,
        height: FRAME.height,
        left: 0,
        top: 0,
        cover: false,
    },
    appStore: {
        src: appStoreBadge,
        width: 119.66407 * APPLE_SCALE,
        height: 40 * APPLE_SCALE,
        // On whole pixels, so the artwork isn't resampled: within a third of a pixel of the inset
        // and the baseline.
        left: Math.round(ICON_LEFT - 10.0 * APPLE_SCALE),
        top: Math.round(BASELINE - 30.496 * APPLE_SCALE),
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
    const { src, width, height, left, top, cover } = ART[art];
    // Where the artwork sits, measured from the frame's outer edge (the border is 1px).
    const place = { top: top - 1, left: left - 1, width, height };
    return (
        <span
            className="relative block shrink-0 overflow-hidden border border-field bg-black"
            style={{ width: FRAME.width, height: FRAME.height, borderRadius: FRAME.radius }}
        >
            <img
                src={src}
                alt={alt}
                width={Math.round(width)}
                height={Math.round(height)}
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
                            borderRadius: 10 * APPLE_SCALE,
                            // One shape from 4px inside the edge to 3px outside it: two shapes
                            // meeting on the edge each antialias it, and the grey shows between.
                            outline: '7px solid #000',
                            outlineOffset: -4,
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
             * sticker is the small badge style, tilted clockwise (falling to the right), stuck on the
             * frame's top right corner: its centre a little inside the corner and above the frame's
             * top, so most of it lies over the frame's border and the spare black at the right,
             * clear of Apple's words and logo ("Download on the" ends about 106px in, below 7px
             * down). It adds no height to the row; the right margin keeps room for what overhangs.
             */}
            <span className="relative mr-8 shrink-0">
                <Frame art="appStore" alt="Download on the App Store, coming soon" />
                <span
                    aria-hidden="true"
                    className="absolute -top-[5px] left-[126px] inline-flex h-5 origin-center -translate-x-1/2 -translate-y-1/2 rotate-8 items-center rounded-full bg-tint px-1.5 text-[11px] leading-none font-semibold whitespace-nowrap text-on-tint hc:border hc:border-edge"
                >
                    Coming soon
                </span>
            </span>
        </div>
    );
}

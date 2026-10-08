import { useTheme } from '@/components/theme-provider';
/*
 * A screenshot of the app, as a picture and nothing else: no hover, no link,
 * framed as a sheet lying on the desk so it reads as an illustration rather
 * than a control. Every screenshot exists in a light and a dark version and at
 * three scales (see e2e/screenshots.spec.ts); the theme picks the version and
 * the browser picks the scale from `sizes`. The files are imported so the
 * build hashes their names and they cache for a year.
 */
const files = import.meta.glob('../screenshots/*.png', {
    eager: true,
    query: '?url',
    import: 'default',
}) as Record<string, string>;

function url(name: string) {
    const found = files[`../screenshots/${name}.png`];
    if (!found) throw new Error(`No screenshot named ${name}.`);
    return found;
}

/* The reading column: the default for a picture inside a page of text. */
const READING_COLUMN = '(min-width: 48rem) 42rem, 100vw';

export function Shot({
    name,
    alt,
    width,
    height,
    sizes = READING_COLUMN,
    className = 'block',
    imageClassName = 'h-auto w-full',
    priority = false,
}: {
    /* The file stem under src/screenshots, without the -dark suffix, scale or extension. */
    name: string;
    alt: string;
    /* The 2x picture's pixel size; the 1.5x and 1x variants follow from it. */
    width: number;
    height: number;
    /* How wide the picture displays, as an img `sizes` value. */
    sizes?: string;
    /* The wrapper's layout; block by default. */
    className?: string;
    /* How the picture fills the wrapper; full width by default. */
    imageClassName?: string;
    /* The page's main picture, near the top: fetched at once and first, not when scrolled near. */
    priority?: boolean;
}) {
    // The hairline is a ring, not a border: a border is part of the box, and would cost a tall
    // picture more height than a wide one where two stand side by side at matched heights.
    const image = `block rounded-xs shadow-sheet ring-1 ring-rule ${imageClassName}`;
    const { theme } = useTheme();
    const srcSet = (variant: string) =>
        `${url(`${variant}@1x`)} ${Math.round(width / 2)}w, ${url(`${variant}@1.5x`)} ${Math.round((width * 3) / 4)}w, ${url(variant)} ${width}w`;
    const picture = (variant: string, extra: string) => (
        <img
            src={url(variant)}
            srcSet={srcSet(variant)}
            sizes={sizes}
            width={width}
            height={height}
            alt={alt}
            loading={priority ? 'eager' : 'lazy'}
            fetchPriority={priority ? 'high' : undefined}
            className={`${image} ${extra}`}
        />
    );
    if (!priority)
        return (
            <span className={className}>
                {picture(name, 'dark:hidden')}
                {picture(`${name}-dark`, 'hidden dark:block')}
            </span>
        );
    // Fetched at once, so only one of the two may be in the page: a hidden image loads too. A
    // chosen theme gets its own; following the computer, the browser picks by its colour scheme.
    if (theme !== 'system')
        return (
            <span className={className}>
                {picture(theme === 'dark' ? `${name}-dark` : name, '')}
            </span>
        );
    return (
        <picture className={className}>
            <source
                media="(prefers-color-scheme: dark)"
                srcSet={srcSet(`${name}-dark`)}
                sizes={sizes}
            />
            {picture(name, '')}
        </picture>
    );
}

/* The phone captures (from the apps themselves, by scripts/site-phone-shots.sh) and their 2x sizes. */
const phones = {
    ios: { width: 804, height: 1748, label: 'iPhone' },
    android: { width: 896, height: 1995, label: 'Android' },
} as const;

/*
 * The iPhone and Android apps side by side, each a real capture of the same
 * screen. `screen` names the capture (`home` or `folder`); each phone keeps its
 * own proportions and the pair lines up along the bottom.
 */
export function Phones({
    screen,
    alt,
    sizes = '12rem',
    className = 'flex items-end justify-center gap-4 sm:gap-6',
    phoneClassName = 'w-40 sm:w-48',
    priority = false,
}: {
    screen: 'home' | 'folder';
    /* What both captures show, said once; each image adds which phone it is. */
    alt: string;
    sizes?: string;
    className?: string;
    phoneClassName?: string;
    priority?: boolean;
}) {
    return (
        <span className={className}>
            {(['ios', 'android'] as const).map((platform) => (
                <Shot
                    key={platform}
                    name={`${platform}-${screen}`}
                    width={phones[platform].width}
                    height={phones[platform].height}
                    sizes={sizes}
                    alt={`${alt}, in the ${phones[platform].label} app.`}
                    priority={priority}
                    className={`block overflow-hidden rounded-[24px] border border-rule shadow-lg ${phoneClassName}`}
                />
            ))}
        </span>
    );
}

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
}) {
    // The hairline is a ring, not a border: a border is part of the box, and would cost a tall
    // picture more height than a wide one where two stand side by side at matched heights.
    const image = `block rounded-xs shadow-sheet ring-1 ring-rule ${imageClassName}`;
    const picture = (variant: string, extra: string) => (
        <img
            src={url(variant)}
            srcSet={`${url(`${variant}@1x`)} ${Math.round(width / 2)}w, ${url(`${variant}@1.5x`)} ${Math.round((width * 3) / 4)}w, ${url(variant)} ${width}w`}
            sizes={sizes}
            width={width}
            height={height}
            alt={alt}
            loading="lazy"
            className={`${image} ${extra}`}
        />
    );
    return (
        <span className={className}>
            {picture(name, 'dark:hidden')}
            {picture(`${name}-dark`, 'hidden dark:block')}
        </span>
    );
}

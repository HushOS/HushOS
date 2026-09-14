/*
 * A screenshot of the app, as a picture and nothing else: no hover, no link,
 * on a muted ground with a hard shadow so it reads as an illustration rather
 * than a control. Every screenshot exists in a light and a dark version (see
 * e2e/screenshots.spec.ts); the one matching the page's theme is shown.
 */
export function Shot({
    name,
    alt,
    width,
    height,
    className = 'block',
    imageClassName = 'h-auto w-full',
}: {
    /* The file stem under /screenshots, without the -dark suffix or extension. */
    name: string;
    alt: string;
    width: number;
    height: number;
    /* The wrapper's layout; block by default. */
    className?: string;
    /* How the picture fills the wrapper; full width by default. */
    imageClassName?: string;
}) {
    const image = `block border shadow-hard ${imageClassName}`;
    return (
        <span className={className}>
            <img
                src={`/screenshots/${name}.png`}
                width={width}
                height={height}
                alt={alt}
                loading="lazy"
                className={`${image} dark:hidden`}
            />
            <img
                src={`/screenshots/${name}-dark.png`}
                width={width}
                height={height}
                alt={alt}
                loading="lazy"
                className={`${image} hidden dark:block`}
            />
        </span>
    );
}

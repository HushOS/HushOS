/*
 * Twelve words two people read to each other: the family's words (over its
 * first keys) or a join code (over the roster that lets someone in). The
 * same grid as a person's own words, in the text face: whole words are read
 * aloud, not characters one by one, so mono (DESIGN.md, Typography) is not
 * for them.
 */
export function WordList({
    words,
    label,
    kind,
}: {
    words: readonly string[];
    label: string;
    kind: 'family-words' | 'join-code';
}) {
    return (
        <ol
            aria-label={label}
            data-words={words.join(' ')}
            data-kind={kind}
            className="grid w-full grid-cols-3 gap-1.5 sm:grid-cols-4"
        >
            {words.map((word, index) => (
                <li
                    key={index}
                    className="flex items-baseline gap-1.5 rounded-md bg-muted px-2.5 py-2"
                >
                    <span
                        aria-hidden="true"
                        className="w-4 text-right text-[11px] text-muted-foreground tabular-nums"
                    >
                        {index + 1}
                    </span>
                    <span className="text-[15px] font-medium">{word}</span>
                </li>
            ))}
        </ol>
    );
}

/* Where to compare words: said on both join screens, so nobody reads them over HushOS itself. */
export function CompareGuidance() {
    return (
        <p className="text-[13px] leading-snug text-muted-foreground">
            Compare these in person or on a call through another app, never in a message sent
            through HushOS.
        </p>
    );
}

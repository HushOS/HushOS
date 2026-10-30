/*
 * Twelve words two people read to each other: a family check's (the pair
 * code), or the old join code read to an older app's newcomer. The same grid as a person's own words, in the text face: whole words are read
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
    kind: 'pair-code' | 'older-code';
}) {
    return (
        <ol
            aria-label={label}
            data-words={words.join(' ')}
            data-kind={kind}
            className="grid w-full grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-1.5"
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

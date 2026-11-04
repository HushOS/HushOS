/*
 * A person's initials, the one rule every avatar uses (the account menu, members, contacts,
 * share sheets): the first letter of each of the first two words that have a letter or
 * digit in them, upper-cased. An aside in brackets is not the name ("Lisa (you)" is "L", not
 * "L(" or "LY"), unless it is all there is; punctuation and emoji never become an initial.
 * Letters are taken whole, as the reader sees them (graphemes), so an accented or non-Latin
 * letter is one initial. A name with no letter at all shows its first character; an empty
 * one, "?".
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const LETTER = /[\p{L}\p{N}]/u;

function firstLetter(word: string) {
    for (const { segment } of segmenter.segment(word)) if (LETTER.test(segment)) return segment;
    return null;
}

const ASIDE = /[([{][^)\]}]*[)\]}]/gu;

export function initialsOf(name: string) {
    const trimmed = name.trim();
    const bare = trimmed.replace(ASIDE, ' ').trim();
    const letters = (bare || trimmed)
        .split(/\s+/)
        .map(firstLetter)
        .filter((letter): letter is string => letter !== null)
        .slice(0, 2);
    if (letters.length) return letters.join('').toLocaleUpperCase();
    const [first] = segmenter.segment(trimmed);
    return first?.segment ?? '?';
}

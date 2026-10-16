export type PostMeta = {
    title: string;
    description: string;
    date: string;
    /* Among posts of the same day, lower comes first. */
    order?: number;
    author: string;
    /* The word a post's cover spells in dots, and the ink it is printed in (see Cover). */
    cover?: string;
    tone?: CoverTone;
};

export type CoverTone = 'quiet' | 'lime' | 'sun' | 'sage' | 'blue' | 'orange' | 'mint' | 'graphite';

/* Tones for paper only (the printed recovery kit): never a post's or a card's. */
export type PrintTone = 'paper';

/* The frontmatter of every post, for lists, cards and the sitemap; bodies are in `postBodies`. */
const modules = import.meta.glob<{ frontmatter: PostMeta }>('../content/blog/*.mdx', {
    eager: true,
    query: '?meta',
});

export function postSlug(path: string) {
    return path
        .split('/')
        .pop()!
        .replace(/\.mdx$/, '');
}

export const posts = Object.entries(modules)
    .map(([path, module]) => ({ slug: postSlug(path), meta: module.frontmatter }))
    // Newest first. Posts of one day keep the order their `order` gives them, lower first,
    // so an announcement leads the companion piece published beside it.
    .sort(
        (a, b) =>
            b.meta.date.localeCompare(a.meta.date) ||
            (a.meta.order ?? 0) - (b.meta.order ?? 0) ||
            a.slug.localeCompare(b.slug),
    );

/*
 * A date-only string parses as UTC midnight, so it must be formatted in UTC too:
 * in the visitor's zone it would read as the previous day west of Greenwich,
 * and the browser's text would no longer match the server's.
 */
export function formatDate(value: string) {
    return new Date(value).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
    });
}

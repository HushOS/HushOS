import type { Root } from 'hast';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';

/*
 * Markdown as data, never as code. CommonMark plus GitHub tables, task lists,
 * strikethrough and autolinks parse into a syntax tree; raw HTML inside the
 * document is dropped, not rendered; the tree is then sanitised against an
 * allowlist of elements and attributes and handed to the viewer, which turns it
 * into elements itself. Links and images get their own treatment there: a link
 * opens only when clicked and never carries a script URL, and an image is
 * named, not fetched.
 */

const schema: SanitizeSchema = {
    ...defaultSchema,
    // No ids or names on headings: nothing here needs to be a link target, and
    // clobbering is one less thing to think about.
    clobber: [],
    attributes: {
        ...defaultSchema.attributes,
        code: [['className', /^language-[\w+-]+$/]],
        input: [['type', 'checkbox'], ['checked'], ['disabled']],
    },
    protocols: {
        ...defaultSchema.protocols,
        href: ['http', 'https', 'mailto'],
        src: ['http', 'https'],
    },
};

const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSanitize, schema);

export const MARKDOWN_LIMIT = 2 * 1024 * 1024;

/*
 * Synchronous on purpose: every plugin here is synchronous, so the tree can be
 * built during render and the document appears formed, never as raw text first.
 */
export function markdownToHast(text: string): Root {
    return processor.runSync(processor.parse(text)) as Root;
}

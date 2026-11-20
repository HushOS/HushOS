import type { Element, Root } from 'hast';
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

/*
 * The blocks the editor's preview scrolls by (lib/editor/scroll-sync.ts): each one's first and last source
 * line, from the positions remark gave its node. Added after sanitising, to elements the sanitiser
 * already let through, and only as two numbers: nothing in the document can set or change them.
 */
const SOURCE_BLOCKS = new Set([
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'pre',
    'blockquote',
    'li',
    'table',
    'tr',
    'hr',
]);

/* A fence's language, from its code element's class (language-mermaid). */
function fenceLanguage(pre: Element) {
    const code = pre.children.find(
        (child): child is Element => child.type === 'element' && child.tagName === 'code',
    );
    const classes = code?.properties.className;
    const name = Array.isArray(classes)
        ? classes.find((entry) => String(entry).startsWith('language-'))
        : undefined;
    return name ? String(name).slice('language-'.length).toLowerCase() : null;
}

/*
 * Each Mermaid fence's place among the file's diagrams (`data-diagram`, from 0), so the renderer draws
 * only the first DIAGRAMS_PER_DOCUMENT (lib/viewers/markdown/mermaid-svg.ts).
 */
function markDiagrams(node: Root | Element, count = { next: 0 }) {
    for (const child of node.children) {
        if (child.type !== 'element') continue;
        if (child.tagName === 'pre' && fenceLanguage(child) === 'mermaid')
            child.properties.dataDiagram = count.next++;
        else markDiagrams(child, count);
    }
}

function markSourceLines(node: Root | Element) {
    for (const child of node.children) {
        if (child.type !== 'element') continue;
        const position = child.position;
        if (SOURCE_BLOCKS.has(child.tagName) && position) {
            child.properties.dataSourceLine = position.start.line;
            child.properties.dataSourceEnd = position.end.line;
        }
        // A fence's text has nothing to mark, and a table's cells are marked by their row.
        if (child.tagName !== 'pre') markSourceLines(child);
    }
}

const sourceLines = () => (tree: Root) => {
    markSourceLines(tree);
    markDiagrams(tree);
};

const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: false })
    .use(rehypeSanitize, schema)
    .use(sourceLines);

/*
 * Synchronous on purpose: every plugin here is synchronous, so the tree can be
 * built during render and the document appears formed, never as raw text first.
 */
export function markdownToHast(text: string): Root {
    return processor.runSync(processor.parse(text)) as Root;
}

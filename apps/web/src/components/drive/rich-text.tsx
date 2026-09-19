import type { Element, Root } from 'hast';
import { toJsxRuntime, type Components } from 'hast-util-to-jsx-runtime';
import { ExternalLinkIcon, ImageIcon } from 'lucide-react';
import {
    type AnchorHTMLAttributes,
    type ImgHTMLAttributes,
    type ReactNode,
    useEffect,
    useMemo,
    useState,
} from 'react';
import { Fragment as JsxFragment, jsx, jsxs } from 'react/jsx-runtime';
import { canHighlight, HIGHLIGHT_LIMIT, highlight } from '@/lib/highlight';
import { markdownToHast } from '@/lib/markdown';
import '@/components/drive/rich-text.css';

/*
 * Text the viewer shows as structure rather than as a string: highlighted
 * code, and Markdown rendered from its syntax tree. Both go through one path,
 * a hast tree turned into React elements, with the elements that could reach
 * outside the page swapped for safe ones.
 */

/* A link in a person's document: opens in a new tab on a click, never on load, never with a script URL. */
function SafeLink({ href, children, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement>) {
    const safe = href && /^(https?:|mailto:)/i.test(href) ? href : undefined;
    if (!safe) return <span className="rt-link-disabled">{children}</span>;
    return (
        <a {...rest} href={safe} target="_blank" rel="noopener noreferrer nofollow">
            {children}
            <ExternalLinkIcon aria-hidden="true" className="rt-link-icon" />
        </a>
    );
}

/* An image reference is named, not fetched: the page loads nothing remote. */
function NamedImage({ alt, src }: ImgHTMLAttributes<HTMLImageElement>) {
    let host = '';
    try {
        host = src ? new URL(src).host : '';
    } catch {
        host = '';
    }
    return (
        <span className="rt-image" title={src}>
            <ImageIcon aria-hidden="true" />
            <span>{alt || 'Image'}</span>
            {host && <span className="rt-image-host">{host}</span>}
        </span>
    );
}

function languageOf(node: Element | undefined) {
    const className = node?.properties?.className;
    const classes = Array.isArray(className) ? className : [];
    for (const entry of classes) {
        const match = /^language-([\w+-]+)$/.exec(String(entry));
        if (match) return match[1]!.toLowerCase();
    }
    return null;
}

function textOf(node: Element): string {
    let out = '';
    for (const child of node.children) {
        if (child.type === 'text') out += child.value;
        else if (child.type === 'element') out += textOf(child);
    }
    return out;
}

/* A fenced block inside Markdown: highlighted once its grammar has loaded, plain until then. */
function FencedCode({ node, children }: { node?: Element; children?: ReactNode }) {
    const code = node?.children.find(
        (child): child is Element => child.type === 'element' && child.tagName === 'code',
    );
    const language = normaliseLanguage(languageOf(code));
    const text = code ? textOf(code) : '';
    const tree = useHighlighted(text, language);
    if (tree) return <HastView tree={tree} components={codeComponents} />;
    return <pre className="rt-plain">{children}</pre>;
}

/* Markdown fence names people actually write, to the grammar ids we ship. */
function normaliseLanguage(language: string | null) {
    if (!language) return null;
    const aliases: Record<string, string> = {
        js: 'javascript',
        ts: 'typescript',
        sh: 'shellscript',
        bash: 'shellscript',
        zsh: 'shellscript',
        shell: 'shellscript',
        console: 'shellscript',
        yml: 'yaml',
        py: 'python',
        rb: 'ruby',
        rs: 'rust',
        golang: 'go',
        'c++': 'cpp',
        cs: 'csharp',
        md: 'markdown',
        docker: 'dockerfile',
        make: 'makefile',
        html: 'html',
        vue: 'html',
    };
    return aliases[language] ?? language;
}

/* Markdown swaps links, images and fences; highlighted code keeps Shiki's own <pre>. */
const markdownComponents: Partial<Components> = {
    a: SafeLink as Components['a'],
    img: NamedImage as Components['img'],
    pre: FencedCode as Components['pre'],
};
const codeComponents: Partial<Components> = {};

/* A hast tree as React elements. */
export function HastView({
    tree,
    components = markdownComponents,
}: {
    tree: Root;
    components?: Partial<Components>;
}) {
    return useMemo(
        () =>
            toJsxRuntime(tree, {
                Fragment: JsxFragment,
                jsx,
                jsxs,
                components,
                passNode: true,
                ignoreInvalidStyle: true,
            }),
        [tree, components],
    );
}

/* Highlights when a grammar exists and the text is not too big; null means plain. */
function useHighlighted(text: string, language: string | null) {
    const [tree, setTree] = useState<{ key: string; tree: Root } | null>(null);
    const key = `${language}:${text.length}:${text.slice(0, 64)}`;
    useEffect(() => {
        if (!canHighlight(language) || text.length > HIGHLIGHT_LIMIT) return;
        let active = true;
        highlight(text, language)
            .then((result) => {
                if (active) setTree({ key, tree: result });
            })
            .catch((error: unknown) => {
                // Plain text is the fallback; in development say why.
                if (import.meta.env.DEV) console.error('highlight failed', error);
            });
        return () => {
            active = false;
        };
    }, [text, language, key]);
    return tree?.key === key ? tree.tree : null;
}

/* A whole file of code: line numbers, highlighted when possible, wrapped never. */
export function CodeView({ text, language }: { text: string; language: string | null }) {
    const tree = useHighlighted(text, language);
    const lines = useMemo(() => text.split('\n'), [text]);
    return (
        <div className="rt-code" data-language={language ?? undefined}>
            <ol className="rt-gutter" aria-hidden="true">
                {lines.map((_, index) => (
                    <li key={index}>{index + 1}</li>
                ))}
            </ol>
            <div className="rt-source">
                {tree ? (
                    <HastView tree={tree} components={codeComponents} />
                ) : (
                    <pre className="rt-plain">
                        <code>{text}</code>
                    </pre>
                )}
            </div>
        </div>
    );
}

/* Markdown rendered from its tree, built during render so nothing raw ever shows. */
export function MarkdownView({ text }: { text: string }) {
    const tree = useMemo(() => markdownToHast(text), [text]);
    return (
        <article className="rt-markdown">
            <HastView tree={tree} />
        </article>
    );
}

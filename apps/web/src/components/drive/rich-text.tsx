import type { Element, Root } from 'hast';
import { toJsxRuntime, type Components } from 'hast-util-to-jsx-runtime';
import { ExternalLinkIcon, ImageIcon } from 'lucide-react';
import {
    type AnchorHTMLAttributes,
    type CSSProperties,
    Fragment,
    type ImgHTMLAttributes,
    memo,
    type ReactNode,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { Fragment as JsxFragment, jsx, jsxs } from 'react/jsx-runtime';
import { LargeFileBar } from '@/components/drive/viewer-parts';
import {
    canHighlight,
    type ColouredLine,
    colourLines,
    HIGHLIGHT_LIMIT,
    highlight,
} from '@/lib/highlight';
import { largeFileStage } from '@/lib/previews';
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

/* Lines per rendered block: a block re-renders once, when its last line is coloured. */
const RENDER_BLOCK = 256;

/*
 * Lines coloured a slice at a time (see `colourLines`), gathered into blocks
 * of RENDER_BLOCK so each block renders once. Null until the first block of
 * these lines is done, and for good where there is no grammar.
 */
function useColouredBlocks(lines: readonly string[], language: string | null) {
    const [state, setState] = useState<{ lines: readonly string[]; blocks: ColouredLine[][] }>({
        lines: [],
        blocks: [],
    });
    useEffect(() => {
        if (!language) return;
        let active = true;
        let blocks: ColouredLine[][] = [];
        let pending: ColouredLine[] = [];
        const publish = () => {
            if (active) setState({ lines, blocks });
        };
        colourLines(
            lines,
            language,
            (slice) => {
                const before = blocks.length;
                for (const line of slice) {
                    pending.push(line);
                    if (pending.length === RENDER_BLOCK) {
                        blocks = [...blocks, pending];
                        pending = [];
                    }
                }
                if (blocks.length !== before) publish();
            },
            () => !active,
        )
            .then(() => {
                if (!pending.length) return;
                blocks = [...blocks, pending];
                pending = [];
                publish();
            })
            .catch((error: unknown) => {
                // Plain text is the fallback; in development say why.
                if (import.meta.env.DEV) console.error('highlight failed', error);
            });
        return () => {
            active = false;
        };
    }, [lines, language]);
    return state.lines === lines ? state.blocks : null;
}

/*
 * A run of RENDER_BLOCK lines as its own block, so colouring one block lays out
 * that block alone, and a block scrolled far out of view isn't drawn at all
 * (content-visibility), whatever the length of the file.
 */
function blockStyle(lines: number): CSSProperties {
    return { containIntrinsicBlockSize: `auto ${lines * 1.2}rem` };
}

/*
 * A token's colours as a class, one rule per colour pair in a sheet of this
 * page's own: a large file has hundreds of thousands of tokens but a few dozen
 * pairs, and a class costs the browser far less to apply than an inline style.
 */
const tokenClasses = new Map<string, string>();
let tokenSheet: CSSStyleSheet | null = null;
function tokenClass(style: Record<string, string> | undefined) {
    if (!style) return undefined;
    const rule = Object.entries(style)
        .map(([name, value]) => `${name}:${value}`)
        .join(';');
    let name = tokenClasses.get(rule);
    if (!name) {
        name = `rt-t${tokenClasses.size}`;
        if (!tokenSheet) {
            tokenSheet = new CSSStyleSheet();
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, tokenSheet];
        }
        tokenSheet.insertRule(`.${name}{${rule}}`, tokenSheet.cssRules.length);
        tokenClasses.set(rule, name);
    }
    return name;
}

/*
 * Every block ends on a line break of its own. In preserved white space a
 * text's final newline draws no line, so a block whose last line is blank
 * would otherwise lose that line and every number after it would be one off.
 */
const PlainBlock = memo(function PlainBlock({ lines }: { lines: readonly string[] }) {
    return (
        <span className="rt-block" style={blockStyle(lines.length)}>
            {`${lines.join('\n')}\n`}
        </span>
    );
});

const ColouredBlock = memo(function ColouredBlock({ lines }: { lines: ColouredLine[] }) {
    return (
        <span className="rt-block" style={blockStyle(lines.length)}>
            {lines.map((tokens, index) => (
                <Fragment key={index}>
                    <span className="line">
                        {tokens.map((token, at) => (
                            <span key={at} className={tokenClass(token.htmlStyle)}>
                                {token.content}
                            </span>
                        ))}
                    </span>
                    {'\n'}
                </Fragment>
            ))}
        </span>
    );
});

/* A whole file of code: line numbers, coloured when possible, wrapped never. */
export function CodeView({
    text,
    language,
    size = text.length,
    markLine = null,
    quiet = false,
}: {
    text: string;
    language: string | null;
    /* What counts against the colouring limit and ceiling when that isn't the text shown: the file a JSON layout came from. */
    size?: number;
    /* A 1-based line to mark in the gutter and scroll to, such as where a JSON file stops being valid. */
    markLine?: number | null;
    /* No colouring bar: another bar above already speaks for the file (text shown in part). */
    quiet?: boolean;
}) {
    const [asked, setAsked] = useState(false);
    const colourable = canHighlight(language);
    const stage = colourable ? largeFileStage('colour', size) : 'fine';
    const colour = colourable && (stage === 'fine' || (stage === 'offer' && asked));
    const lines = useMemo(() => text.split('\n'), [text]);
    const plain = useMemo(() => {
        const out: (readonly string[])[] = [];
        for (let start = 0; start < lines.length; start += RENDER_BLOCK)
            out.push(lines.slice(start, start + RENDER_BLOCK));
        return out;
    }, [lines]);
    const blocks = useColouredBlocks(lines, colour ? language : null);
    const done = blocks ? Math.min(blocks.length * RENDER_BLOCK, lines.length) : 0;
    return (
        <>
            {stage !== 'fine' && !quiet && (
                <LargeFileBar
                    kind="colour"
                    size={size}
                    stage={
                        stage === 'ceiling'
                            ? 'ceiling'
                            : !asked
                              ? 'offer'
                              : done < lines.length
                                ? 'working'
                                : 'done'
                    }
                    progress={done / lines.length}
                    onContinue={() => setAsked(true)}
                />
            )}
            <div className="rt-code" data-language={language ?? undefined}>
                <Gutter count={lines.length} markLine={markLine} />
                <div className="rt-source">
                    <pre className="shiki">
                        <code>
                            {plain.map((block, index) => {
                                // Plain until a block's colour arrives, and for good where there is none.
                                const coloured = blocks?.[index];
                                return coloured ? (
                                    <ColouredBlock key={index} lines={coloured} />
                                ) : (
                                    <PlainBlock key={index} lines={block} />
                                );
                            })}
                        </code>
                    </pre>
                </div>
            </div>
        </>
    );
}

/*
 * Line numbers in blocks of text like the code beside them, rendered once per
 * text rather than on every slice of colour, the marked line its own span.
 */
const Gutter = memo(function Gutter({
    count,
    markLine,
}: {
    count: number;
    markLine: number | null;
}) {
    const marked = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        marked.current?.scrollIntoView({ block: 'center' });
    }, [markLine]);
    const blocks: ReactNode[] = [];
    for (let start = 1; start <= count; start += RENDER_BLOCK) {
        const end = Math.min(count, start + RENDER_BLOCK - 1);
        const numbers = (from: number, to: number) =>
            Array.from({ length: Math.max(0, to - from + 1) }, (_, at) => from + at).join('\n');
        const mark = markLine !== null && markLine >= start && markLine <= end;
        blocks.push(
            <span key={start} className="rt-block" style={blockStyle(end - start + 1)}>
                {mark ? (
                    <>
                        {markLine > start && `${numbers(start, markLine - 1)}\n`}
                        <span ref={marked} className="rt-mark">
                            {markLine}
                        </span>
                        {`\n${markLine < end ? `${numbers(markLine + 1, end)}\n` : ''}`}
                    </>
                ) : (
                    `${numbers(start, end)}\n`
                )}
            </span>,
        );
    }
    return (
        <div className="rt-gutter" aria-hidden="true">
            {blocks}
        </div>
    );
});

/* Markdown rendered from its tree, built during render so nothing raw ever shows. */
export function MarkdownView({ text }: { text: string }) {
    const tree = useMemo(() => markdownToHast(text), [text]);
    return (
        <article className="rt-markdown">
            <HastView tree={tree} />
        </article>
    );
}

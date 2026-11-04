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
    type RefObject,
    type TableHTMLAttributes,
    useEffect,
    useLayoutEffect,
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
    themeInk,
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

/*
 * A table in a box of its own that scrolls sideways, so a wide one stays inside the page. The
 * box takes focus, so the keyboard can scroll it too.
 */
function ScrollingTable({
    node: _node,
    ...props
}: TableHTMLAttributes<HTMLTableElement> & { node?: Element }) {
    return (
        // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a box that scrolls must be reachable by keyboard
        <section className="rt-table" aria-label="Table" tabIndex={0}>
            <table {...props} />
        </section>
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

/* Markdown swaps links, images, fences and tables; highlighted code keeps Shiki's own <pre>. */
const markdownComponents: Partial<Components> = {
    a: SafeLink as Components['a'],
    img: NamedImage as Components['img'],
    pre: FencedCode as Components['pre'],
    table: ScrollingTable as Components['table'],
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

/*
 * Lines per rendered block. A block is laid out on its own and skipped while far
 * out of view (content-visibility), and the gutter is drawn in the same blocks.
 */
const RENDER_BLOCK = 256;
/*
 * Lines per painted run: colour is painted on the runs in view, and a little
 * beyond, and taken off the rest. Safari repaints newly shown text at a cost
 * that grows with every range the page holds (about 45 ms a frame per thousand),
 * so runs are short and the margin is a tenth of the view.
 */
const PAINT_RUN = 16;

/*
 * Colour is painted over the text rather than built into it: the source stays a
 * few hundred runs of plain text, and each token's colour is a range in a CSS
 * custom highlight. As elements, a dense 600 KB file was over 200,000 spans,
 * and every change anywhere on the page (an upload behind the viewer, a toast)
 * restyled them all; Safari took over a second for each. Text that stays text
 * also keeps find in page, selection and copy exactly as for a plain file.
 */
function canPaint() {
    return (
        typeof CSS !== 'undefined' &&
        'highlights' in CSS &&
        typeof Highlight !== 'undefined' &&
        typeof StaticRange !== 'undefined'
    );
}

/*
 * One highlight per pair of theme colours, registered once for the page under
 * its own name with a rule of its own: a file has hundreds of thousands of
 * tokens but a few dozen pairs. light-dark() picks the colour the page shows.
 * Highlights can't change the font, so the themes' bold and italic (Markdown's
 * emphasis and headings) are not drawn; their colours are.
 */
const paintIds = new Map<string, number>();
const paints: Highlight[] = [];
let paintSheet: CSSStyleSheet | null = null;
function paintFor(style: Record<string, string> | undefined, ink: Ink) {
    const light = style?.['--shiki-light'];
    const dark = style?.['--shiki-dark'];
    if (!light || !dark) return -1;
    const decoration = style['--shiki-light-text-decoration'];
    // Text in the themes' own ink is left in the page's: about half of most code, ranges saved.
    if (!decoration && light.toLowerCase() === ink.light && dark.toLowerCase() === ink.dark)
        return -1;
    const rule = `color:light-dark(${light},${dark})${decoration ? `;text-decoration:${decoration}` : ''}`;
    let id = paintIds.get(rule);
    if (id === undefined) {
        id = paints.length;
        const highlight = new Highlight();
        CSS.highlights.set(`rt-t${id}`, highlight);
        if (!paintSheet) {
            paintSheet = new CSSStyleSheet();
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, paintSheet];
        }
        paintSheet.insertRule(`::highlight(rt-t${id}){${rule}}`, paintSheet.cssRules.length);
        paints.push(highlight);
        paintIds.set(rule, id);
    }
    return id;
}

type Ink = { light: string; dark: string };
const UNPAINTED = new Uint32Array(0);

/*
 * A line's tokens as (start, end, paint) triples, kept small: a token object per
 * token is several hundred bytes, and a large file has hundreds of thousands.
 * Spaces are skipped and a token the same colour as the one before joins it.
 * A line the tokens don't spell out exactly stays plain rather than misplaced;
 * the one difference allowed is a CRLF line's carriage return, which the
 * highlighter leaves out of its tokens.
 */
function paintedLine(line: string, tokens: ColouredLine, ink: Ink) {
    const out: number[] = [];
    let at = 0;
    for (const token of tokens) {
        const end = at + token.content.length;
        if (token.content.trim()) {
            const paint = paintFor(token.htmlStyle, ink);
            const last = out.length - 3;
            if (paint >= 0 && last >= 0 && out[last + 2] === paint) out[last + 1] = end;
            else if (paint >= 0) out.push(at, end, paint);
        }
        at = end;
    }
    const whole = at === line.length || (at === line.length - 1 && line.endsWith('\r'));
    return whole ? Uint32Array.from(out) : UNPAINTED;
}

/*
 * Paints a text's colours onto the runs near the view and takes them off runs
 * that leave it, so the page holds ranges for about a screen of code however
 * long the file. Ranges are static (StaticRange): the browser need not update
 * them as the page changes, and the runs' text never does.
 */
class Painter {
    private colours: Uint32Array[] = [];
    ink: Ink = { light: '', dark: '' };
    private readonly near = new Map<number, Text>();
    private readonly painted = new Map<number, [Highlight, StaticRange][]>();
    constructor(readonly lines: readonly string[]) {}

    get coloured() {
        return this.colours.length;
    }

    /* Starts over: colouring begins again from the first line. */
    reset() {
        for (const run of this.painted.keys()) this.unpaint(run);
        this.colours = [];
    }

    /* The next lines' tokens, in order; runs near the view that are now whole are painted. */
    add(slice: ColouredLine[]) {
        for (const tokens of slice) {
            const line = this.lines[this.colours.length];
            if (line === undefined) break;
            this.colours.push(paintedLine(line, tokens, this.ink));
        }
        for (const [run, text] of this.near) this.paint(run, text);
    }

    show(run: number, text: Text) {
        this.near.set(run, text);
        this.paint(run, text);
    }

    hide(run: number) {
        this.near.delete(run);
        this.unpaint(run);
    }

    hideAll() {
        for (const run of this.near.keys()) this.hide(run);
    }

    private paint(run: number, text: Text) {
        const first = run * PAINT_RUN;
        const end = Math.min(first + PAINT_RUN, this.lines.length);
        if (this.painted.has(run) || this.colours.length < end) return;
        const ranges: [Highlight, StaticRange][] = [];
        let base = 0;
        for (let index = first; index < end; index++) {
            const tokens = this.colours[index]!;
            for (let at = 0; at < tokens.length; at += 3) {
                const highlight = paints[tokens[at + 2]!]!;
                const range = new StaticRange({
                    startContainer: text,
                    startOffset: base + tokens[at]!,
                    endContainer: text,
                    endOffset: base + tokens[at + 1]!,
                });
                highlight.add(range);
                ranges.push([highlight, range]);
            }
            base += this.lines[index]!.length + 1;
        }
        // A run whose text isn't what the lines spell is left plain: no colour on the wrong letters.
        if (base !== text.length) {
            for (const [highlight, range] of ranges) highlight.delete(range);
            return;
        }
        this.painted.set(run, ranges);
    }

    private unpaint(run: number) {
        for (const [highlight, range] of this.painted.get(run) ?? []) highlight.delete(range);
        this.painted.delete(run);
    }
}

/*
 * Colours the painter's lines a slice at a time (see `colourLines`). Returns how
 * many lines are coloured so far, updated a block at a time so the bar moves
 * without the view re-rendering on every slice; null where there is no grammar.
 */
function useColouring(painter: Painter, language: string | null) {
    const [state, setState] = useState<{ painter: Painter; done: number } | null>(null);
    useEffect(() => {
        if (!language) return;
        let active = true;
        painter.reset();
        const total = painter.lines.length;
        let published = -1;
        themeInk()
            .then((ink) => {
                painter.ink = ink;
                return colourLines(
                    painter.lines,
                    language,
                    (slice) => {
                        painter.add(slice);
                        const done = painter.coloured;
                        if (
                            done === total ||
                            Math.floor(done / RENDER_BLOCK) !== Math.floor(published / RENDER_BLOCK)
                        ) {
                            published = done;
                            setState({ painter, done });
                        }
                    },
                    () => !active,
                );
            })
            .catch((error: unknown) => {
                // Plain text is the fallback; in development say why.
                if (import.meta.env.DEV) console.error('highlight failed', error);
            });
        return () => {
            active = false;
        };
    }, [painter, language]);
    if (!language) return null;
    return state?.painter === painter ? state.done : 0;
}

/*
 * The nearest ancestor that scrolls the code up and down, whose view decides which
 * runs are painted. Not merely one with overflow set: the source scrolls sideways,
 * which makes its overflow-y compute to auto too, yet it is as tall as the file.
 */
function scrollParent(element: HTMLElement) {
    for (let node = element.parentElement; node; node = node.parentElement) {
        const { overflowY } = getComputedStyle(node);
        if (
            (overflowY === 'auto' || overflowY === 'scroll') &&
            node.scrollHeight > node.clientHeight
        )
            return node;
    }
    return null;
}

/*
 * Paints the runs in view or within a tenth of it, and unpaints the rest. A layout
 * effect: when the same view is handed new text (Load whole file), React writes it
 * into the same text nodes, and the old ranges must be gone before that is drawn.
 */
function usePaintNearView(code: RefObject<HTMLElement | null>, painter: Painter, enabled: boolean) {
    useLayoutEffect(() => {
        const element = code.current;
        if (!enabled || !element) return;
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    const target = entry.target as HTMLElement;
                    const run = Number(target.dataset.run);
                    const text = target.firstChild;
                    if (entry.isIntersecting && text instanceof Text) painter.show(run, text);
                    else painter.hide(run);
                }
            },
            { root: scrollParent(element), rootMargin: '10% 0px' },
        );
        for (const run of element.querySelectorAll('[data-run]')) observer.observe(run);
        return () => {
            observer.disconnect();
            painter.hideAll();
        };
    }, [code, painter, enabled]);
}

/*
 * A run of RENDER_BLOCK lines as its own block, so a block scrolled far out of
 * view isn't laid out at all (content-visibility), whatever the length of the file.
 */
function blockStyle(lines: number): CSSProperties {
    return { containIntrinsicBlockSize: `auto ${lines * 1.2}rem` };
}

/*
 * A block's lines in runs of PAINT_RUN, each run one text node for the painter's
 * ranges. Every run ends on a line break of its own: in preserved white space a
 * text's final newline draws no line, so a block whose last line is blank would
 * otherwise lose that line and every number after it would be one off.
 */
const SourceBlock = memo(function SourceBlock({
    runs,
    first,
    lines,
}: {
    runs: readonly string[];
    /* The index of the block's first run in the file. */
    first: number;
    lines: number;
}) {
    return (
        <span className="rt-block" style={blockStyle(lines)}>
            {runs.map((run, index) => (
                <span key={index} data-run={first + index}>
                    {run}
                </span>
            ))}
        </span>
    );
});

/*
 * Without custom highlights (Safari before 17.2, Firefox before 140) a file up to
 * HIGHLIGHT_LIMIT is coloured as it was before them: one element per token, built a
 * block at a time. Past the limit those browsers aren't offered colour at all, since
 * that many elements are what made a large file slow down the whole page.
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

/* A token's colours as a class, one rule per colour pair in a sheet of this page's own. */
const tokenClasses = new Map<string, string>();
let tokenSheet: CSSStyleSheet | null = null;
function tokenClass(style: Record<string, string> | undefined) {
    if (!style) return undefined;
    const rule = Object.entries(style)
        .map(([name, value]) => `${name}:${value}`)
        .join(';');
    let name = tokenClasses.get(rule);
    if (!name) {
        name = `rt-c${tokenClasses.size}`;
        if (!tokenSheet) {
            tokenSheet = new CSSStyleSheet();
            document.adoptedStyleSheets = [...document.adoptedStyleSheets, tokenSheet];
        }
        tokenSheet.insertRule(`.${name}{${rule}}`, tokenSheet.cssRules.length);
        tokenClasses.set(rule, name);
    }
    return name;
}

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

/* A whole file of code: line numbers, coloured when possible, wrapped only on a phone. */
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
    const paint = canPaint();
    const colourable = canHighlight(language) && (paint || size <= HIGHLIGHT_LIMIT);
    const stage = colourable ? largeFileStage('colour', size) : 'fine';
    const colour = colourable && (stage === 'fine' || (stage === 'offer' && asked));
    const lines = useMemo(() => text.split('\n'), [text]);
    const blocks = useMemo(() => {
        const out: { runs: string[]; first: number; lines: number }[] = [];
        for (let start = 0; start < lines.length; start += RENDER_BLOCK) {
            const end = Math.min(start + RENDER_BLOCK, lines.length);
            const runs: string[] = [];
            for (let at = start; at < end; at += PAINT_RUN)
                runs.push(`${lines.slice(at, Math.min(at + PAINT_RUN, end)).join('\n')}\n`);
            out.push({ runs, first: start / PAINT_RUN, lines: end - start });
        }
        return out;
    }, [lines]);
    const painter = useMemo(() => new Painter(lines), [lines]);
    const painted = useColouring(painter, colour && paint ? language : null) ?? 0;
    const elements = useColouredBlocks(lines, colour && !paint ? language : null);
    const done = paint ? painted : Math.min((elements?.length ?? 0) * RENDER_BLOCK, lines.length);
    const code = useRef<HTMLElement>(null);
    usePaintNearView(code, painter, colour && paint);
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
            <div
                className="rt-code"
                data-language={language ?? undefined}
                data-marked={markLine !== null ? '' : undefined}
                data-coloured={colour && done === lines.length ? '' : undefined}
            >
                <Gutter count={lines.length} markLine={markLine} />
                <div className="rt-source">
                    <pre className={paint ? undefined : 'shiki'}>
                        <code ref={code}>
                            {blocks.map((block, index) => {
                                // Plain until a block's colour arrives, and for good where there is none.
                                const coloured = elements?.[index];
                                return coloured ? (
                                    <ColouredBlock key={block.first} lines={coloured} />
                                ) : (
                                    <SourceBlock key={block.first} {...block} />
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

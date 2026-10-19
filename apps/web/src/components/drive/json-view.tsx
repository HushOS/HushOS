import { defaultRangeExtractor, type Range, useVirtualizer } from '@tanstack/react-virtual';
import { cn } from 'cn';
import { ChevronRightIcon, ChevronsDownUpIcon, ChevronsUpDownIcon } from 'lucide-react';
import {
    type KeyboardEvent,
    type ReactNode,
    useCallback,
    useEffect,
    useId,
    useMemo,
    useRef,
    useState,
} from 'react';
import { CopyCheckIcon } from '@/components/copy-button';
import { CodeView } from '@/components/drive/rich-text';
import { Opening } from '@/components/drive/viewer-parts';
import { Button } from '@/components/ui/button';
import {
    type JsonInspection,
    type JsonLayout,
    type JsonProblem,
    jsonPath,
    type PathSegment,
} from '@/lib/json';
import { inspect, inspectNow, preloadJsonWorker } from '@/lib/json-inspect';
import { cue } from '@/lib/sounds';
import '@/components/drive/rich-text.css';

/*
 * A JSON file as a tree of its values, or as text laid out with two-space
 * indents. The file is checked first; one that isn't valid shows as text with
 * the reason and the line marked. Only the rows on screen are in the page, so
 * the tree costs the same for ten values as for a hundred thousand; what it
 * can't avoid is holding the parsed file, which is why it has a cap.
 */

/*
 * Past this many values the file opens as text only. Parsing keeps an object
 * per value on the main thread (about 80ms and 40 MB at this count on a fast
 * laptop), and Expand all lays out a row for each; typical JSON reaches it
 * around 4 MB.
 */
const TREE_MAX_NODES = 200_000;
/*
 * Past this depth the file opens as text only: the parse's reviver recurses
 * once per level, and a few thousand levels exhaust the stack.
 */
const TREE_MAX_DEPTH = 500;
/* A string longer than this shows its start, with Show all. */
const STRING_PREVIEW = 160;
/* Show all stops here; Text has the rest. */
const STRING_WHOLE = 100_000;

type Mode = 'tree' | 'text';
const MODE_KEY = 'hushos-json-view';

function storedMode(): Mode {
    try {
        return localStorage.getItem(MODE_KEY) === 'text' ? 'text' : 'tree';
    } catch {
        return 'tree';
    }
}

function storeMode(mode: Mode) {
    try {
        localStorage.setItem(MODE_KEY, mode);
    } catch {
        /* Private windows and blocked storage just don't remember. */
    }
}

export function preloadJsonView() {
    preloadJsonWorker();
}

function useInspection(text: string) {
    const now = useMemo(() => inspectNow(text), [text]);
    const [later, setLater] = useState<{ text: string; result: JsonInspection } | null>(null);
    useEffect(() => {
        if (now) return;
        let active = true;
        void inspect(text).then((result) => {
            if (active) setLater({ text, result });
        });
        return () => {
            active = false;
        };
    }, [text, now]);
    return now ?? (later?.text === text ? later.result : null);
}

export function JsonView({ text, name }: { text: string; name: string }) {
    const inspection = useInspection(text);
    if (!inspection) return <Opening />;
    if (!inspection.ok)
        return <InvalidJson text={text} problem={inspection.problem} layout={inspection.layout} />;
    return <ValidJson text={text} name={name} layout={inspection} />;
}

/* The sheet at reading width, its own scroller under a bar that stays put. */
function Panel({ children }: { children: ReactNode }) {
    return (
        <div className="flex min-h-0 flex-1 flex-col px-3 py-4 sm:px-6 sm:py-8">
            <div className="sheet mx-auto flex min-h-0 w-full max-w-4xl flex-col overflow-hidden">
                {children}
            </div>
        </div>
    );
}

const number = (value: number) => value.toLocaleString('en-GB');

/*
 * The file as written with the line that breaks it marked, or, when its lines
 * are too long to draw (a minified file), laid out with the problem's place
 * marked in the layout.
 */
function InvalidJson({
    text,
    problem,
    layout,
}: {
    text: string;
    problem: JsonProblem;
    layout: { text: string; line: number | null } | null;
}) {
    return (
        <Panel>
            <p className="shrink-0 border-b border-rule px-4 py-2.5 text-[13px] wrap-anywhere sm:px-6">
                This isn’t valid JSON: {problem.reason}
                {problem.line !== null &&
                    ` (line ${number(problem.line)}${problem.column !== null ? `, column ${number(problem.column)}` : ''})`}
                {layout && '. Its lines are too long to show as written, so it’s laid out.'}
            </p>
            <div className="min-h-0 flex-1 overflow-auto">
                <CodeView
                    text={layout ? layout.text : text}
                    language="json"
                    size={text.length}
                    markLine={layout ? layout.line : problem.line}
                />
            </div>
        </Panel>
    );
}

function ValidJson({ text, name, layout }: { text: string; name: string; layout: JsonLayout }) {
    const [mode, setMode] = useState<Mode>(storedMode);
    const allowed = layout.nodes <= TREE_MAX_NODES && layout.depth <= TREE_MAX_DEPTH;
    // Each view is built the first time it shows and kept, so switching back is instant
    // and a file coloured on request stays coloured.
    const [built, setBuilt] = useState<Record<Mode, boolean>>(() => ({
        tree: allowed && mode === 'tree',
        text: !allowed || mode === 'text',
    }));
    const tree = useTree(text, built.tree);
    const treeFits = allowed && !tree.failed;
    const showing: Mode = treeFits ? mode : 'text';
    const show = useCallback((next: Mode, remember: boolean) => {
        setMode(next);
        if (remember) storeMode(next);
        setBuilt((current) => ({ ...current, [next]: true }));
    }, []);
    // Find in the page can't see rows the tree hasn't drawn, so ⌘F or Ctrl+F turns to Text,
    // where every line is searchable, and the browser's find bar opens over it.
    useEffect(() => {
        if (showing !== 'tree') return;
        const onKeyDown = (event: globalThis.KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f')
                show('text', false);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [showing, show]);
    const why = !allowed
        ? layout.nodes > TREE_MAX_NODES
            ? 'This file is too large for the tree view.'
            : 'This file nests too deeply for the tree view.'
        : 'The tree view couldn’t open this file.';
    return (
        <Panel>
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-rule px-2 py-2 sm:px-3">
                {treeFits ? (
                    <fieldset className="m-0 inline-flex min-w-0 shrink-0 rounded-md border-0 bg-muted p-0.5">
                        <legend className="sr-only">Show as</legend>
                        {(['tree', 'text'] as const).map((value) => (
                            <button
                                key={value}
                                type="button"
                                aria-pressed={showing === value}
                                onClick={() => show(value, true)}
                                className={cn(
                                    'h-8 cursor-pointer rounded-sm px-3 text-[13px] font-semibold outline-none focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:h-10',
                                    showing === value
                                        ? 'bg-card text-foreground shadow-sm'
                                        : 'text-muted-foreground hover:text-foreground',
                                )}
                            >
                                {value === 'tree' ? 'Tree' : 'Text'}
                            </button>
                        ))}
                    </fieldset>
                ) : (
                    <p className="px-2 py-1.5 text-[13px] text-muted-foreground sm:px-3">{why}</p>
                )}
                {showing === 'tree' && <TreeActions tree={tree} />}
            </div>
            {showing === 'tree' && layout.duplicates && (
                <p className="shrink-0 border-b border-rule px-4 py-2 text-[13px] text-muted-foreground sm:px-6">
                    This file repeats some keys; the tree shows the last value.
                </p>
            )}
            {built.tree && treeFits && (
                <TreeView tree={tree} label={name} hidden={showing !== 'tree'} />
            )}
            {(built.text || showing === 'text') && (
                <div className="min-h-0 flex-1 overflow-auto" hidden={showing !== 'text'}>
                    {/* Always laid out: that takes milliseconds in the worker and drawn in blocks costs
                        little, where a large minified file left as one line can't even be drawn. */}
                    <CodeView text={layout.pretty} language="json" size={text.length} />
                </div>
            )}
        </Panel>
    );
}

/* ------------------------------------------------------------------------- */
/* The tree                                                                   */
/* ------------------------------------------------------------------------- */

/* A number the file wrote differently from how JavaScript would (12345678901234567890, 1.50, -0). */
class Written {
    constructor(readonly source: string) {}
}

/*
 * Parses for the tree, keeping a number's own digits where JavaScript would
 * show it differently, so the tree never shows a value the file doesn't hold.
 * Browsers without the reviver's source text (older Safari) show JavaScript's.
 */
function parseForTree(text: string): unknown {
    const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
        typeof value === 'number' &&
        context?.source !== undefined &&
        context.source !== String(value)
            ? new Written(context.source)
            : value;
    return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

type Kind = 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';

function kindOf(value: unknown): Kind {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (value instanceof Written) return 'number';
    const type = typeof value;
    return type === 'string' || type === 'number' || type === 'boolean' ? type : 'object';
}

const keysCache = new WeakMap<object, string[]>();
function keysOf(value: object) {
    let keys = keysCache.get(value);
    if (!keys) keysCache.set(value, (keys = Object.keys(value)));
    return keys;
}

function sizeOf(value: unknown, kind: Kind) {
    if (kind === 'array') return (value as unknown[]).length;
    if (kind === 'object') return keysOf(value as object).length;
    return 0;
}

type Row = {
    /* Child positions from the top, "/0/3": stable while rows above it open and close. */
    id: string;
    level: number;
    key: PathSegment | null;
    value: unknown;
    kind: Kind;
    size: number;
    /* The parent's index in the rows, -1 for the top. */
    parent: number;
    pos: number;
    setSize: number;
    open: boolean;
};

/*
 * What is open: everything to a depth, everything, or the top alone, with the
 * nodes the person flipped since. Expand all and Collapse all change the base
 * and forget the flips, so neither has to list every node.
 */
type Openness = { base: 'depth' | 'all' | 'top'; flipped: ReadonlySet<string> };
const OPEN_DEPTH = 2;

function isOpen(openness: Openness, id: string, level: number) {
    const base =
        openness.base === 'all'
            ? true
            : openness.base === 'top'
              ? level === 1
              : level <= OPEN_DEPTH;
    return base !== openness.flipped.has(id);
}

/* The visible rows, in order: a row for each value whose parents are all open. */
function flatten(root: unknown, openness: Openness): Row[] {
    const rows: Row[] = [];
    const add = (
        key: PathSegment | null,
        value: unknown,
        id: string,
        level: number,
        parent: number,
        pos: number,
        setSize: number,
    ) => {
        const kind = kindOf(value);
        const size = sizeOf(value, kind);
        const open = size > 0 && isOpen(openness, id, level);
        rows.push({ id, level, key, value, kind, size, parent, pos, setSize, open });
        return open;
    };
    type Frame = { index: number; row: Row; keys: string[] | null; next: number };
    const stack: Frame[] = [];
    const descend = (index: number) => {
        const row = rows[index]!;
        stack.push({
            index,
            row,
            keys: row.kind === 'object' ? keysOf(row.value as object) : null,
            next: 0,
        });
    };
    if (add(null, root, '', 1, -1, 1, 1)) descend(0);
    while (stack.length) {
        const frame = stack[stack.length - 1]!;
        if (frame.next >= frame.row.size) {
            stack.pop();
            continue;
        }
        const at = frame.next++;
        const key: PathSegment = frame.keys ? frame.keys[at]! : at;
        const value = frame.keys
            ? (frame.row.value as Record<string, unknown>)[key]
            : (frame.row.value as unknown[])[at];
        const opened = add(
            key,
            value,
            `${frame.row.id}/${at}`,
            frame.row.level + 1,
            frame.index,
            at + 1,
            frame.row.size,
        );
        if (opened) descend(rows.length - 1);
    }
    return rows;
}

type TreeState = ReturnType<typeof useTree>;

function useTree(text: string, enabled: boolean) {
    // A file the parse still can't take (a stack an engine runs out of) falls back to Text.
    const { root, failed } = useMemo(() => {
        if (!enabled) return { root: undefined, failed: false };
        try {
            return { root: parseForTree(text), failed: false };
        } catch {
            return { root: undefined, failed: true };
        }
    }, [text, enabled]);
    const [openness, setOpenness] = useState<Openness>({ base: 'depth', flipped: new Set() });
    const rows = useMemo(
        () => (enabled && !failed ? flatten(root, openness) : []),
        [root, openness, enabled, failed],
    );
    // By index: opening or closing a row changes only the rows after it.
    const [active, setActive] = useState(0);
    const [shownWhole, setShownWhole] = useState<ReadonlySet<string>>(new Set());
    const toggle = useCallback((id: string) => {
        setOpenness((current) => {
            const flipped = new Set(current.flipped);
            if (!flipped.delete(id)) flipped.add(id);
            return { base: current.base, flipped };
        });
    }, []);
    const toggleWhole = useCallback((id: string) => {
        setShownWhole((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    }, []);
    const setAll = useCallback((base: 'all' | 'top') => {
        setOpenness({ base, flipped: new Set() });
        setActive(0);
    }, []);
    const pathOf = useCallback(
        (index: number) => {
            const segments: PathSegment[] = [];
            for (let at = index; at > 0; at = rows[at]!.parent) segments.push(rows[at]!.key!);
            return jsonPath(segments.reverse());
        },
        [rows],
    );
    return {
        failed,
        rows,
        active: Math.min(active, Math.max(0, rows.length - 1)),
        setActive,
        toggle,
        shownWhole,
        toggleWhole,
        setAll,
        pathOf,
    };
}

function TreeActions({ tree }: { tree: TreeState }) {
    const [copied, setCopied] = useState(false);
    useEffect(() => {
        if (!copied) return;
        const timer = window.setTimeout(() => setCopied(false), 1_600);
        return () => window.clearTimeout(timer);
    }, [copied]);
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(tree.pathOf(tree.active));
            cue('success', { volume: 0.4 });
            setCopied(true);
        } catch {
            cue('error');
        }
    };
    // On a phone the three are icons with their names, as the viewer's header does.
    const compact = 'max-sm:w-9 max-sm:px-0 max-sm:pointer-coarse:w-11';
    return (
        <div className="ml-auto flex items-center gap-1">
            <Button
                variant="ghost"
                className={compact}
                aria-label={copied ? 'Copied' : 'Copy path'}
                title={
                    tree.active > 0 ? tree.pathOf(tree.active) : 'Choose a value to copy its path'
                }
                disabled={tree.active === 0}
                onClick={() => void copy()}
            >
                <CopyCheckIcon done={copied} className="size-4" />
                <span className="max-sm:hidden">{copied ? 'Copied' : 'Copy path'}</span>
            </Button>
            <Button
                variant="ghost"
                className={compact}
                aria-label="Expand all"
                onClick={() => tree.setAll('all')}
            >
                <ChevronsUpDownIcon />
                <span className="max-sm:hidden">Expand all</span>
            </Button>
            <Button
                variant="ghost"
                className={compact}
                aria-label="Collapse all"
                onClick={() => tree.setAll('top')}
            >
                <ChevronsDownUpIcon />
                <span className="max-sm:hidden">Collapse all</span>
            </Button>
        </div>
    );
}

function useCoarsePointer() {
    const [coarse] = useState(
        () => typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches,
    );
    return coarse;
}

const expandable = (row: Row) => row.size > 0;
const truncated = (row: Row) =>
    row.kind === 'string' && (row.value as string).length > STRING_PREVIEW;

/*
 * The WAI-ARIA tree pattern over a flat, windowed list: focus stays on the
 * tree and aria-activedescendant names the active row, which is scrolled into
 * the window before it is named, so a row off screen never has to exist.
 */
function TreeView({ tree, label, hidden }: { tree: TreeState; label: string; hidden: boolean }) {
    const scroller = useRef<HTMLDivElement>(null);
    const element = useRef<HTMLDivElement>(null);
    const base = useId();
    const rowHeight = useCoarsePointer() ? 44 : 28;
    const { rows, active, setActive, toggle, toggleWhole, shownWhole } = tree;
    const getItemKey = useCallback((index: number) => rows[index]?.id ?? index, [rows]);
    // The active row is always drawn, so aria-activedescendant never names a missing element.
    const rangeExtractor = useCallback(
        (range: Range) => {
            const indexes = defaultRangeExtractor(range);
            if (active < range.count && !indexes.includes(active))
                return [...indexes, active].sort((a, b) => a - b);
            return indexes;
        },
        [active],
    );
    // oxlint-disable-next-line react/incompatible-library -- no React Compiler here; the virtualizer re-renders through its own state
    const virtualizer = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scroller.current,
        estimateSize: () => rowHeight,
        getItemKey,
        rangeExtractor,
        overscan: 12,
        paddingStart: 8,
        paddingEnd: 8,
    });
    useEffect(() => {
        if (!hidden) virtualizer.scrollToIndex(active, { align: 'auto' });
    }, [active, hidden, virtualizer]);
    const domId = (row: Row) => `${base}${row.id.replaceAll('/', '-')}`;
    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const row = rows[active];
        if (!row || event.altKey || event.ctrlKey || event.metaKey) return;
        const page = Math.max(1, Math.floor((scroller.current?.clientHeight ?? 0) / rowHeight) - 1);
        let next = active;
        switch (event.key) {
            case 'ArrowDown':
                next = active + 1;
                break;
            case 'ArrowUp':
                next = active - 1;
                break;
            case 'PageDown':
                next = active + page;
                break;
            case 'PageUp':
                next = active - page;
                break;
            case 'Home':
                next = 0;
                break;
            case 'End':
                next = rows.length - 1;
                break;
            case 'ArrowRight':
                if (expandable(row)) {
                    if (row.open) next = active + 1;
                    else toggle(row.id);
                }
                break;
            case 'ArrowLeft':
                if (row.open) toggle(row.id);
                else if (row.parent >= 0) next = row.parent;
                break;
            case 'Enter':
                if (expandable(row)) toggle(row.id);
                else if (truncated(row)) toggleWhole(row.id);
                break;
            default:
                return;
        }
        event.preventDefault();
        setActive(Math.max(0, Math.min(rows.length - 1, next)));
    };
    const activeRow = rows[active];
    return (
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto" hidden={hidden}>
            <div
                ref={element}
                role="tree"
                aria-label={label}
                aria-activedescendant={activeRow ? domId(activeRow) : undefined}
                tabIndex={0}
                onKeyDown={onKeyDown}
                className="jv relative outline-none"
                style={{ height: virtualizer.getTotalSize() }}
            >
                {virtualizer.getVirtualItems().map((item) => {
                    const row = rows[item.index]!;
                    return (
                        <TreeRow
                            key={item.key}
                            row={row}
                            index={item.index}
                            id={domId(row)}
                            start={item.start}
                            active={item.index === active}
                            whole={shownWhole.has(row.id)}
                            measure={virtualizer.measureElement}
                            onPick={(index, open) => {
                                setActive(index);
                                if (open && expandable(row)) toggle(row.id);
                                element.current?.focus({ preventScroll: true });
                            }}
                            onWhole={(id) => {
                                toggleWhole(id);
                                element.current?.focus({ preventScroll: true });
                            }}
                        />
                    );
                })}
            </div>
        </div>
    );
}

const count = (size: number, one: string, many: string) =>
    `${size.toLocaleString('en-GB')} ${size === 1 ? one : many}`;

function summary(row: Row) {
    return row.kind === 'array' ? count(row.size, 'item', 'items') : count(row.size, 'key', 'keys');
}

/* A key as the file spells it, escapes and all; an empty key as "". */
function keyText(key: PathSegment) {
    if (typeof key === 'number') return String(key);
    return key === '' ? '""' : JSON.stringify(key).slice(1, -1);
}

/* The start of a long string, never cut through the middle of an emoji. */
function preview(value: string, length = STRING_PREVIEW) {
    let end = length;
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    return value.slice(0, end);
}

function scalarText(row: Row) {
    if (row.kind === 'number')
        return row.value instanceof Written ? row.value.source : String(row.value);
    if (row.kind === 'boolean') return String(row.value);
    if (row.kind === 'null') return 'null';
    return '';
}

/* What a screen reader says for the row: "items, array, 40 items", "name, string, Ada". */
function spoken(row: Row) {
    const name = row.key === null ? 'Top level' : keyText(row.key);
    switch (row.kind) {
        case 'object':
            return row.size ? `${name}, object, ${summary(row)}` : `${name}, empty object`;
        case 'array':
            return row.size ? `${name}, array, ${summary(row)}` : `${name}, empty array`;
        case 'string': {
            const value = row.value as string;
            return truncated(row)
                ? `${name}, string, ${preview(value)}, ${count(value.length, 'character', 'characters')} in all`
                : `${name}, string, ${value}`;
        }
        case 'null':
            return `${name}, null`;
        default:
            return `${name}, ${row.kind}, ${scalarText(row)}`;
    }
}

function TreeRow({
    row,
    index,
    id,
    start,
    active,
    whole,
    measure,
    onPick,
    onWhole,
}: {
    row: Row;
    index: number;
    id: string;
    start: number;
    active: boolean;
    whole: boolean;
    measure: (node: Element | null) => void;
    /* Choosing a row; `open` when it should also open or close (its triangle, a double click). */
    onPick: (index: number, open: boolean) => void;
    onWhole: (id: string) => void;
}) {
    const long = truncated(row);
    return (
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- the tree handles the keys for every row
        <div
            ref={measure}
            data-index={index}
            id={id}
            role="treeitem"
            tabIndex={-1}
            aria-level={row.level}
            aria-setsize={row.setSize}
            aria-posinset={row.pos}
            aria-expanded={expandable(row) ? row.open : undefined}
            aria-selected={active || undefined}
            aria-label={spoken(row)}
            data-active={active ? '' : undefined}
            // Focus belongs to the tree (aria-activedescendant names the row): a row that gets
            // it anyway, from a click or a screen reader, becomes the active row and hands it back,
            // so there is never a ring on one row and the highlight on another.
            onFocus={() => onPick(index, false)}
            onClick={() => onPick(index, false)}
            onDoubleClick={() => onPick(index, true)}
            className="jv-row absolute top-0 left-0 flex min-h-7 w-full cursor-default items-start gap-1 py-1 pr-3 hover:bg-muted/60 pointer-coarse:min-h-11 pointer-coarse:py-3"
            style={{
                transform: `translateY(${start}px)`,
                paddingLeft: `${0.5 + (row.level - 1)}rem`,
            }}
        >
            {expandable(row) ? (
                // The triangle opens and closes; the rest of the row only chooses it. Its target
                // runs the row's full height.
                // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- Right, Left and Enter on the tree do this from the keyboard
                <span
                    className="-my-1 flex w-5 shrink-0 cursor-pointer items-center justify-center self-stretch text-muted-foreground hover:text-foreground pointer-coarse:-my-3 pointer-coarse:w-8"
                    onClick={(event) => {
                        event.stopPropagation();
                        onPick(index, true);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                >
                    <ChevronRightIcon
                        className={cn('size-3.5', row.open && 'rotate-90')}
                        aria-hidden="true"
                    />
                </span>
            ) : (
                <span className="w-5 shrink-0 pointer-coarse:w-8" />
            )}
            {row.key !== null && (
                <span
                    className={cn(
                        'max-w-[60%] shrink-0 truncate',
                        typeof row.key === 'number' ? 'text-muted-foreground' : 'jv-key',
                    )}
                >
                    {keyText(row.key)}
                    <span className="text-foreground">:</span>
                </span>
            )}
            <Value row={row} whole={whole} />
            {long && (
                <button
                    type="button"
                    tabIndex={-1}
                    onClick={(event) => {
                        event.stopPropagation();
                        onWhole(row.id);
                    }}
                    className="ml-auto shrink-0 cursor-pointer pl-2 font-sans text-[13px] font-semibold text-primary underline decoration-1 underline-offset-4 hover:text-primary-hover"
                >
                    {whole ? 'Show less' : 'Show all'}
                </button>
            )}
        </div>
    );
}

function Value({ row, whole }: { row: Row; whole: boolean }) {
    switch (row.kind) {
        case 'object':
        case 'array': {
            const [open, close] = row.kind === 'array' ? ['[', ']'] : ['{', '}'];
            if (!row.size) return <span>{open + close}</span>;
            return (
                <span className="min-w-0 truncate">
                    {!row.open && <span>{`${open}…${close} `}</span>}
                    <span className="font-sans text-muted-foreground">{summary(row)}</span>
                </span>
            );
        }
        case 'string': {
            const value = row.value as string;
            if (whole)
                return (
                    <span className="jv-string min-w-0 whitespace-pre-wrap wrap-anywhere">
                        {value.length > STRING_WHOLE
                            ? `"${preview(value, STRING_WHOLE)}…"`
                            : `"${value}"`}
                        {value.length > STRING_WHOLE && (
                            <span className="font-sans text-muted-foreground">
                                {' '}
                                The rest is in Text.
                            </span>
                        )}
                    </span>
                );
            const long = value.length > STRING_PREVIEW;
            const shown = JSON.stringify(long ? preview(value) : value).slice(1, -1);
            return (
                <span className="jv-string min-w-0 truncate">{`"${shown}${long ? '…' : ''}"`}</span>
            );
        }
        default:
            return <span className={`jv-${row.kind} min-w-0 truncate`}>{scalarText(row)}</span>;
    }
}

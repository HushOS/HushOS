import {
    defaultRangeExtractor,
    useVirtualizer,
    type Range,
    type Virtualizer,
} from '@tanstack/react-virtual';
import {
    useCallback,
    useContext,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { FirstPaintContext } from '@/components/drive/first-paint';

/*
 * A long list draws only the items near the screen. A folder of a few thousand files
 * once drew every row at once, each with its link, check and menu, and the page froze
 * for over half a second as it opened; now an open costs the same at any length.
 *
 * Where the page scrolls depends on the screen: inside the app's sheet on a desk, the
 * window on a phone. So the virtualizer's "scroll element" here is the list itself, and
 * its offset is how far the list's top has gone past the top of whatever scrolls, read
 * from both boxes. Content above the list (the path, a banner) is never counted by hand.
 *
 * Items keep their place with spacers rather than absolute positions, so a table stays
 * a table (its columns, its row semantics) and a grid stays a CSS grid. The list keeps the
 * rows on screen in place itself as items arrive or leave above them (a sync, an upload, a
 * move), by as many rows as the first row on screen moved; the browser's scroll anchoring
 * is off inside it, as Chrome's let rows slide under a sync and Safari has none, and the
 * two together would move twice. Rows that must stay drawn off screen, the focused one and
 * one being dragged, are kept with `keep`.
 */

type Scroller = HTMLElement | Window;

/* The nearest ancestor that scrolls, or the window. */
function scrollerOf(element: HTMLElement): Scroller {
    for (let node = element.parentElement; node; node = node.parentElement) {
        const { overflowY } = getComputedStyle(node);
        if (overflowY === 'auto' || overflowY === 'scroll') return node;
    }
    return window;
}

function viewportTop(scroller: Scroller) {
    return scroller instanceof Window ? 0 : scroller.getBoundingClientRect().top;
}

function viewportHeight(scroller: Scroller) {
    return scroller instanceof Window ? scroller.innerHeight : scroller.clientHeight;
}

/* How far the list's top is above the top of what scrolls: the virtualizer's offset. */
function offsetOf(list: HTMLElement, scroller: Scroller) {
    return viewportTop(scroller) - list.getBoundingClientRect().top;
}

/* Follows which element scrolls the list, which changes as the window crosses a breakpoint. */
function followScroller(list: HTMLElement, onChange: (scroller: Scroller) => void) {
    let scroller = scrollerOf(list);
    const recheck = () => {
        const next = scrollerOf(list);
        if (next === scroller) return;
        scroller = next;
        onChange(scroller);
    };
    window.addEventListener('resize', recheck, { passive: true });
    return {
        current: () => scroller,
        stop: () => window.removeEventListener('resize', recheck),
    };
}

type ListVirtualizer = Virtualizer<HTMLElement, HTMLElement>;

/*
 * What a person scrolls with: a wheel or trackpad, a moving finger (a tap that only presses
 * a button, Close details say, moves nothing), the keys, the scrollbar.
 */
const SCROLL_INPUTS = ['wheel', 'touchmove', 'keydown', 'pointerdown'] as const;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
/* Where every key edits or chooses rather than scrolls. */
const EDITS =
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role=textbox], [role=combobox], [role=listbox], [role=slider], [role=spinbutton]';
/* Where Space presses the control rather than scrolls. */
const PRESSES =
    'button, a[href], summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=option], [role=menuitem], [role=tab]';

/**
 * Whether a key scrolls: one that scrolls the page, pressed outside a field, and for Space
 * not on a button or link either, where it presses it (Close details). The arrows on a row
 * of the list move the keys and the scroll with them, so they count.
 */
function scrollsByKey(event: KeyboardEvent) {
    if (!SCROLL_KEYS.has(event.key)) return false;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(EDITS)) return false;
    return event.key !== ' ' || !target?.closest(PRESSES);
}

/* Whether a press is on the scroller itself, which is its scrollbar. */
function onScrollbar(event: Event, scroller: Scroller) {
    return scroller instanceof Window
        ? event.target === document.documentElement
        : event.target === scroller;
}

function observeOffset(
    instance: ListVirtualizer,
    cb: (offset: number, scrolling: boolean) => void,
) {
    const list = instance.scrollElement;
    if (!list) return;
    let timer: number | undefined;
    /*
     * Whether the person is scrolling: scroll events within 150 ms of each other, begun within a
     * second of their own input (a fling runs on past its last touch), and all the while they
     * hold the scrollbar, moving or not. A scroll the browser makes itself (pulling the scroll
     * in as the list gets shorter, a jump by script) is not theirs, and nothing else that
     * reports (the list resizing) ends one. The list keeps its hands off the scroll while they
     * scroll (useKeepInPlace).
     */
    let scrolling = false;
    let input = -Infinity;
    let holding = false;
    const report = () => cb(offsetOf(list, follow.current()), scrolling || holding);
    const onInput = (event: Event) => {
        if (event instanceof KeyboardEvent ? scrollsByKey(event) : event.type !== 'pointerdown')
            input = performance.now();
        else if (event.type === 'pointerdown' && onScrollbar(event, follow.current())) {
            holding = true;
            report();
        }
    };
    // Let go wherever the pointer is by then; a move with no button down catches a release
    // the browser kept to itself.
    const onRelease = (event: Event) => {
        if (
            !holding ||
            (event instanceof PointerEvent && event.type === 'pointermove' && event.buttons !== 0)
        )
            return;
        holding = false;
        input = performance.now();
        report();
    };
    const onScroll = () => {
        scrolling = scrolling || holding || performance.now() - input < 1000;
        report();
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
            scrolling = false;
            report();
        }, 150);
    };
    const listen = (scroller: Scroller) => {
        scroller.addEventListener('scroll', onScroll, { passive: true });
        for (const type of SCROLL_INPUTS)
            scroller.addEventListener(type, onInput, { passive: true, capture: true });
    };
    const unlisten = (scroller: Scroller) => {
        scroller.removeEventListener('scroll', onScroll);
        for (const type of SCROLL_INPUTS)
            scroller.removeEventListener(type, onInput, { capture: true });
    };
    const follow = followScroller(list, (scroller) => {
        unlisten(previous);
        previous = scroller;
        listen(scroller);
        report();
    });
    let previous = follow.current();
    listen(previous);
    const RELEASES = ['pointerup', 'pointercancel', 'pointermove'] as const;
    for (const type of RELEASES)
        window.addEventListener(type, onRelease, { passive: true, capture: true });
    // The list moves without a scroll as it is shown (the drive's first paint) or grows. When
    // something above it comes or goes, the next scroll reads the new place; the rows drawn
    // past each edge of the screen cover the difference until then.
    const observer = new ResizeObserver(report);
    observer.observe(list);
    report();
    return () => {
        window.clearTimeout(timer);
        unlisten(previous);
        for (const type of RELEASES) window.removeEventListener(type, onRelease, { capture: true });
        follow.stop();
        observer.disconnect();
    };
}

function observeRect(
    instance: ListVirtualizer,
    cb: (rect: { width: number; height: number }) => void,
) {
    const list = instance.scrollElement;
    if (!list) return;
    const report = () => cb({ width: list.clientWidth, height: viewportHeight(follow.current()) });
    const observer = new ResizeObserver(report);
    const watch = (scroller: Scroller) => {
        observer.disconnect();
        if (!(scroller instanceof Window)) observer.observe(scroller);
        report();
    };
    const follow = followScroller(list, watch);
    window.addEventListener('resize', report, { passive: true });
    watch(follow.current());
    return () => {
        observer.disconnect();
        follow.stop();
        window.removeEventListener('resize', report);
    };
}

function scrollToOffset(
    offset: number,
    { adjustments = 0, behavior }: { adjustments?: number; behavior?: ScrollBehavior },
    instance: ListVirtualizer,
) {
    const list = instance.scrollElement;
    if (!list) return;
    const scroller = scrollerOf(list);
    scroller.scrollBy({ top: offset + adjustments - offsetOf(list, scroller), behavior });
}

/* Each drawn item, with the room to leave before it for the items skipped in between. */
export type Placed = { index: number; before: number };

/*
 * The virtualizer for a list drawn at `list`: `count` items of `size` pixels (a grid's
 * row with its gap). `keep` holds indexes drawn wherever the screen is. `placed` lists
 * the items to draw in order with the room before each; `after` is the room after the
 * last; `first` is the first index actually on screen, for the entrance's stagger.
 */
export function useVirtualRows({
    count,
    size,
    list,
    keep,
    ids,
    perLine = 1,
    overscan = 8,
}: {
    count: number;
    size: number;
    list: HTMLElement | null;
    keep: number[];
    /* The items' ids in order, to keep the rows on screen in place when items arrive or leave above them. */
    ids: readonly string[];
    /* Items per line: a grid's columns. */
    perLine?: number;
    overscan?: number;
}) {
    const keepKey = keep.join();
    const rangeExtractor = useCallback(
        (range: Range) => {
            const indexes = defaultRangeExtractor(range);
            // Each index once: the row with the keys is often the one being dragged, and a
            // second copy of a row would be a second element under the same key.
            const extra = [...new Set(keep)].filter(
                (index) => index >= 0 && index < range.count && !indexes.includes(index),
            );
            return extra.length ? [...indexes, ...extra].sort((a, b) => a - b) : indexes;
        },
        // `keepKey` stands for `keep`, which is a new array on every render.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [keepKey],
    );
    const estimateSize = useCallback(() => size, [size]);
    const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
        count,
        getScrollElement: () => list,
        estimateSize,
        overscan,
        rangeExtractor,
        observeElementOffset: observeOffset,
        observeElementRect: observeRect,
        scrollToFn: scrollToOffset,
        // Before the list is measured, a screenful rather than nothing.
        initialRect: { width: 0, height: typeof window === 'undefined' ? 0 : window.innerHeight },
    });
    // The virtualizer keeps item sizes until told: a measured row or tile height replaces the estimate.
    const measured = useRef<number | null>(null);
    useLayoutEffect(() => {
        if (measured.current !== null && measured.current !== size) virtualizer.measure();
        measured.current = size;
    }, [virtualizer, size]);
    useKeepInPlace(virtualizer, ids, perLine, size);
    const items = virtualizer.getVirtualItems();
    const total = virtualizer.getTotalSize();
    return useMemo(() => {
        let end = 0;
        const placed: Placed[] = items.map((item) => {
            const before = item.start - end;
            end = item.end;
            return { index: item.index, before };
        });
        return {
            virtualizer,
            placed,
            after: total - end,
            first: virtualizer.range?.startIndex ?? 0,
        };
    }, [items, total, virtualizer]);
}

/*
 * Keeps the first item on screen where it was when the list changes under it: items arriving
 * or leaving above the screen (a sync, an upload, a move), the grid gaining or losing a column
 * (Info opening beside it, the window resized), a row or tile measuring another height (zoom).
 *
 * Measured by ids, not pixels: the item at the top of the screen before the change, or the
 * first after it that is still listed if it left too, is put back at the top, as far into its
 * line as it was. The target is absolute, from the offset before the change, so a browser that
 * has already pulled the scroll in (rows removed at the bottom of the list) is not moved twice.
 * A pure reorder (sorted again, or a rename: the same items, the first one's neighbours
 * changed) keeps the scroll as it is, and so does a scroll in progress: writing it then would
 * stop a fling dead under the finger.
 */
function useKeepInPlace(
    virtualizer: ListVirtualizer,
    ids: readonly string[],
    perLine: number,
    size: number,
) {
    const last = useRef<{ ids: readonly string[]; perLine: number; size: number } | null>(null);
    useLayoutEffect(() => {
        const before = last.current;
        last.current = { ids, perLine, size };
        const list = virtualizer.scrollElement;
        if (!before || !list) return;
        const reshaped = before.perLine !== perLine || before.size !== size;
        const relisted = before.ids !== ids;
        if (!reshaped && !relisted) return;
        // The offset as it was before this change: scroll events have not reported since.
        const was = virtualizer.scrollOffset ?? 0;
        if (was <= 0 || virtualizer.isScrolling || before.size <= 0) return;
        const line = Math.floor(was / before.size);
        const into = (was - line * before.size) / before.size;
        const top = line * before.perLine;
        let index = top;
        if (relisted) {
            // The first item from the top of the screen down that is still listed.
            const where = new Map(ids.map((id, at) => [id, at]));
            let from = top;
            while (from < before.ids.length && !where.has(before.ids[from]!)) from++;
            if (from >= before.ids.length) return;
            index = where.get(before.ids[from]!)!;
            // A pure reorder (sorted again, a rename): the same items, and the first one's
            // neighbours changed with it. It keeps the scroll, whatever moved; anything else
            // (items in and out, even as many in as out) keeps the first item where it was.
            const same =
                before.ids.length === ids.length && before.ids.every((id) => where.has(id));
            const neighbours =
                before.ids[from - 1] === ids[index - 1] && before.ids[from + 1] === ids[index + 1];
            if (same && !neighbours) {
                if (!reshaped) return;
                index = top;
            }
        }
        const target = (Math.floor(index / perLine) + into) * size;
        const scroller = scrollerOf(list);
        const now = offsetOf(list, scroller);
        const scrolled = scroller instanceof Window ? scroller.scrollY : scroller.scrollTop;
        const room =
            scroller instanceof Window
                ? document.documentElement.scrollHeight - scroller.innerHeight
                : scroller.scrollHeight - scroller.clientHeight;
        const next = Math.max(0, Math.min(room, scrolled + target - now));
        if (Math.abs(next - scrolled) >= 1) scroller.scrollTo({ top: next });
    });
}

/*
 * A size read from the drawn list as it resizes (which includes its first layout, a row
 * that changes height, and a grid gaining a column), so the layout stays CSS's. Read only
 * then, never on a scroll, which would force a layout per frame. While the list is hidden
 * (the drive's first paint) it reads nothing and the last known size stands.
 */
function useDrawnSize<T>(
    element: HTMLElement | null,
    read: (element: HTMLElement) => T | null,
    initial: T,
    same: (a: T, b: T) => boolean,
) {
    const [size, setSize] = useState(initial);
    // The first reading replaces the estimate whatever it is; later ones only past `same`.
    const measuredOnce = useRef(false);
    const measure = useCallback(() => {
        const next = element && read(element);
        if (next === null) return;
        const first = !measuredOnce.current;
        measuredOnce.current = true;
        setSize((current) => (!first && same(current, next) ? current : next));
        // `read` and `same` are fixed for a list's life.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [element]);
    useLayoutEffect(() => {
        if (!element) return;
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [element, measure]);
    // Before the first paint the list is in, and again as the drive's first paint shows the
    // page: the observer's answer lands a frame later, and a grid would show that frame in
    // the estimate's two columns.
    const shown = useContext(FirstPaintContext) === null;
    useLayoutEffect(() => {
        if (shown) measure();
    }, [shown, measure]);
    return size;
}

/*
 * The distance from one row to the next, borders included. Read across the longest run of
 * drawn rows that follow each other, not from one row: WebKit snaps each table row to whole
 * pixels where it falls, so a single row reads 56 or 57 by its position, and a size that
 * changed with every scroll would have the list move the scroll with it. Kept to 1/64 px.
 * Layout positions (offsetTop), not drawn ones: a row coming in is drawn 6px low for its
 * first 0.3s (row-in in styles.css), and its settling resizes nothing to read again.
 */
function rowHeight(body: HTMLElement) {
    const drawn = [...body.querySelectorAll<HTMLElement>('[data-node-id]')];
    let best: [HTMLElement, HTMLElement, number] | null = null;
    for (let start = 0; start < drawn.length;) {
        let end = start;
        const at = (row: HTMLElement) => Number(row.getAttribute('aria-rowindex'));
        while (end + 1 < drawn.length && at(drawn[end + 1]!) === at(drawn[end]!) + 1) end++;
        if (end > start && (!best || end - start > best[2]))
            best = [drawn[start]!, drawn[end]!, end - start];
        start = end + 1;
    }
    const pitch = best
        ? (best[1].offsetTop - best[0].offsetTop) / best[2]
        : (drawn[0]?.getBoundingClientRect().height ?? 0);
    return pitch > 0 ? Math.round(pitch * 64) / 64 : null;
}

/*
 * A table's body drawn by `useVirtualRows`: spacer rows hold the place of the rows not
 * drawn, so the columns, borders and row semantics are a plain table's. `row(index,
 * stagger)` draws one row (with its key); `estimate` is a row's height until one is
 * drawn. A spacer is one cell in the first column: spanning more columns than are shown
 * (a phone hides three) would add columns of its own and squeeze the name.
 */
export function VirtualTableBody({
    ids,
    estimate,
    keep,
    row,
}: {
    /* The rows' ids, in order. */
    ids: readonly string[];
    estimate: number;
    keep: number[];
    row: (index: number, stagger: number) => ReactNode;
}) {
    const [body, setBody] = useState<HTMLTableSectionElement | null>(null);
    // Within a pixel is the same size: WebKit's rows read a little differently by where they
    // fall, and a size that changed with the reading would move every row below the screen
    // (and the browser's scroll with them) on every scroll.
    const size = useDrawnSize(body, rowHeight, estimate, (a, b) => Math.abs(a - b) < 1);
    const { placed, after, first } = useVirtualRows({
        count: ids.length,
        size,
        list: body,
        keep,
        ids,
    });
    const spacer = (key: string, height: number) => (
        <tr key={key} aria-hidden="true">
            {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- an empty spacer, hidden from screen readers */}
            <td style={{ height, padding: 0, border: 0 }} />
        </tr>
    );
    // One flat list, rows keyed by their own keys, so a row keeps its element as the range moves.
    const children: ReactNode[] = [];
    for (const { index, before } of placed) {
        if (before > 0) children.push(spacer(`gap-${index}`, before));
        children.push(row(index, Math.max(0, index - first)));
    }
    if (after > 0) children.push(spacer('gap-end', after));
    return (
        <tbody ref={setBody} style={{ overflowAnchor: 'none' }}>
            {children}
        </tbody>
    );
}

type GridShape = { columns: number; height: number; gap: number };

/* The grid's columns from its own template, the gap between rows, and a drawn tile's height. */
function gridShape(grid: HTMLElement): GridShape | null {
    const style = getComputedStyle(grid);
    const columns = style.gridTemplateColumns.split(' ').length;
    const gap = parseFloat(style.rowGap) || 0;
    const height = grid.querySelector('[data-node-id]')?.getBoundingClientRect().height ?? 0;
    return height > 0 && columns > 0 ? { columns, height, gap } : null;
}

/*
 * A CSS grid of tiles, a `ul`, drawn a row of tiles at a time. Spacers span the row; the
 * grid's gap follows each one, so a spacer is that much shorter than the rows it stands
 * for. `tile(index, stagger)` draws one tile, an `li` with its key.
 */
export function VirtualGrid({
    ids,
    keep,
    tile,
    className,
    ...props
}: {
    /* The tiles' ids, in order. */
    ids: readonly string[];
    keep: number[];
    tile: (index: number, stagger: number) => ReactNode;
    className?: string;
    'aria-label'?: string;
}) {
    const [grid, setGrid] = useState<HTMLUListElement | null>(null);
    // Until a tile is drawn: two columns of roughly a tile's height.
    const { columns, height, gap } = useDrawnSize<GridShape>(
        grid,
        gridShape,
        { columns: 2, height: 180, gap: 8 },
        (a, b) => a.columns === b.columns && a.gap === b.gap && Math.abs(a.height - b.height) < 1,
    );
    const count = ids.length;
    const lines = Math.ceil(count / columns);
    const { placed, after, first } = useVirtualRows({
        count: lines,
        size: height + gap,
        list: grid,
        keep: keep.map((index) => Math.floor(index / columns)),
        ids,
        perLine: columns,
        overscan: 3,
    });
    const spacer = (key: string, room: number) => (
        <li key={key} aria-hidden="true" style={{ gridColumn: '1 / -1', height: room - gap }} />
    );
    const children: ReactNode[] = [];
    for (const { index: line, before } of placed) {
        if (before > gap) children.push(spacer(`gap-${line}`, before));
        const start = line * columns;
        for (let index = start; index < Math.min(count, start + columns); index++)
            children.push(tile(index, Math.max(0, index - first * columns)));
    }
    if (after > gap) children.push(spacer('gap-end', after));
    return (
        <ul
            ref={setGrid}
            // The role again: Safari's VoiceOver drops a list's semantics when its markers are styled away.
            // oxlint-disable-next-line jsx-a11y/no-redundant-roles
            role="list"
            className={className}
            style={{ overflowAnchor: 'none' }}
            {...props}
        >
            {children}
        </ul>
    );
}

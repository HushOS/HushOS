import {
    defaultRangeExtractor,
    useVirtualizer,
    type Range,
    type Virtualizer,
} from '@tanstack/react-virtual';
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

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
 * a table (its columns, its row semantics) and a grid stays a CSS grid. Nothing in the list
 * is the browser's scroll anchor: a spacer that grew as rows were drawn above it would have
 * the browser scroll on by as much, and on; a kept row far from the screen (the one with the
 * keys) would pull the list back towards itself as the rows around it were drawn again. Rows
 * that must stay drawn off screen, the focused one and one being dragged, are kept with `keep`.
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

function observeOffset(
    instance: ListVirtualizer,
    cb: (offset: number, scrolling: boolean) => void,
) {
    const list = instance.scrollElement;
    if (!list) return;
    let timer: number | undefined;
    const report = (scrolling: boolean) => cb(offsetOf(list, follow.current()), scrolling);
    const onScroll = () => {
        report(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => report(false), 150);
    };
    const follow = followScroller(list, (scroller) => {
        previous.removeEventListener('scroll', onScroll);
        previous = scroller;
        scroller.addEventListener('scroll', onScroll, { passive: true });
        report(false);
    });
    let previous = follow.current();
    previous.addEventListener('scroll', onScroll, { passive: true });
    // The list moves without a scroll as it is shown (the drive's first paint) or grows. When
    // something above it comes or goes, the next scroll reads the new place; the rows drawn
    // past each edge of the screen cover the difference until then.
    const observer = new ResizeObserver(() => report(false));
    observer.observe(list);
    report(false);
    return () => {
        window.clearTimeout(timer);
        previous.removeEventListener('scroll', onScroll);
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
    overscan = 8,
}: {
    count: number;
    size: number;
    list: HTMLElement | null;
    keep: number[];
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
 * A size read from the drawn list as it resizes (which includes its first layout, a row
 * that changes height, and a grid gaining a column), so the layout stays CSS's. Read only
 * then, never on a scroll, which would force a layout per frame. While the list is hidden
 * (the drive's first paint) it reads nothing and the last known size stands.
 */
function useDrawnSize<T>(
    element: HTMLElement | null,
    read: (element: HTMLElement) => T | null,
    initial: T,
    key: (value: T) => string,
) {
    const [size, setSize] = useState(initial);
    const measure = useCallback(() => {
        const next = element && read(element);
        if (next !== null) setSize((current) => (key(current) === key(next) ? current : next));
        // `read` and `key` are fixed for a list's life.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [element]);
    useLayoutEffect(() => {
        if (!element) return;
        // Once now, before the first paint: the observer's first answer lands a frame later,
        // and a grid would show that frame in the estimate's two columns.
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [element, measure]);
    return size;
}

/* The height of a drawn row: borders and any rounding included. */
function rowHeight(body: HTMLElement) {
    const height = body.querySelector('[data-node-id]')?.getBoundingClientRect().height ?? 0;
    return height > 0 ? height : null;
}

/*
 * A table's body drawn by `useVirtualRows`: spacer rows hold the place of the rows not
 * drawn, so the columns, borders and row semantics are a plain table's. `row(index,
 * stagger)` draws one row (with its key); `estimate` is a row's height until one is
 * drawn. A spacer is one cell in the first column: spanning more columns than are shown
 * (a phone hides three) would add columns of its own and squeeze the name.
 */
export function VirtualTableBody({
    count,
    estimate,
    keep,
    row,
}: {
    count: number;
    estimate: number;
    keep: number[];
    row: (index: number, stagger: number) => ReactNode;
}) {
    const [body, setBody] = useState<HTMLTableSectionElement | null>(null);
    const size = useDrawnSize(body, rowHeight, estimate, String);
    const { placed, after, first } = useVirtualRows({ count, size, list: body, keep });
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
    count,
    keep,
    tile,
    className,
    ...props
}: {
    count: number;
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
        (shape) => `${shape.columns} ${shape.height} ${shape.gap}`,
    );
    const lines = Math.ceil(count / columns);
    const { placed, after, first } = useVirtualRows({
        count: lines,
        size: height + gap,
        list: grid,
        keep: keep.map((index) => Math.floor(index / columns)),
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

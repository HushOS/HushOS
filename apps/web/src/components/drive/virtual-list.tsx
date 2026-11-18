import {
    defaultRangeExtractor,
    useVirtualizer,
    type Range,
    type Virtualizer,
} from '@tanstack/react-virtual';
import {
    Component,
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
 * rows on screen in place itself as items arrive or leave above them or the list reflows
 * (KeepInPlace), as the browser's scroll anchoring would; that is off inside it, as Chrome's
 * let rows slide under a sync, and the two together would move twice. Rows that must stay
 * drawn off screen, the focused one and one being dragged, are kept with `keep`.
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
    // The items on screen at the last commit, in order (KeepInPlace). The first of them still
    // listed stays drawn through a change, so it can be measured before and after it.
    const anchors = useRef<readonly string[]>([]);
    const where = useMemo(() => new Map(ids.map((id, at) => [id, at])), [ids]);
    const anchor = anchors.current.find((id) => where.has(id));
    const anchorLine = anchor === undefined ? -1 : Math.floor(where.get(anchor)! / perLine);
    const keepKey = `${keep.join()};${anchorLine}`;
    const rangeExtractor = useCallback(
        (range: Range) => {
            const indexes = defaultRangeExtractor(range);
            // Each index once: the row with the keys is often the one being dragged, and a
            // second copy of a row would be a second element under the same key.
            const extra = [...new Set([...keep, anchorLine])].filter(
                (index) => index >= 0 && index < range.count && !indexes.includes(index),
            );
            return extra.length ? [...indexes, ...extra].sort((a, b) => a - b) : indexes;
        },
        // `keepKey` stands for `keep` (a new array on every render) and `anchorLine`.
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
    const placing = useMemo(() => {
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
    // Rendered inside the list on every render of it, so it sees every commit that may move it.
    const keeper = (
        <KeepInPlace virtualizer={virtualizer} ids={ids} where={where} anchors={anchors} />
    );
    return { ...placing, keeper };
}

/*
 * Keeps the items on screen where they are when the list changes under them, as the browser's
 * scroll anchoring does: items arriving or leaving above the screen (a sync, an upload, a
 * move), the grid gaining or losing a column (Info opening beside it), a row or tile
 * measuring another height (zoom).
 *
 * Before React touches the page (getSnapshotBeforeUpdate) it reads where the anchor sits on
 * screen: the first item at least half on screen at the last commit, or the first after it
 * still listed if it left. After the change, in the same task and before paint, it reads it
 * again and scrolls by the difference. Relative and measured, so a scroll under way carries
 * on from where it is, and a scroll the browser has already pulled in (rows leaving near the
 * foot of the list) is not moved twice. The anchor is kept drawn (useVirtualRows), however
 * many items arrive above it.
 *
 * Every commit is checked, as the browser checks every layout: one that only moves the drawn
 * range as the list scrolls leaves the anchor where it was, and nothing is written. Between
 * Info opening and the grid taking its new columns the drawn range does move the anchor, and
 * that is put back too. Left alone: a pure reorder (sorted again, a rename: the same items,
 * the anchor between new neighbours), which keeps the scroll, and the top of the list, where
 * new items show as they arrive.
 */
type KeepProps = {
    virtualizer: ListVirtualizer;
    ids: readonly string[];
    /* Each id's index in `ids`. */
    where: ReadonlyMap<string, number>;
    anchors: { current: readonly string[] };
};
type Anchored = { id: string; top: number; offset: number } | null;

/* How far the scroller is scrolled. */
function scrolledBy(scroller: Scroller) {
    return scroller instanceof Window ? scroller.scrollY : scroller.scrollTop;
}

/* Where an element's top sits below the top of the scroller's view. */
function onScreen(element: Element, scroller: Scroller) {
    return element.getBoundingClientRect().top - viewportTop(scroller);
}

function drawnItem(list: HTMLElement, id: string) {
    return list.querySelector(`[data-node-id="${CSS.escape(id)}"]`);
}

class KeepInPlace extends Component<KeepProps> {
    getSnapshotBeforeUpdate(): Anchored {
        const { virtualizer, where, anchors } = this.props;
        const list = virtualizer.scrollElement;
        if (!list) return null;
        const id = anchors.current.find((anchor) => where.has(anchor));
        const element = id === undefined ? null : drawnItem(list, id);
        if (!element) return null;
        const scroller = scrollerOf(list);
        // Unscrolled since it was last put back, the anchor belongs where it was put, not
        // where rounding left it: WebKit scrolls by whole pixels and snaps rows to them, and
        // half a pixel a change would add up.
        const held = this.held;
        const top =
            held && held.id === id && held.scrolled === scrolledBy(scroller)
                ? held.top
                : onScreen(element, scroller);
        return { id: id!, top, offset: virtualizer.scrollOffset ?? 0 };
    }

    componentDidMount() {
        this.record();
    }

    componentDidUpdate(previous: KeepProps, _state: unknown, anchored: Anchored) {
        if (anchored) this.correct(previous, anchored);
        this.record();
    }

    render() {
        return null;
    }

    /* The anchor last put back: where it was put, and the scroll that left it there, until
     * the list scrolls again. */
    private held: { id: string; top: number; scrolled: number } | null = null;

    private correct(previous: KeepProps, anchored: NonNullable<Anchored>) {
        const { virtualizer, ids, where } = this.props;
        const list = virtualizer.scrollElement;
        if (!list || anchored.offset <= 0) return;
        if (previous.ids !== ids && previous.ids.length === ids.length) {
            // A pure reorder: the same items, and the anchor's neighbours changed with it.
            const was = previous.ids.indexOf(anchored.id);
            const now = where.get(anchored.id)!;
            const same = previous.ids.every((id) => where.has(id));
            const neighbours =
                previous.ids[was - 1] === ids[now - 1] && previous.ids[was + 1] === ids[now + 1];
            if (same && !neighbours) return;
        }
        const element = drawnItem(list, anchored.id);
        if (!element) return;
        const scroller = scrollerOf(list);
        const moved = onScreen(element, scroller) - anchored.top;
        if (Math.abs(moved) < 1) return;
        scroller.scrollBy({ top: moved, behavior: 'instant' });
        this.held = { id: anchored.id, top: anchored.top, scrolled: scrolledBy(scroller) };
    }

    /*
     * The items on screen now, read from the page rather than the virtualizer's lines, which
     * lag a reflow (Info open, the grid still in its old columns). Those at least half on
     * screen come first, in order: a tile the top of the screen has all but hidden is not
     * what the person is looking at, and holding it as the grid loses columns would push
     * the tiles below it, the ones in view, off the foot of the screen.
     */
    private record() {
        const list = this.props.virtualizer.scrollElement;
        if (!list) return;
        const scroller = scrollerOf(list);
        // Unscrolled since the anchor was put back, it stays the anchor: chosen again from a
        // reflow under way (the grid in CSS's new columns and the virtualizer's old ones), the
        // first item of its row would be another item each time, and the place would drift.
        if (this.held?.scrolled === scrolledBy(scroller)) return;
        this.held = null;
        const top = viewportTop(scroller);
        const bottom = top + viewportHeight(scroller);
        const seen: string[] = [];
        const glimpsed: string[] = [];
        for (const item of list.querySelectorAll<HTMLElement>('[data-node-id]')) {
            const box = item.getBoundingClientRect();
            const shown = Math.min(box.bottom, bottom) - Math.max(box.top, top);
            if (shown <= 0) continue;
            (shown * 2 >= box.height ? seen : glimpsed).push(item.dataset.nodeId!);
        }
        this.props.anchors.current = [...seen, ...glimpsed];
    }
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
    const { placed, after, first, keeper } = useVirtualRows({
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
            {keeper}
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
    const { placed, after, first, keeper } = useVirtualRows({
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
            {keeper}
        </ul>
    );
}

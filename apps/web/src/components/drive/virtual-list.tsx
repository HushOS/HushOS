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
import { flushSync } from 'react-dom';
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
    // The items on screen as last seen (KeepInPlace). The one held through a change stays
    // drawn, so it can be measured before and after it.
    const memory = useRef<Memory>({ anchors: [], ids: [] });
    const where = useMemo(() => new Map(ids.map((id, at) => [id, at])), [ids]);
    const anchor = anchorOf(memory.current, where);
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
        <KeepInPlace
            virtualizer={virtualizer}
            ids={ids}
            where={where}
            memory={memory}
            perLine={perLine}
            size={size}
            total={total}
        />
    );
    return { ...placing, keeper };
}

/*
 * Keeps the items on screen where they are when the list changes under them, as the browser's
 * scroll anchoring does: items arriving or leaving above the screen (a sync, an upload, a
 * move), the grid gaining or losing a column (Info opening beside it, the window resized), a
 * row or tile measuring another height (zoom).
 *
 * It holds an anchor: the first item at least half on screen, read from the page at each
 * commit, with where it sat within the list. Before React touches the page
 * (getSnapshotBeforeUpdate) it reads where the anchor is; after the change, in the same task
 * and before paint, it reads it again and scrolls by the difference. A reflow with no commit
 * (the window resized, the grid in new columns) is put back when the list's size changes, by
 * as much as the anchor moved within the list, which no scroll changes. Relative and
 * measured, so a scroll under way carries on from where it is, and a scroll the browser has
 * already pulled in (rows leaving near the foot of the list) is not moved twice. The anchor is
 * kept drawn (useVirtualRows), however many items arrive above it; if every item on screen
 * leaves, the first item after them that is still listed takes the first one's place.
 *
 * A commit that only draws another range as the list scrolls is left alone; the grid's new
 * columns are drawn before the frame that reflowed it is painted (useDrawnSize), so no range
 * is ever drawn in the old ones under the new. Also left alone: a pure reorder (sorted again,
 * a rename: the same items, the anchor between new neighbours), which keeps the scroll, and
 * the top of the list, where new items show as they arrive.
 */

/* The items on screen, first the one to hold, and the list's ids when they were read. */
type Memory = { anchors: readonly string[]; ids: readonly string[] };

/*
 * The item to hold in a list of `where`: the first item on screen still listed, or, if every
 * one of them left, the first after them in the old order that is still listed.
 */
function anchorOf({ anchors, ids }: Memory, where: ReadonlyMap<string, number>) {
    const listed = anchors.find((id) => where.has(id));
    if (listed !== undefined || anchors.length === 0) return listed;
    for (let at = ids.indexOf(anchors[0]!) + 1; at > 0 && at < ids.length; at++)
        if (where.has(ids[at]!)) return ids[at];
    return undefined;
}

type KeepProps = {
    virtualizer: ListVirtualizer;
    ids: readonly string[];
    /* Each id's index in `ids`. */
    where: ReadonlyMap<string, number>;
    memory: { current: Memory };
    perLine: number;
    size: number;
    total: number;
};
/* The anchor before a commit: where it was on screen, and the list's width then. */
type Anchored = {
    id: string;
    top: number;
    offset: number;
    width: number;
    shifted: boolean;
    /* Another element scrolls the list since the anchor was last seen. */
    carried?: boolean;
} | null;
/*
 * The anchor as last seen: how far down the list it sits, which no scroll changes, and
 * where it sat on screen at what scroll. `held`: put there by a correction, so it stays the
 * anchor, at that place, until the list scrolls again.
 */
type Mark = {
    scroller: Scroller;
    id: string;
    inList: number;
    top: number;
    scrolled: number;
    held: boolean;
};

/* How far the scroller is scrolled. */
function scrolledBy(scroller: Scroller) {
    return scroller instanceof Window ? scroller.scrollY : scroller.scrollTop;
}

/*
 * How far down `list` an item of it sits, as laid out: not as drawn, which an entering
 * item's row-in animation (styles.css) puts 6px low for 0.3s.
 */
function inList(item: HTMLElement, list: HTMLElement) {
    return item.offsetParent === list
        ? list.clientTop + item.offsetTop
        : item.offsetTop - list.offsetTop;
}

/* Where an item of `list` sits below the top of the scroller's view. */
function onScreen(item: HTMLElement, list: HTMLElement, scroller: Scroller) {
    return list.getBoundingClientRect().top - viewportTop(scroller) + inList(item, list);
}

function drawnItem(list: HTMLElement, id: string) {
    return list.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(id)}"]`);
}

class KeepInPlace extends Component<KeepProps> {
    private mark: Mark | null = null;
    private observer: ResizeObserver | null = null;
    /* The list element is set after the first render, and may be another later. */
    private observed: HTMLElement | null = null;

    getSnapshotBeforeUpdate(): Anchored {
        const { virtualizer, where, memory } = this.props;
        const list = virtualizer.scrollElement;
        if (!list) return null;
        const id = anchorOf(memory.current, where);
        if (id === undefined) return null;
        // An anchor that left hands its place to the first item after it still listed.
        const from =
            where.has(id) && memory.current.anchors.includes(id) ? id : memory.current.anchors[0]!;
        const element = drawnItem(list, from);
        if (!element) return null;
        const scroller = scrollerOf(list);
        const now = onScreen(element, list, scroller);
        // Moved within the list since it was last seen, with no commit (the window resized
        // and the grid reflowed): it belongs where it was before that.
        // The window crossed a breakpoint and another element scrolls the list now (the
        // window for the app's sheet, or back), starting from its own top: the anchor goes to
        // where it was on screen in the old one.
        if (this.mark?.id === from && this.mark.scroller !== scroller)
            return {
                id,
                top: this.mark.top,
                offset: virtualizer.scrollOffset ?? 0,
                width: list.clientWidth,
                shifted: true,
                carried: true,
            };
        const mark = this.mark?.id === from ? this.mark : null;
        const shift = mark ? inList(element, list) - mark.inList : 0;
        const shifted = Math.abs(shift) >= 1;
        // Unmoved and unscrolled since it was put back, it belongs where it was put, not where
        // rounding left it: WebKit scrolls by whole pixels and snaps rows to them.
        const placed = !shifted && mark?.held && mark.scrolled === scrolledBy(scroller);
        return {
            id,
            top: shifted ? now - shift : placed ? mark!.top : now,
            offset: virtualizer.scrollOffset ?? 0,
            width: list.clientWidth,
            shifted,
        };
    }

    componentDidMount() {
        this.observe();
        this.record();
    }

    componentDidUpdate(previous: KeepProps, _state: unknown, anchored: Anchored) {
        this.observe();
        if (anchored) this.correct(previous, anchored);
        this.record();
    }

    componentWillUnmount() {
        this.observer?.disconnect();
    }

    render() {
        return null;
    }

    private observe() {
        const list = this.props.virtualizer.scrollElement;
        if (list === this.observed) return;
        this.observer ??= new ResizeObserver(this.onResize);
        this.observer.disconnect();
        if (list) this.observer.observe(list);
        this.observed = list;
    }

    private correct(previous: KeepProps, anchored: NonNullable<Anchored>) {
        const { virtualizer, ids, where, perLine, size, total } = this.props;
        const list = virtualizer.scrollElement;
        // At the top of the list the top stays in view, but a new scroller starts at its own
        // top whatever the person was looking at.
        if (!list || (anchored.offset <= 0 && !anchored.carried)) return;
        // A commit that only draws another range as the list scrolls moves nothing: the list
        // corrects only when its items, its shape or its width changed, or something moved
        // the anchor before the commit. Correcting a range's drawing too would chase any
        // rounding between the virtualizer's sizes and the page's, a scroll at a time.
        const changed =
            previous.ids !== ids ||
            previous.perLine !== perLine ||
            previous.size !== size ||
            previous.total !== total ||
            anchored.width !== list.clientWidth ||
            anchored.shifted;
        if (!changed) return;
        if (previous.ids !== ids && previous.ids.length === ids.length) {
            // A pure reorder: the same items, and the anchor's neighbours changed with it. The
            // scroll stays, and the anchor is chosen afresh.
            const was = previous.ids.indexOf(anchored.id);
            const now = where.get(anchored.id)!;
            const same = previous.ids.every((id) => where.has(id));
            const neighbours =
                previous.ids[was - 1] === ids[now - 1] && previous.ids[was + 1] === ids[now + 1];
            if (same && !neighbours) {
                this.mark = null;
                return;
            }
        }
        this.put(list, anchored.id, anchored.top);
    }

    /* Scrolls so the anchor `id` is back at `top` on screen, and holds it there. */
    private put(list: HTMLElement, id: string, top: number) {
        const element = drawnItem(list, id);
        if (!element || list.offsetHeight === 0) return;
        const scroller = scrollerOf(list);
        const moved = onScreen(element, list, scroller) - top;
        const mark = this.mark;
        // Already in place, and already the one held: nothing to do. Another item already in
        // place (the anchor left and the next one landed where it was) is held from now on.
        if (Math.abs(moved) < 1 && mark?.id === id && mark.scroller === scroller) return;
        if (Math.abs(moved) >= 1) scroller.scrollBy({ top: moved, behavior: 'instant' });
        // Within a pixel, the place it was meant for (whole-pixel scrolling and rounding);
        // further out, the scroll was clamped at an end, and where it is now is what counts.
        const now = onScreen(element, list, scroller);
        this.mark = {
            scroller,
            id,
            inList: inList(element, list),
            top: Math.abs(now - top) < 1 ? top : now,
            scrolled: scrolledBy(scroller),
            held: true,
        };
        // The rest of the items on screen stay behind it, should it leave too.
        const { ids, where, memory } = this.props;
        const rest = memory.current.anchors.filter((other) => other !== id && where.has(other));
        memory.current = { anchors: [id, ...rest], ids };
    }

    /*
     * The list's size changed with no commit to see it coming (the window resized, and the
     * grid reflowed into other columns): the anchor goes back to where it sat in the list's
     * view, by as much as it moved within the list. Measured within the list, so no scroll in
     * between counts, the browser's own included.
     */
    private onResize = () => {
        const list = this.props.virtualizer.scrollElement;
        const mark = this.mark;
        if (!list || !mark) return;
        const scroller = scrollerOf(list);
        // Another element scrolls the list now, from its own top: the anchor goes to where it
        // was on screen in the old one.
        if (scroller !== mark.scroller) return this.put(list, mark.id, mark.top);
        // At the top of the list, as on a commit, the top stays in view.
        if (offsetOf(list, scroller) <= 0) return;
        const element = drawnItem(list, mark.id);
        if (!element) return;
        this.put(
            list,
            mark.id,
            onScreen(element, list, scroller) - (inList(element, list) - mark.inList),
        );
    };

    /*
     * The items on screen now, read from the page rather than the virtualizer's lines, which
     * lag a reflow (Info open, the grid still in its old columns). Those at least half on
     * screen come first, in order: a tile the top of the screen has all but hidden is not
     * what the person is looking at, and holding it as the grid loses columns would push
     * the tiles below it, the ones in view, off the foot of the screen.
     */
    private record() {
        const { virtualizer, ids, memory } = this.props;
        const list = virtualizer.scrollElement;
        if (!list) return;
        const scroller = scrollerOf(list);
        // Unscrolled since the anchor was put back, it stays the anchor: chosen again from a
        // reflow under way, the first item of its row would be another item each time, and
        // the place would drift.
        const mark = this.mark;
        if (
            mark?.held &&
            mark.scroller === scroller &&
            mark.scrolled === scrolledBy(scroller) &&
            this.props.where.has(mark.id)
        )
            return;
        const top = viewportTop(scroller);
        const bottom = top + viewportHeight(scroller);
        const seen: HTMLElement[] = [];
        const glimpsed: HTMLElement[] = [];
        for (const item of list.querySelectorAll<HTMLElement>('[data-node-id]')) {
            const from = top + onScreen(item, list, scroller);
            const shown = Math.min(from + item.offsetHeight, bottom) - Math.max(from, top);
            if (shown <= 0) continue;
            (shown * 2 >= item.offsetHeight ? seen : glimpsed).push(item);
        }
        const items = [...seen, ...glimpsed];
        memory.current = { anchors: items.map((item) => item.dataset.nodeId!), ids };
        const first = items[0];
        this.mark = first
            ? {
                  scroller,
                  id: first.dataset.nodeId!,
                  inList: inList(first, list),
                  top: onScreen(first, list, scroller),
                  scrolled: scrolledBy(scroller),
                  held: false,
              }
            : null;
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
        // Drawn again at once, before the frame is painted: CSS has already reflowed the list
        // (a grid in its new columns), and until the virtualizer knows, every range it draws
        // would place the items differently from the frame before (KeepInPlace).
        const observer = new ResizeObserver(() => flushSync(measure));
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

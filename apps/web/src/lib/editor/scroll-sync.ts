/*
 * Two-way scrolling between the editor's source and its Markdown preview (docs/editing-design.md,
 * "Markdown"). The renderer marks each block with the source lines it came from
 * (`data-source-line`, `data-source-end`, lib/viewers/markdown/markdown.ts); a position in either pane is a
 * fractional source line (12.5: halfway down line 12), interpolated within a block and across the
 * gap between two blocks, and the other pane is scrolled to put that line at its top.
 */

/* A rendered block: the source lines it covers (1-based, inclusive) and where it sits in its scroller. */
export type Block = { start: number; end: number; top: number; bottom: number };

/*
 * The blocks both lookups can trust: in document order, and starting no earlier in the source than
 * the blocks before them. Footnote definitions are rendered at the end of the document whatever line
 * they are on, so their starts go backwards; they are left out (their lines map through the gap they
 * leave, to the blocks around them), and the binary searches below keep sorted keys.
 */
export function inSourceOrder(blocks: readonly Block[]): Block[] {
    const kept: Block[] = [];
    let start = -Infinity;
    let top = -Infinity;
    for (const block of blocks) {
        if (block.start < start || block.top < top) continue;
        kept.push(block);
        start = block.start;
        top = block.top;
    }
    return kept;
}

/* The last index whose key is at most `value`, in keys that never decrease; -1 when none is. */
function lastAtMost(blocks: readonly Block[], value: number, key: (block: Block) => number) {
    let low = 0;
    let high = blocks.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (key(blocks[middle]!) <= value) {
            found = middle;
            low = middle + 1;
        } else high = middle - 1;
    }
    return found;
}

/*
 * The first block after `index` that starts past `line` (a block nested in the one at `index` may
 * share its start, or start within it).
 */
function nextAfter(blocks: readonly Block[], index: number, line: number) {
    for (let at = index + 1; at < blocks.length; at++) if (blocks[at]!.start > line) return at;
    return -1;
}

/*
 * Where `line` sits in the preview, in its scroller's coordinates. Blocks come in document order, so
 * their starts never decrease and a nested block follows the one holding it: the last block starting
 * at or before the line is the innermost one there.
 */
export function offsetForLine(blocks: readonly Block[], line: number): number | null {
    if (!blocks.length) return null;
    const index = lastAtMost(blocks, line, (block) => block.start);
    if (index < 0) {
        // Before the first block: from the top of the scroller to it.
        const first = blocks[0]!;
        return first.start <= 1 ? first.top : ((line - 1) / (first.start - 1)) * first.top;
    }
    const block = blocks[index]!;
    const after = block.end + 1;
    if (line < after)
        return (
            block.top + ((line - block.start) / (after - block.start)) * (block.bottom - block.top)
        );
    // In the lines between this block and the next (blank lines, a nested block's parent's end).
    const next = nextAfter(blocks, index, line);
    if (next < 0) return block.bottom;
    const following = blocks[next]!;
    const share = (line - after) / Math.max(1, following.start - after);
    return block.bottom + share * (following.top - block.bottom);
}

/* The source line at `offset` in the preview: the inverse of offsetForLine. */
export function lineForOffset(blocks: readonly Block[], offset: number): number | null {
    if (!blocks.length) return null;
    const index = lastAtMost(blocks, offset, (block) => block.top);
    if (index < 0) {
        const first = blocks[0]!;
        return first.top <= 0 ? first.start : 1 + (offset / first.top) * (first.start - 1);
    }
    const block = blocks[index]!;
    const after = block.end + 1;
    if (offset < block.bottom) {
        const height = block.bottom - block.top;
        return (
            block.start + (height > 0 ? (offset - block.top) / height : 0) * (after - block.start)
        );
    }
    let next = -1;
    for (let at = index + 1; at < blocks.length; at++)
        if (blocks[at]!.top > offset) {
            next = at;
            break;
        }
    if (next < 0) return after;
    const following = blocks[next]!;
    const gap = following.top - block.bottom;
    const share = gap > 0 ? (offset - block.bottom) / gap : 0;
    return after + share * Math.max(0, following.start - after);
}

/* What a pane's scroller offers: its position and size, as an element has them. */
export type Scroller = {
    scrollTop: number;
    readonly scrollHeight: number;
    readonly clientHeight: number;
};

/* A pane: its scroller, and its own mapping between scroll positions and source lines. */
export type ScrollPane = {
    scroller: Scroller;
    /* The fractional source line at the top of the view when scrolled to `top`; null while unknown. */
    lineAt: (top: number) => number | null;
    /* The scroll position that puts `line` at the top of the view; null while unknown. */
    topOf: (line: number) => number | null;
};

export type Side = 'source' | 'preview';
const otherSide = (side: Side): Side => (side === 'source' ? 'preview' : 'source');
const maxTop = (scroller: Scroller) => Math.max(0, scroller.scrollHeight - scroller.clientHeight);

/*
 * Keeps two panes scrolled together. A scroll this link made itself comes back as a scroll event on
 * the pane it moved; that echo is recognised and dropped, so it never moves the pane the person is
 * scrolling (a round trip through two mappings, or a clamp at the end, would land elsewhere).
 */
export class ScrollLink {
    /* Where this link last put each pane, until that pane's next scroll event. */
    private readonly expected: Record<Side, number | null> = { source: null, preview: null };

    /* The panes on screen now: both side by side, or the one a narrow screen shows. */
    constructor(private readonly panes: () => Partial<Record<Side, ScrollPane>>) {}

    /* A pane scrolled: the other follows, unless this is the echo of the link's own scroll. */
    scrolled(side: Side) {
        const pane = this.panes()[side];
        if (!pane) return;
        // Still where the link put it: its own scroll, however many events the browser sends for it (a
        // layout after the write can send another). Only a move away from there is the person's.
        const expected = this.expected[side];
        if (expected !== null && Math.abs(pane.scroller.scrollTop - expected) <= 1) return;
        this.expected[side] = null;
        this.follow(side);
    }

    /* Moves the other pane to where `side` is: its top line at the other's top, and either end to either end. */
    follow(side: Side) {
        const panes = this.panes();
        const target = otherSide(side);
        const source = panes[side];
        const to = panes[target];
        if (!source || !to) return;
        const from = source.scroller;
        let top: number | null;
        if (from.scrollTop <= 0) top = 0;
        else if (from.scrollTop >= maxTop(from) - 1) top = maxTop(to.scroller);
        else {
            const line = source.lineAt(from.scrollTop);
            top = line === null ? null : to.topOf(line);
        }
        if (top === null) return;
        this.put(target, to.scroller, Math.min(Math.max(0, top), maxTop(to.scroller)));
    }

    /* Puts `side` at a line (the narrow switch's kept position); false while its blocks aren't there yet. */
    show(side: Side, line: number) {
        const pane = this.panes()[side];
        if (!pane) return false;
        const top = pane.topOf(line);
        if (top === null) return false;
        this.put(side, pane.scroller, Math.min(Math.max(0, top), maxTop(pane.scroller)));
        return true;
    }

    /* The fractional source line at the top of `side` now. */
    lineOf(side: Side) {
        const pane = this.panes()[side];
        if (!pane) return null;
        return pane.scroller.scrollTop <= 0 ? 1 : pane.lineAt(pane.scroller.scrollTop);
    }

    private put(side: Side, scroller: Scroller, top: number) {
        const before = scroller.scrollTop;
        scroller.scrollTop = top;
        // As the scroller took it (rounded, clamped): only a real move sends a scroll event to expect.
        const now = scroller.scrollTop;
        if (now !== before) this.expected[side] = now;
    }
}

/*
 * The marked blocks under `scroller`, in document order, placed in its scrolled content. Read from
 * layout, so asked once per rendering of the preview (or a change of its size), not per scroll.
 */
export function measureBlocks(scroller: HTMLElement): Block[] {
    const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
    const blocks: Block[] = [];
    for (const element of scroller.querySelectorAll<HTMLElement>('[data-source-line]')) {
        const start = Number(element.dataset.sourceLine);
        const end = Number(element.dataset.sourceEnd);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        const box = element.getBoundingClientRect();
        // Not laid out (hidden): nothing to scroll to.
        if (!box.height && !box.width) continue;
        blocks.push({
            start,
            end: Math.max(start, end),
            top: box.top - base,
            bottom: box.bottom - base,
        });
    }
    return inSourceOrder(blocks);
}

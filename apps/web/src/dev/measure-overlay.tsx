import { useLayoutEffect, useState } from 'react';

/*
 * Redlines over one demo, as design breakdowns draw them. Edges are dashed cyan lines: the
 * heading's text edge, and every component's box, text and icon edges, so two edges a few
 * px apart show as two lines. A component's edges run just past its own box, so a grid of
 * samples isn't cut through by every other sample's lines; the heading's runs the whole demo. Distances are solid magenta lines with end ticks and a px
 * pill: padding, the gap between an icon and its words, and how far a box sits off the
 * heading's edge. Icons are measured by their drawn strokes, not their 24-unit box, which
 * is what optical alignment is about.
 *
 * Measured: the elements marked `data-measure` (`data-measure="inset"` for one framed on
 * purpose, whose offset from the heading isn't a misalignment) inside the demo's `[data-measure-area]`,
 * else its outermost `data-slot` components (every ui/ component sets one), else its
 * children. A `data-measure-scale` on the area divides the px it reports, for a demo drawn
 * larger than life. A breakdown sets `data-measure-mode`: `align` draws only the text and
 * tint edges and the distance between them, `padding` only a box's edges, its content's and
 * the padding between; their pills sit above the demo, never over its words. Colours:
 * --pg-edge and --pg-measure (playground.css).
 */

type Box = { left: number; top: number; right: number; bottom: number };
type Target = { box: Box; text: Box | null; icons: Box[]; inset: boolean };
type Drawing = {
    width: number;
    height: number;
    /* The demo area's own box: breakdown pills go just above it, clear of its words. */
    bounds: Box;
    /* `align` and `padding` draw a breakdown's two marks only; unset draws everything. */
    mode: string | undefined;
    scale: number;
    heading: number | null;
    targets: Target[];
};

const EDGE = 'var(--pg-edge)';
const DISTANCE = 'var(--pg-measure)';
/* Past this, the space beside the content is room it doesn't fill rather than padding. */
const ROOM = 64;

function relative(rect: DOMRect, origin: DOMRect): Box | null {
    if (rect.width === 0 && rect.height === 0) return null;
    return {
        left: rect.left - origin.left,
        top: rect.top - origin.top,
        right: rect.right - origin.left,
        bottom: rect.bottom - origin.top,
    };
}

function union(boxes: Box[]): Box | null {
    if (!boxes.length) return null;
    return boxes.reduce((all, box) => ({
        left: Math.min(all.left, box.left),
        top: Math.min(all.top, box.top),
        right: Math.max(all.right, box.right),
        bottom: Math.max(all.bottom, box.bottom),
    }));
}

const overlaps = (a: Box, b: Box) =>
    a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/* Where the words are: the union of the element's visible text, not its box. */
function textBox(element: Element, origin: DOMRect): Box | null {
    const boxes: Box[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || node.parentElement?.closest('svg, .sr-only')) continue;
        range.selectNodeContents(node);
        const box = relative(range.getBoundingClientRect(), origin);
        if (box) boxes.push(box);
    }
    return union(boxes);
}

/* An icon as drawn: its shapes' extent, so the empty margin inside its viewBox isn't counted. */
function iconBox(icon: SVGSVGElement, origin: DOMRect): Box | null {
    const shapes = Array.from(icon.querySelectorAll('path, line, polyline, polygon, circle, rect'))
        .map((shape) => relative(shape.getBoundingClientRect(), origin))
        .filter((shape): shape is Box => shape !== null);
    return union(shapes) ?? relative(icon.getBoundingClientRect(), origin);
}

function targetsOf(area: Element): Element[] {
    const marked = Array.from(area.querySelectorAll('[data-measure]'));
    if (marked.length) return marked;
    const slots = Array.from(area.querySelectorAll('[data-slot]'));
    // The outermost only: an alert, not its title and description as well.
    const outer = slots.filter(
        (slot) => !slots.some((other) => other !== slot && other.contains(slot)),
    );
    return outer.length ? outer : Array.from(area.children);
}

function measure(root: HTMLElement): Drawing | null {
    const area = root.querySelector<HTMLElement>('[data-measure-area]');
    if (!area) return null;
    const origin = root.getBoundingClientRect();
    const bounds = relative(area.getBoundingClientRect(), origin);
    if (!bounds) return null;
    const heading = root.querySelector('[data-measure-heading]');
    const targets: Target[] = [];
    for (const element of targetsOf(area)) {
        const box = relative(element.getBoundingClientRect(), origin);
        // Hidden and off-screen parts (sr-only text, a closed popup's anchor) aren't drawn.
        if (!box || !overlaps(box, bounds)) continue;
        const icons = Array.from(element.querySelectorAll('svg'))
            .map((icon) => iconBox(icon, origin))
            .filter((icon): icon is Box => icon !== null && overlaps(icon, box));
        targets.push({
            box,
            text: textBox(element, origin),
            icons,
            inset: element.getAttribute('data-measure') === 'inset',
        });
    }
    return {
        width: origin.width,
        height: origin.height,
        bounds,
        mode: area.dataset.measureMode,
        scale: Number(area.dataset.measureScale) || 1,
        heading: heading ? (textBox(heading, origin)?.left ?? null) : null,
        targets,
    };
}

function Pill({ x, y, text }: { x: number; y: number; text: string }) {
    const width = text.length * 5.6 + 8;
    return (
        <g transform={`translate(${x - width / 2} ${y - 7})`}>
            <rect width={width} height={14} rx={7} fill="var(--pg-measure-pill)" />
            <text
                x={width / 2}
                y={10}
                textAnchor="middle"
                fill="#ffffff"
                className="font-mono font-semibold"
                fontSize={9.5}
            >
                {text}
            </text>
        </g>
    );
}

/*
 * A measured distance: a solid line with end ticks at `at`, and its length in a pill when
 * it's at least 2px, moved off the line by `shift` so it doesn't cover what it measures.
 */
function Span({
    from,
    to,
    at,
    axis,
    scale,
    shift = 0,
    prefix = '',
}: {
    from: number;
    to: number;
    at: number;
    axis: 'x' | 'y';
    scale: number;
    shift?: number;
    prefix?: string;
}) {
    const length = Math.abs(to - from);
    if (length < 1) return null;
    const mid = (from + to) / 2;
    const [x1, y1, x2, y2] = axis === 'x' ? [from, at, to, at] : [at, from, at, to];
    const tick = (x: number, y: number) =>
        axis === 'x' ? (
            <line x1={x} x2={x} y1={y - 4} y2={y + 4} />
        ) : (
            <line x1={x - 4} x2={x + 4} y1={y} y2={y} />
        );
    const value = Math.round((length / scale) * 2) / 2;
    return (
        <g>
            <g stroke={DISTANCE} strokeWidth={1}>
                <line x1={x1} y1={y1} x2={x2} y2={y2} />
                {tick(x1, y1)}
                {tick(x2, y2)}
            </g>
            {length >= 2 && (
                <Pill
                    x={axis === 'x' ? mid : at + shift}
                    y={axis === 'x' ? at + shift : mid}
                    text={`${prefix}${value}px`}
                />
            )}
        </g>
    );
}

function Guides({ drawing }: { drawing: Drawing }) {
    // Each component's edges, a little past its own top and bottom.
    const edges = new Map<string, { x: number; top: number; bottom: number }>();
    for (const { box, text, icons } of drawing.targets) {
        const xs = [box.left, box.right, ...(text ? [text.left, text.right] : [])];
        for (const icon of icons) xs.push(icon.left, icon.right);
        for (const raw of xs) {
            const x = Math.round(raw * 2) / 2;
            edges.set(`${x}:${box.top}`, { x, top: box.top - 12, bottom: box.bottom + 12 });
        }
    }
    return (
        <g stroke={EDGE} strokeWidth={1} strokeDasharray="4 3" shapeRendering="crispEdges">
            {drawing.heading !== null && (
                <line x1={drawing.heading} x2={drawing.heading} y1={0} y2={drawing.height} />
            )}
            <g opacity={0.55}>
                {Array.from(edges, ([key, { x, top, bottom }]) => (
                    <line key={key} x1={x} x2={x} y1={top} y2={bottom} />
                ))}
            </g>
        </g>
    );
}

function Distances({ target, drawing }: { target: Target; drawing: Drawing }) {
    const { box, text, icons } = target;
    const { heading, scale } = drawing;
    const content = union([...(text ? [text] : []), ...icons]);
    const middle = (box.top + box.bottom) / 2;
    const centre = (box.left + box.right) / 2;
    // The icon beside the words, on the same line: its gap to them.
    const beside = text
        ? icons.filter((icon) => icon.bottom > text.top && icon.top < text.bottom)
        : [];
    const above = box.top - middle - 9;
    return (
        <g>
            <rect
                x={box.left + 0.5}
                y={box.top + 0.5}
                width={Math.max(0, box.right - box.left - 1)}
                height={Math.max(0, box.bottom - box.top - 1)}
                fill="none"
                stroke={EDGE}
                strokeDasharray="4 3"
            />
            {/*
             * Padding: pills above the box, so the words stay readable. A far right or bottom
             * edge is room the content doesn't fill, not padding, so it isn't measured.
             */}
            {content && (
                <>
                    <Span
                        axis="x"
                        scale={scale}
                        from={box.left}
                        to={content.left}
                        at={middle}
                        shift={above}
                    />
                    {box.right - content.right <= ROOM && (
                        <Span
                            axis="x"
                            scale={scale}
                            from={content.right}
                            to={box.right}
                            at={middle}
                            shift={above}
                        />
                    )}
                    {box.bottom - box.top >= 48 && (
                        <>
                            <Span
                                axis="y"
                                scale={scale}
                                from={box.top}
                                to={content.top}
                                at={centre}
                            />
                            {box.bottom - content.bottom <= ROOM && (
                                <Span
                                    axis="y"
                                    scale={scale}
                                    from={content.bottom}
                                    to={box.bottom}
                                    at={centre}
                                />
                            )}
                        </>
                    )}
                </>
            )}
            {/* The gap between an icon and its words: its pill below the box. */}
            {text &&
                beside.map((icon) => {
                    const at = (text.top + text.bottom) / 2;
                    const shift = box.bottom - at + 9;
                    if (icon.right <= text.left)
                        return (
                            <Span
                                key={icon.left}
                                axis="x"
                                scale={scale}
                                from={icon.right}
                                to={text.left}
                                at={at}
                                shift={shift}
                            />
                        );
                    if (icon.left >= text.right)
                        return (
                            <Span
                                key={icon.left}
                                axis="x"
                                scale={scale}
                                from={text.right}
                                to={icon.left}
                                at={at}
                                shift={shift}
                            />
                        );
                    return null;
                })}
            {/* Words off the heading's edge by a little: align the text, not the box. */}
            {heading !== null &&
                !target.inset &&
                text &&
                Math.abs(text.left - box.left) > 0.5 &&
                Math.abs(text.left - heading) > 0.5 &&
                Math.abs(text.left - heading) <= 32 && (
                    <Span
                        axis="x"
                        scale={scale}
                        from={heading}
                        to={text.left}
                        at={text.bottom + 3}
                        shift={box.bottom - text.bottom + 20}
                        prefix={text.left < heading ? 'text −' : 'text +'}
                    />
                )}
            {/* A box off the heading's edge by a little: the misalignment worth seeing. */}
            {heading !== null &&
                !target.inset &&
                Math.abs(box.left - heading) > 0.5 &&
                Math.abs(box.left - heading) <= 32 && (
                    <Span
                        axis="x"
                        scale={scale}
                        from={heading}
                        to={box.left}
                        at={box.top + 4}
                        shift={box.bottom - box.top + 6}
                        prefix={box.left < heading ? '−' : '+'}
                    />
                )}
        </g>
    );
}

const dedupe = (xs: number[]) => Array.from(new Set(xs.map((x) => Math.round(x * 2) / 2)));

function GuideLines({ xs, height }: { xs: number[]; height: number }) {
    return (
        <g stroke={EDGE} strokeWidth={1} strokeDasharray="4 3" shapeRendering="crispEdges">
            {dedupe(xs).map((x) => (
                <line key={x} x1={x} x2={x} y1={0} y2={height} />
            ))}
        </g>
    );
}

/* Align the text, not the box: the heading's edge, the row's words and its tint. */
function AlignMarks({ drawing }: { drawing: Drawing }) {
    const { heading, targets, bounds, scale, height } = drawing;
    if (heading === null) return null;
    const at = bounds.top - 14;
    return (
        <g>
            <GuideLines
                xs={[
                    heading,
                    ...targets.flatMap((t) => [t.box.left, ...(t.text ? [t.text.left] : [])]),
                ]}
                height={height}
            />
            {targets.map(({ box, text }, index) =>
                text && Math.abs(text.left - heading) > 0.5 ? (
                    <Span
                        key={index}
                        axis="x"
                        scale={scale}
                        from={heading}
                        to={text.left}
                        at={at}
                        prefix="text +"
                    />
                ) : Math.abs(box.left - heading) > 0.5 ? (
                    <Span
                        key={index}
                        axis="x"
                        scale={scale}
                        from={box.left}
                        to={heading}
                        at={at}
                        prefix="tint −"
                    />
                ) : null,
            )}
        </g>
    );
}

/* Padding as it reads: from the box's edges to what's drawn inside it. */
function PaddingMarks({ drawing }: { drawing: Drawing }) {
    const { targets, bounds, scale, height } = drawing;
    const at = bounds.top - 14;
    return (
        <g>
            {targets.map(({ box, text, icons }, index) => {
                const content = union([...(text ? [text] : []), ...icons]);
                if (!content) return null;
                return (
                    <g key={index}>
                        <GuideLines
                            xs={[box.left, box.right, content.left, content.right]}
                            height={height}
                        />
                        <Span axis="x" scale={scale} from={box.left} to={content.left} at={at} />
                        <Span axis="x" scale={scale} from={content.right} to={box.right} at={at} />
                    </g>
                );
            })}
        </g>
    );
}

/*
 * `root` is the demo's element itself, not a ref: mounted together, a child's layout effect
 * runs before the parent's ref is set, so a ref would still be empty here.
 */
export function MeasureOverlay({ root }: { root: HTMLElement | null }) {
    const [drawing, setDrawing] = useState<Drawing | null>(null);
    useLayoutEffect(() => {
        const area = root?.querySelector('[data-measure-area]');
        if (!root || !area) return;
        let frame = 0;
        let moving = 0;
        const draw = () => {
            setDrawing(measure(root));
            // While something in the demo transitions, follow it frame by frame.
            if (moving > 0) frame = requestAnimationFrame(draw);
        };
        const update = () => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(draw);
        };
        const start = () => {
            moving += 1;
            update();
        };
        const end = () => {
            moving = Math.max(0, moving - 1);
            update();
        };
        update();
        // Sizes, DialKit's inline styles, swapped labels and late fonts all move edges.
        const resize = new ResizeObserver(update);
        resize.observe(root);
        for (const child of Array.from(area.querySelectorAll('*'))) resize.observe(child);
        const mutation = new MutationObserver(update);
        mutation.observe(area, {
            attributes: true,
            childList: true,
            subtree: true,
            characterData: true,
        });
        area.addEventListener('transitionrun', start);
        area.addEventListener('transitionend', end);
        area.addEventListener('transitioncancel', end);
        window.addEventListener('resize', update);
        void document.fonts.ready.then(update);
        return () => {
            cancelAnimationFrame(frame);
            resize.disconnect();
            mutation.disconnect();
            area.removeEventListener('transitionrun', start);
            area.removeEventListener('transitionend', end);
            area.removeEventListener('transitioncancel', end);
            window.removeEventListener('resize', update);
        };
    }, [root]);
    if (!drawing) return null;
    return (
        <svg
            aria-hidden="true"
            data-measure-overlay=""
            className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
            width={drawing.width}
            height={drawing.height}
        >
            {drawing.mode === 'align' ? (
                <AlignMarks drawing={drawing} />
            ) : drawing.mode === 'padding' ? (
                <PaddingMarks drawing={drawing} />
            ) : (
                <>
                    <Guides drawing={drawing} />
                    {drawing.targets.map((target, index) => (
                        <Distances key={index} target={target} drawing={drawing} />
                    ))}
                </>
            )}
        </svg>
    );
}

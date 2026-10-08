import { ArrowDownIcon, ArrowUpIcon, CheckIcon, XIcon, type LucideIcon } from 'lucide-react';
import { cn } from 'cn';
import {
    useEffect,
    useRef,
    useState,
    useSyncExternalStore,
    type ComponentProps,
    type ReactNode,
    type RefObject,
} from 'react';
import { Button } from '@/components/ui/button';

/*
 * What Files and Trash share: how a list is selected, the thumbnail that carries
 * the selection, the floating bar that acts on it, and the list's empty and
 * loading states. Both pages read and behave the same, so learning one is
 * learning the other.
 */

/* Whether the primary pointer is a finger: taps then toggle selection instead of replacing it. */
export function useCoarsePointer() {
    return useSyncExternalStore(
        (onChange) => {
            const query = window.matchMedia('(pointer: coarse)');
            query.addEventListener('change', onChange);
            return () => query.removeEventListener('change', onChange);
        },
        () => window.matchMedia('(pointer: coarse)').matches,
        () => false,
    );
}

export type Modifiers = { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean };
export type Marquee = { left: number; top: number; width: number; height: number };

/* Presses that start on these belong to the control under them, never to the list. */
const OWN_PRESS =
    'button, a, input, summary, thead, [data-crumb-drag], [role=menu], [role=dialog], [data-selection-bar], [data-details], section[aria-label=Transfers]';

/*
 * Desktop selection over items marked `data-node-id` inside `root`: a click picks one,
 * Mod-click adds or removes, Shift-click stretches from where the last pick began,
 * a drag on empty space draws a box and picks what it touches, a click on empty
 * space lets go. On a touch screen every tap adds or removes, as there is no
 * modifier to hold. Arrows move the one picked item; with Shift they stretch.
 */
export function useListSelection(ids: string[], root: RefObject<HTMLElement | null>) {
    const coarse = useCoarsePointer();
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [anchor, setAnchor] = useState<string | null>(null);
    const [focused, setFocused] = useState<string | null>(null);
    const [marquee, setMarquee] = useState<Marquee | null>(null);

    function select(id: string, event?: Modifiers) {
        const toggle = coarse || Boolean(event?.metaKey || event?.ctrlKey);
        setFocused(id);
        if (event?.shiftKey && anchor !== null) {
            const from = ids.indexOf(anchor);
            const to = ids.indexOf(id);
            if (from !== -1 && to !== -1) {
                const [start, end] = from < to ? [from, to] : [to, from];
                setSelected(new Set(ids.slice(start, end + 1)));
                return;
            }
        }
        setAnchor(id);
        if (toggle)
            setSelected((current) => {
                const next = new Set(current);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
            });
        else setSelected(new Set([id]));
    }
    /* The corner badge's toggle: always adds or removes, whatever the pointer or modifier. */
    function toggle(id: string) {
        setFocused(id);
        setAnchor(id);
        setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }
    function clear() {
        setSelected(new Set());
        setFocused(null);
    }
    function selectAll() {
        setSelected(new Set(ids));
    }
    function moveFocus(delta: number, extend = false) {
        if (!ids.length) return;
        const index = focused ? ids.indexOf(focused) : -1;
        const next = ids[Math.min(ids.length - 1, Math.max(0, index + delta))]!;
        select(next, extend ? { shiftKey: true } : undefined);
        root.current
            ?.querySelector<HTMLElement>(`[data-node-id="${next}"]`)
            ?.scrollIntoView({ block: 'nearest' });
    }

    const latest = useRef({ ids, selected, select });
    useEffect(() => {
        latest.current = { ids, selected, select };
    });
    useEffect(() => {
        const element = root.current;
        if (!element) return;
        let start: {
            x: number;
            y: number;
            additive: boolean;
            base: Set<string>;
            row: string | null;
            /* The second press of a double click: it opens, it never lets go. */
            second: boolean;
            modifiers: Modifiers;
        } | null = null;
        let dragging = false;
        let lastClick: { row: string; at: number } | null = null;
        const DOUBLE_CLICK_MS = 400;
        // What was selected before the first press of what may become a double click,
        // so a double click opens and leaves the selection as it found it.
        let beforeDouble: Set<string> | null = null;
        let lastDown: { row: string | null; at: number } | null = null;
        const onDown = (event: globalThis.MouseEvent) => {
            if (event.button !== 0) return;
            const target = event.target as HTMLElement;
            const pressed = target.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId ?? null;
            const repeat =
                lastDown !== null &&
                lastDown.row === pressed &&
                event.timeStamp - lastDown.at < 700;
            if (!repeat) beforeDouble = new Set(latest.current.selected);
            lastDown = { row: pressed, at: event.timeStamp };
            if (target.closest(OWN_PRESS)) return;
            start = {
                x: event.clientX,
                y: event.clientY,
                additive: event.metaKey || event.ctrlKey || event.shiftKey,
                base: new Set(latest.current.selected),
                row: pressed,
                second:
                    pressed !== null &&
                    lastClick?.row === pressed &&
                    event.timeStamp - lastClick.at < DOUBLE_CLICK_MS,
                modifiers: {
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                },
            };
            dragging = false;
        };
        const onMove = (event: PointerEvent) => {
            if (!start || start.row) return;
            if (!dragging && Math.hypot(event.clientX - start.x, event.clientY - start.y) < 4)
                return;
            dragging = true;
            const bounds = element.getBoundingClientRect();
            const left = Math.min(start.x, event.clientX);
            const top = Math.min(start.y, event.clientY);
            const right = Math.max(start.x, event.clientX);
            const bottom = Math.max(start.y, event.clientY);
            setMarquee({
                left: left - bounds.left,
                top: top - bounds.top + element.scrollTop,
                width: right - left,
                height: bottom - top,
            });
            const hit = new Set(start.additive ? start.base : []);
            for (const row of element.querySelectorAll<HTMLElement>('[data-node-id]')) {
                const rect = row.getBoundingClientRect();
                const inside =
                    rect.left < right &&
                    rect.right > left &&
                    rect.top < bottom &&
                    rect.bottom > top;
                if (inside) hit.add(row.dataset.nodeId!);
            }
            setSelected(hit);
            event.preventDefault();
        };
        const onUp = (event: PointerEvent) => {
            if (!start) return;
            if (!dragging && event.type !== 'pointercancel') {
                const id =
                    start.row && latest.current.ids.includes(start.row) ? start.row : undefined;
                const { metaKey, ctrlKey, shiftKey } = start.modifiers;
                const plain = !metaKey && !ctrlKey && !shiftKey;
                // The blank part of a row: a plain click there on the one selected row lets
                // go of it, since the eye reads that area as empty space and expects a second
                // click to undo; a double click puts the selection back as it found it.
                const letGo =
                    id !== undefined &&
                    plain &&
                    !start.second &&
                    latest.current.selected.size === 1 &&
                    latest.current.selected.has(id);
                lastClick = id && plain ? { row: id, at: event.timeStamp } : null;
                if (letGo || id === undefined) {
                    setSelected(new Set());
                    setFocused(null);
                } else latest.current.select(id, start.modifiers);
            }
            start = null;
            dragging = false;
            setMarquee(null);
        };
        // The browser decides what a double click is, on the system's own interval:
        // when it says so, the selection goes back to what the first press found.
        const onDouble = () => {
            if (beforeDouble) {
                setSelected(beforeDouble);
                setFocused(null);
            }
        };
        // WebKit drops the pointerdown of the first press after a drag and drop, sending the
        // mousedown alone; that press starts here instead. A pointerdown and its mousedown
        // come from the same input, a few milliseconds apart at most, and a touch sends a
        // mousedown after its pointerup for the same tap. (A drag in WebKit ends without a
        // pointerup, so no press can be held open between the two.)
        let lastPointerDown = -Infinity;
        let lastTouchUp = -Infinity;
        const onPointerDown = (event: PointerEvent) => {
            lastPointerDown = event.timeStamp;
            onDown(event);
        };
        const onMouseDown = (event: globalThis.MouseEvent) => {
            if (event.timeStamp - lastPointerDown < 50 || event.timeStamp - lastTouchUp < 1000)
                return;
            onDown(event);
        };
        const onPointerUp = (event: PointerEvent) => {
            if (event.pointerType === 'touch') lastTouchUp = event.timeStamp;
            onUp(event);
        };
        element.addEventListener('pointerdown', onPointerDown);
        element.addEventListener('mousedown', onMouseDown);
        element.addEventListener('dblclick', onDouble);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onPointerUp);
        window.addEventListener('pointercancel', onPointerUp);
        return () => {
            element.removeEventListener('pointerdown', onPointerDown);
            element.removeEventListener('mousedown', onMouseDown);
            element.removeEventListener('dblclick', onDouble);
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onPointerUp);
            window.removeEventListener('pointercancel', onPointerUp);
        };
    }, [root]);

    return {
        coarse,
        selected,
        setSelected,
        focused,
        setFocused,
        marquee,
        select,
        toggle,
        clear,
        selectAll,
        moveFocus,
    };
}

/* The box a drag on empty space draws. */
export function MarqueeBox({ marquee }: { marquee: Marquee | null }) {
    if (!marquee) return null;
    return (
        <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10 rounded-sm border border-primary bg-primary/10"
            style={marquee}
        />
    );
}

/*
 * An item's thumbnail that carries its selection: a selected item wears a check
 * badge on its corner; hovering an unselected row shows an empty badge that adds
 * it to the selection, and on a touch screen every row shows one while anything
 * is selected. The thumbnail never goes away, and there is no checkbox column.
 * Put `group/row` on the row so the hover badge appears.
 */
export function SelectableMark({
    name,
    checked,
    revealed = false,
    onToggle,
    children,
}: {
    name: string;
    checked: boolean;
    /* Show the empty badge without a hover: a touch screen with a selection under way. */
    revealed?: boolean;
    onToggle: () => void;
    children: ReactNode;
}) {
    return (
        <span className="relative flex size-10 shrink-0 items-center justify-center">
            {children}
            <CornerCheck
                name={name}
                checked={checked}
                revealed={revealed}
                onToggle={onToggle}
                className="-right-0.5 -bottom-0.5 size-4 ring-2 ring-card"
                iconClassName="size-2.5"
            />
        </span>
    );
}

/*
 * The check that carries an item's selection, on a thumbnail's corner. It is a real
 * checkbox, kept out of the tab order since the row itself is what the keys move; a
 * click on it always adds or removes, and never reaches the row underneath.
 */
export function CornerCheck({
    name,
    checked,
    revealed,
    onToggle,
    className,
    iconClassName,
}: {
    name: string;
    checked: boolean;
    revealed: boolean;
    onToggle: () => void;
    className: string;
    iconClassName: string;
}) {
    return (
        <span
            className={cn(
                'absolute z-[1] flex items-center justify-center rounded-full',
                checked
                    ? 'bg-primary text-primary-foreground'
                    : cn(
                          'border-[1.5px] border-input bg-card group-hover/row:visible',
                          revealed ? 'visible' : 'invisible',
                      ),
                className,
            )}
        >
            <input
                type="checkbox"
                aria-label={`Select ${name}`}
                checked={checked}
                tabIndex={-1}
                onChange={() => {}}
                onClick={(event) => {
                    event.stopPropagation();
                    if (event.detail > 1) return;
                    onToggle();
                }}
                onDoubleClick={(event) => event.stopPropagation()}
                className="absolute -inset-2 cursor-pointer appearance-none rounded-full outline-none"
            />
            {checked && (
                <CheckIcon
                    className={cn('pointer-events-none', iconClassName)}
                    strokeWidth={3.6}
                    aria-hidden="true"
                />
            )}
        </span>
    );
}

/*
 * The floating bar for whatever is selected: dark, at the foot of the view, the
 * count first and a way out last. It sticks to the bottom of the window while
 * the list scrolls under it, sits at the foot of a short list, and rises above
 * the Transfers panel while that is open.
 */
export function SelectionBar({
    label,
    children,
    onClear,
}: {
    label: ReactNode;
    children: ReactNode;
    onClear?: () => void;
}) {
    return (
        // The bar stays at the foot of the list, where the work is; the transfers panel and
        // toasts step up above it (--selection-lift). Its height is also the page's scroll
        // padding, so a row scrolled to, or focused, lands above the bar rather than under it.
        <div
            ref={(element) => {
                if (!element) return;
                const root = document.documentElement;
                const measure = () => {
                    const bottom = parseFloat(getComputedStyle(element).bottom) || 0;
                    // The wrapper's top padding is the gap above the bar; 8px of it is kept below what floats over it.
                    root.style.setProperty('--selection-lift', `${element.offsetHeight - 8}px`);
                    root.style.setProperty(
                        '--selection-room',
                        `${element.offsetHeight + bottom}px`,
                    );
                };
                measure();
                const observer = new ResizeObserver(measure);
                observer.observe(element);
                return () => {
                    observer.disconnect();
                    root.style.removeProperty('--selection-lift');
                    root.style.removeProperty('--selection-room');
                };
            }}
            className="pointer-events-none sticky bottom-4 z-30 mt-auto flex justify-center px-4 pt-4 sm:bottom-6"
        >
            <div
                role="toolbar"
                aria-label="Selection"
                data-selection-bar=""
                className="pointer-events-auto flex h-12 max-w-full min-w-0 items-center gap-0.5 rounded-xl bg-secondary pr-1.5 pl-4 text-secondary-foreground shadow-xl sm:h-14 sm:pr-2 sm:pl-5"
            >
                <span className="shrink-0 pr-2 text-sm font-semibold whitespace-nowrap tabular-nums sm:pr-3">
                    {label}
                </span>
                {children}
                {onClear && (
                    <SelectionAction
                        icon={XIcon}
                        label="Clear selection"
                        iconOnly
                        onClick={onClear}
                    />
                )}
            </div>
        </div>
    );
}

/* One action in the selection bar: a label beside its icon where the bar has room, the icon alone where it has not. */
export function SelectionAction({
    icon: Icon,
    label,
    iconOnly = false,
    className,
    ...props
}: {
    icon: LucideIcon;
    label: string;
    /* Never show the label, only the icon and its tooltip. */
    iconOnly?: boolean;
} & Omit<ComponentProps<'button'>, 'children'>) {
    return (
        <button
            type="button"
            aria-label={label}
            title={label}
            className={cn(
                'flex h-10 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm font-semibold transition-colors outline-none hover:bg-secondary-foreground/10 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-secondary-foreground disabled:cursor-default disabled:opacity-40 aria-expanded:bg-secondary-foreground/10 xl:px-3',
                className,
            )}
            {...props}
        >
            <Icon className="size-[18px] shrink-0" strokeWidth={2} aria-hidden="true" />
            {!iconOnly && <span className="max-xl:sr-only">{label}</span>}
        </button>
    );
}

/* A column label that sorts by it; the active one is ink and carries its direction. */
export function SortButton({
    label,
    active,
    ascending,
    align = 'start',
    onClick,
}: {
    label: string;
    active: boolean;
    ascending: boolean;
    align?: 'start' | 'end';
    onClick: () => void;
}) {
    const Arrow = ascending ? ArrowUpIcon : ArrowDownIcon;
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'inline-flex cursor-pointer items-center gap-1 text-xs font-semibold hover:text-foreground',
                active ? 'text-foreground' : 'text-muted-foreground',
                align === 'end' && 'flex-row-reverse',
            )}
            aria-label={`Sort by ${label.toLowerCase()}`}
        >
            {label}
            {active && <Arrow className="size-3.5" aria-hidden="true" />}
        </button>
    );
}

/* A centred empty, error or waiting state: a quiet mark, a short title, one line, actions. */
export function EmptyState({
    icon: Icon,
    title,
    body,
    tone,
    children,
    className,
}: {
    icon?: LucideIcon;
    title: string;
    body?: ReactNode;
    tone?: 'danger';
    children?: ReactNode;
    className?: string;
}) {
    return (
        <div
            className={cn(
                'flex flex-col items-center gap-2 px-6 py-16 text-center sm:py-24',
                className,
            )}
        >
            {Icon && (
                <span
                    className={cn(
                        'mb-2 flex size-14 items-center justify-center rounded-full',
                        tone === 'danger'
                            ? 'bg-destructive-soft text-destructive'
                            : 'bg-accent text-accent-foreground',
                    )}
                >
                    <Icon className="size-6" strokeWidth={1.9} aria-hidden="true" />
                </span>
            )}
            <h2 className="text-xl font-bold tracking-[-0.01em] text-balance">{title}</h2>
            {body && (
                <p className="max-w-[25.2em] text-[15px] leading-snug text-muted-foreground">
                    {body}
                </p>
            )}
            {children && <div className="mt-3 flex flex-wrap justify-center gap-2">{children}</div>}
        </div>
    );
}

/* Placeholder rows while a list loads, shaped like the rows that will replace them. */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
    return (
        <output aria-label="Loading" className="flex flex-col">
            {Array.from({ length: rows }, (_, index) => (
                <div
                    key={index}
                    className="flex h-14 items-center gap-4 border-b border-rule pr-5 pl-5 sm:pr-8 sm:pl-8"
                >
                    <span className="size-9 shrink-0 animate-pulse rounded-[22%] bg-muted" />
                    <span
                        className="h-3 animate-pulse rounded-full bg-muted"
                        style={{ width: `${30 + ((index * 17) % 35)}%` }}
                    />
                </div>
            ))}
        </output>
    );
}

/* The quiet icon button rows end with: the same menu as a right-click, for people who never right-click. */
export function RowMenuButton(props: ComponentProps<typeof Button>) {
    return (
        <Button
            variant="ghost"
            size="icon"
            className="size-9 rounded-md text-muted-foreground hover:bg-card hover:text-foreground aria-expanded:bg-card"
            {...props}
        />
    );
}

import { TAG_PRESETS, type TagColour, type TagPreset } from '@hushos/drive/client';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { cn } from 'cn';
import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { OFFERED_COLOURS, swatchProps, TAG_COLOUR_LABEL } from '@/lib/tags';

/* A tag's colour as a square, whichever way it was chosen. */
export function Swatch({ colour, className }: { colour: TagColour | null; className?: string }) {
    const swatch = swatchProps(colour);
    return (
        <span
            aria-hidden="true"
            className={cn('shrink-0', swatch.className, className)}
            style={swatch.style}
        />
    );
}

/*
 * The offered presets as round swatches and one of your own: the last swatch opens,
 * beneath the row, a square for saturation and brightness, a hue strip, and the
 * hex, all three the same colour. Dragging previews; letting go, or Enter in the
 * field, is what chooses. A caption names what is chosen.
 */
/* Where Custom starts: the plum the presets leave out. */
const FIRST_CUSTOM = '#7c5cbf' as TagColour;

export function TagColourPicker({
    value,
    onChange,
    disabled = false,
    className,
}: {
    value: TagColour;
    onChange: (colour: TagColour) => void;
    disabled?: boolean;
    className?: string;
}) {
    const id = useId();
    const custom = !(TAG_PRESETS as readonly string[]).includes(value);
    const [open, setOpen] = useState(custom);
    const ring = (on: boolean) =>
        cn(
            'relative flex size-9 cursor-pointer items-center justify-center rounded-full border-2 outline-none has-focus-visible:outline-2 has-focus-visible:outline-offset-1 has-focus-visible:outline-ring has-disabled:cursor-not-allowed has-disabled:opacity-50',
            on ? 'border-foreground' : 'border-transparent hover:border-rule',
        );
    return (
        <fieldset
            aria-label="Colour"
            disabled={disabled}
            className={cn('m-0 flex min-w-0 flex-col gap-2 border-0 p-0', className)}
        >
            <div className="flex items-center gap-1">
                {OFFERED_COLOURS.map((preset) => (
                    <label
                        key={preset}
                        title={TAG_COLOUR_LABEL[preset]}
                        className={ring(value === preset)}
                    >
                        <input
                            type="radio"
                            name={id}
                            value={preset}
                            aria-label={TAG_COLOUR_LABEL[preset]}
                            checked={value === preset}
                            onChange={() => {
                                setOpen(false);
                                onChange(preset);
                            }}
                            className="absolute inset-0 size-full cursor-pointer appearance-none rounded-full"
                        />
                        <span className="pointer-events-none flex size-6 items-center justify-center rounded-full">
                            <Swatch colour={preset} className="absolute size-6 rounded-full" />
                            {value === preset && (
                                <CheckIcon
                                    className="relative size-3.5 text-white"
                                    strokeWidth={3}
                                    aria-hidden="true"
                                />
                            )}
                        </span>
                    </label>
                ))}
                <label title="Custom colour" className={ring(custom)}>
                    <input
                        type="radio"
                        name={id}
                        value="custom"
                        aria-label="Custom colour"
                        checked={custom}
                        onChange={() => {
                            // Choosing Custom chooses a colour at once; the square then refines it.
                            setOpen(true);
                            if (!custom) onChange(FIRST_CUSTOM);
                        }}
                        onClick={() => setOpen(true)}
                        className="absolute inset-0 size-full cursor-pointer appearance-none rounded-full"
                    />
                    <span
                        aria-hidden="true"
                        className="pointer-events-none size-6 rounded-full"
                        style={{
                            background: custom
                                ? value
                                : 'conic-gradient(#b4503b, #c9962b, #23766d, #4a64c8, #7c5cbf, #b4503b)',
                        }}
                    />
                </label>
            </div>
            <span className="text-[13px] text-muted-foreground">
                {custom
                    ? `Custom colour · ${value.toUpperCase()}`
                    : (TAG_COLOUR_LABEL[value as TagPreset] ?? '')}
            </span>
            {open && (
                <div className="border-t border-rule pt-3">
                    <CustomColour
                        key={custom ? 'custom' : 'preset'}
                        value={custom ? value : FIRST_CUSTOM}
                        disabled={disabled}
                        onChoose={(hex) => onChange(hex)}
                    />
                </div>
            )}
        </fieldset>
    );
}

type Hsv = { h: number; s: number; v: number };

function hexToHsv(hex: string): Hsv {
    const n = Number.parseInt(hex.slice(1), 16);
    const r = ((n >> 16) & 255) / 255;
    const g = ((n >> 8) & 255) / 255;
    const b = (n & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d > 0) {
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
    }
    return { h, s: max === 0 ? 0 : d / max, v: max };
}
function hsvToHex({ h, s, v }: Hsv) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    const [r, g, b] =
        h < 60
            ? [c, x, 0]
            : h < 120
              ? [x, c, 0]
              : h < 180
                ? [0, c, x]
                : h < 240
                  ? [0, x, c]
                  : h < 300
                    ? [x, 0, c]
                    : [c, 0, x];
    const to = (value: number) =>
        Math.round((value + m) * 255)
            .toString(16)
            .padStart(2, '0');
    return `#${to(r)}${to(g)}${to(b)}`;
}
const clamp = (value: number) => Math.min(1, Math.max(0, value));

function CustomColour({
    value,
    disabled,
    onChoose,
}: {
    value: string;
    disabled: boolean;
    onChoose: (hex: TagColour) => void;
}) {
    const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value));
    const [typed, setTyped] = useState(value);
    const hex = hsvToHex(hsv);
    const commit = (next: Hsv) => {
        setHsv(next);
        setTyped(hsvToHex(next));
        onChoose(hsvToHex(next) as TagColour);
    };
    /* A press anywhere on a surface sets it; a drag keeps setting; the release chooses. */
    function surface(update: (x: number, y: number) => Hsv) {
        return {
            onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
                if (disabled) return;
                const target = event.currentTarget;
                target.setPointerCapture(event.pointerId);
                const at = (e: { clientX: number; clientY: number }) => {
                    const rect = target.getBoundingClientRect();
                    return update(
                        clamp((e.clientX - rect.left) / rect.width),
                        clamp((e.clientY - rect.top) / rect.height),
                    );
                };
                const next = at(event);
                setHsv(next);
                setTyped(hsvToHex(next));
                const move = (e: globalThis.PointerEvent) => {
                    const moved = at(e);
                    setHsv(moved);
                    setTyped(hsvToHex(moved));
                };
                const up = (e: globalThis.PointerEvent) => {
                    target.removeEventListener('pointermove', move);
                    target.removeEventListener('pointerup', up);
                    target.removeEventListener('pointercancel', up);
                    commit(at(e));
                };
                target.addEventListener('pointermove', move);
                target.addEventListener('pointerup', up);
                target.addEventListener('pointercancel', up);
            },
        };
    }
    function keys(event: KeyboardEvent<HTMLDivElement>, axis: 'hue' | 'area') {
        const step = event.shiftKey ? 0.1 : 0.02;
        let next: Hsv | null = null;
        if (axis === 'hue') {
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp')
                next = { ...hsv, h: (hsv.h + step * 360) % 360 };
            if (event.key === 'ArrowLeft' || event.key === 'ArrowDown')
                next = { ...hsv, h: (hsv.h - step * 360 + 360) % 360 };
        } else {
            if (event.key === 'ArrowRight') next = { ...hsv, s: clamp(hsv.s + step) };
            if (event.key === 'ArrowLeft') next = { ...hsv, s: clamp(hsv.s - step) };
            if (event.key === 'ArrowUp') next = { ...hsv, v: clamp(hsv.v + step) };
            if (event.key === 'ArrowDown') next = { ...hsv, v: clamp(hsv.v - step) };
        }
        if (!next) return;
        event.preventDefault();
        commit(next);
    }
    const pure = hsvToHex({ h: hsv.h, s: 1, v: 1 });
    return (
        <div className="flex flex-col gap-3">
            {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- no form control has two axes, and the hue strip is drawn and driven the same way */}
            <div
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-label="Saturation and brightness"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(hsv.v * 100)}
                aria-valuetext={`${Math.round(hsv.s * 100)}% saturation, ${Math.round(hsv.v * 100)}% brightness`}
                onKeyDown={(event) => keys(event, 'area')}
                {...surface((x, y) => ({ ...hsv, s: x, v: 1 - y }))}
                className="relative h-32 w-full cursor-crosshair touch-none rounded-md outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                style={{
                    backgroundImage: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pure})`,
                }}
            >
                <span
                    aria-hidden="true"
                    className="absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md"
                    style={{
                        left: `${hsv.s * 100}%`,
                        top: `${(1 - hsv.v) * 100}%`,
                        background: hex,
                    }}
                />
            </div>
            <div
                role="slider"
                tabIndex={disabled ? -1 : 0}
                aria-label="Hue"
                aria-valuemin={0}
                aria-valuemax={360}
                aria-valuenow={Math.round(hsv.h)}
                onKeyDown={(event) => keys(event, 'hue')}
                {...surface((x) => ({ ...hsv, h: x * 359.999 }))}
                className="relative h-3 w-full cursor-pointer touch-none rounded-full outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                style={{
                    backgroundImage:
                        'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
                }}
            >
                <span
                    aria-hidden="true"
                    className="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-md"
                    style={{ left: `${(hsv.h / 360) * 100}%` }}
                />
            </div>
            {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
            <label className="flex items-center gap-2">
                <Swatch colour={hex as TagColour} className="size-5 rounded-full" />
                <span className="text-[13px] font-semibold">Hex</span>
                <input
                    type="text"
                    aria-label="Hex colour"
                    value={typed}
                    disabled={disabled}
                    spellCheck={false}
                    autoComplete="off"
                    maxLength={7}
                    onChange={(event) => {
                        const next = event.target.value.startsWith('#')
                            ? event.target.value
                            : `#${event.target.value}`;
                        setTyped(next);
                        if (/^#[0-9a-f]{6}$/i.test(next)) setHsv(hexToHsv(next.toLowerCase()));
                    }}
                    onBlur={() => {
                        if (/^#[0-9a-f]{6}$/i.test(typed)) commit(hexToHsv(typed.toLowerCase()));
                        else setTyped(hex);
                    }}
                    onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                            event.preventDefault();
                            if (/^#[0-9a-f]{6}$/i.test(typed))
                                commit(hexToHsv(typed.toLowerCase()));
                        }
                    }}
                    className="h-9 w-28 min-w-0 rounded-md border border-input bg-card px-2.5 font-mono text-base outline-none sm:text-sm focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-ring"
                />
            </label>
        </div>
    );
}

/*
 * A tag's colour as one compact button beside a name field: it shows the colour,
 * and opens the presets and the custom picker in a small card.
 */
export function TagColourButton({
    value,
    onChange,
    disabled = false,
}: {
    value: TagColour;
    onChange: (colour: TagColour) => void;
    disabled?: boolean;
}) {
    const [open, setOpen] = useState(false);
    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger
                aria-label="Colour for the new tag"
                title="Colour"
                disabled={disabled}
                className="flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-card px-2.5 outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default disabled:opacity-60 pointer-coarse:h-11"
            >
                <Swatch colour={value} className="size-[18px] rounded-full" />
                <ChevronDownIcon className="size-4 text-muted-foreground" aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent align="start" className="flex w-[292px] flex-col gap-3 p-4">
                <span className="text-sm font-bold">Colour</span>
                <TagColourPicker
                    value={value}
                    onChange={(colour) => {
                        onChange(colour);
                        if ((TAG_PRESETS as readonly string[]).includes(colour)) setOpen(false);
                    }}
                />
            </PopoverContent>
        </Popover>
    );
}

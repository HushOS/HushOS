import { TAG_PRESETS, type TagColour } from '@hushos/drive/client';
import { cn } from 'cn';
import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { swatchProps, TAG_COLOUR_LABEL } from '@/lib/tags';

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
 * The five presets and one of your own. The last square opens, beside it, a
 * small picker drawn the way the rest is: a square for saturation and
 * brightness, a hue strip, and the hex, all three the same colour. Dragging
 * previews; letting go, or Enter in the field, is what chooses. Nothing
 * around the row moves while it is open.
 */
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
    const [open, setOpen] = useState(false);
    const cell =
        'relative flex size-7 cursor-pointer items-center justify-center rounded-xs border border-transparent outline-none hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring has-focus-visible:outline-2 has-focus-visible:-outline-offset-2 has-focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 has-disabled:cursor-not-allowed has-disabled:opacity-50';
    return (
        <fieldset
            aria-label="Colour"
            disabled={disabled}
            className={cn('m-0 flex items-center gap-1 border-0 p-0', className)}
        >
            {TAG_PRESETS.map((preset) => (
                <label
                    key={preset}
                    title={TAG_COLOUR_LABEL[preset]}
                    className={cn(cell, value === preset && 'border-input bg-muted')}
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
                        className="absolute inset-0 size-full cursor-pointer appearance-none opacity-0"
                    />
                    <Swatch colour={preset} className="size-3 rounded-full" />
                </label>
            ))}
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger
                    title="Custom colour"
                    aria-label="Custom colour"
                    disabled={disabled}
                    className={cn(cell, (custom || open) && 'border-input bg-muted')}
                >
                    <span
                        aria-hidden="true"
                        className={cn(
                            'size-3 shrink-0 rounded-full',
                            !custom && 'border border-dashed border-muted-foreground',
                        )}
                        style={custom ? { backgroundColor: value } : undefined}
                    />
                </PopoverTrigger>
                <PopoverContent aria-label="Custom colour" className="w-56">
                    <CustomColour
                        value={custom ? value : '#3b6acc'}
                        disabled={disabled}
                        onChoose={(hex) => onChange(hex)}
                    />
                </PopoverContent>
            </Popover>
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
        <div className="flex flex-col gap-2">
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
                className="relative h-28 w-full cursor-crosshair touch-none rounded-xs border border-input outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                style={{
                    backgroundImage: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${pure})`,
                }}
            >
                <span
                    aria-hidden="true"
                    className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_var(--ink)]"
                    style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
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
                className="relative h-3 w-full cursor-crosshair touch-none rounded-xs border border-input outline-none select-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                style={{
                    backgroundImage:
                        'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
                }}
            >
                <span
                    aria-hidden="true"
                    className="absolute top-1/2 h-4 w-1.5 -translate-x-1/2 -translate-y-1/2 border border-white bg-transparent shadow-[0_0_0_1px_var(--ink)]"
                    style={{ left: `${(hsv.h / 360) * 100}%` }}
                />
            </div>
            {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
            <label className="flex items-center gap-2">
                <Swatch
                    colour={hex as TagColour}
                    className="size-4 rounded-full border border-input"
                />
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
                    className="h-8 w-24 min-w-0 rounded-md border border-input bg-card px-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
                />
            </label>
        </div>
    );
}

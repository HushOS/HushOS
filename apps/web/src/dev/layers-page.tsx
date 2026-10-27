import { cn } from 'cn';
import { useDialKit } from 'dialkit';
import { useCallback, useEffect, useState } from 'react';

import { Segmented } from '@/components/settings';
import { Demo } from '@/dev/demo';
import { HAIRLINES, LAYERS, lookStyle, RADII, SHADOWS, type Layer, type Look } from '@/dev/layers';
import { usePlayground } from '@/dev/playground-state';

/*
 * The layers, live: stacked as they sit in the app, or tilted apart so each one shows, with
 * its tokens in a table and a section per layer with a DialKit panel for its shadow,
 * hairline and radius. All of it comes from LAYERS (layers.ts).
 */

function pick<T extends string>(options: readonly T[], value: string, fallback: T): T {
    return options.find((option) => option === value) ?? fallback;
}

/* One layer's DialKit panel; it draws nothing and hands its values up. */
function LayerDials({
    layer,
    onChange,
}: {
    layer: Layer;
    onChange: (id: string, look: Look) => void;
}) {
    const dial = useDialKit(
        `Layer: ${layer.name}`,
        {
            shadow: { type: 'select', options: [...SHADOWS], default: layer.shadow },
            hairline: { type: 'select', options: [...HAIRLINES], default: layer.hairline },
            radius: { type: 'select', options: [...RADII], default: layer.radius },
        },
        { id: `layer-${layer.id}`, defaultCollapsed: true },
    );
    const shadow = pick(SHADOWS, dial.shadow, layer.shadow);
    const hairline = pick(HAIRLINES, dial.hairline, layer.hairline);
    const radius = pick(RADII, dial.radius, layer.radius);
    useEffect(
        () => onChange(layer.id, { shadow, hairline, radius }),
        [onChange, layer.id, shadow, hairline, radius],
    );
    return null;
}

/* How dark each elevation's shadow falls on the slab below, in the diagram. */
const CAST: Record<Look['shadow'], number> = { none: 0, sm: 0.03, md: 0.05, lg: 0.07, xl: 0.09 };

/*
 * The layers as slabs: tilted, each floats at its own height (translateZ under
 * preserve-3d) and the ones with a shadow cast it on the slab below; flat, they stand in a
 * column, top layer first. Each slab paints its layer's surface, hairline, radius and
 * shadow; its name sits beside it, in its plane, so it follows the tilt.
 */
function Stack({ looks, tilted }: { looks: Record<string, Look>; tilted: boolean }) {
    const { scheme } = usePlayground();
    const contrast = scheme.endsWith('-hc');
    const middle = (LAYERS.length - 1) / 2;
    const motion =
        'transition-[transform,height,opacity] duration-700 ease-out-expo motion-reduce:transition-none';
    return (
        <figure
            className="m-0 overflow-hidden rounded-2xl border border-(--pg-ground-edge) bg-(--pg-ground) px-4 py-8 sm:py-12"
            style={{ perspective: 2400 }}
        >
            <div
                className={cn(
                    'relative mx-auto h-[400px] max-w-xl [--gap:8px] [--h:104px] [--hf:46px] [--lift:30px] [--w:160px] sm:h-[520px] sm:[--gap:10px] sm:[--h:150px] sm:[--hf:62px] sm:[--lift:54px] sm:[--w:240px]',
                    motion,
                )}
                style={{
                    transformStyle: 'preserve-3d',
                    transform: tilted ? 'rotateX(58deg) rotateZ(-42deg)' : 'none',
                }}
            >
                {LAYERS.map((layer, index) => {
                    const look = looks[layer.id] ?? layer;
                    const step = index - middle;
                    const place = tilted
                        ? `translateZ(calc(var(--lift) * ${step}))`
                        : `translateY(calc((var(--hf) + var(--gap)) * ${-step}))`;
                    const below = looks[LAYERS[index - 1]?.id ?? ''] ?? LAYERS[index - 1];
                    return (
                        <div key={layer.id} className="contents">
                            {/* The shadow it casts, drawn on the plane just above the slab below. */}
                            {index > 0 && below && (
                                <div
                                    aria-hidden="true"
                                    className={cn(
                                        'absolute top-1/2 left-[calc(50%+3rem)] rounded-2xl blur-lg',
                                        motion,
                                    )}
                                    style={{
                                        width: 'var(--w)',
                                        height: 'var(--h)',
                                        background: '#000',
                                        opacity:
                                            tilted && !contrast
                                                ? CAST[look.shadow] * (scheme === 'dark' ? 2.4 : 1)
                                                : 0,
                                        transform: `translate(-50%, -50%) translateZ(calc(var(--lift) * ${step - 1} + 1px)) translate(10px, 10px)`,
                                    }}
                                />
                            )}
                            <div
                                className={cn('absolute top-1/2 left-[calc(50%+3rem)]', motion)}
                                style={{
                                    ...lookStyle(look, layer),
                                    // A slab with no hairline of its own still needs an edge on the ground.
                                    ...(look.hairline === 'none' && {
                                        outline: '1px solid var(--pg-ground-edge)',
                                    }),
                                    width: 'var(--w)',
                                    height: tilted ? 'var(--h)' : 'var(--hf)',
                                    transform: `translate(-50%, -50%) ${place}`,
                                }}
                            >
                                {/*
                                 * Tilted, the slab's top-left corner is its leftmost point on screen, so
                                 * the name hangs off that corner, out along the diagonal, which the tilt
                                 * lays level. Beside the left edge it would drop to the slab below.
                                 */}
                                <span
                                    className={cn(
                                        'absolute text-[13px] font-semibold whitespace-nowrap text-foreground sm:text-sm',
                                        tilted
                                            ? 'top-0 left-0 [transform:translate(-50%,-50%)_translate(-44px,-40px)]'
                                            : 'top-1/2 right-[calc(100%+24px)] -translate-y-1/2',
                                    )}
                                >
                                    {layer.short}
                                </span>
                            </div>
                        </div>
                    );
                })}
            </div>
        </figure>
    );
}

const radiusPx: Record<Look['radius'], string> = {
    none: '0',
    chip: '6px',
    control: '10px',
    card: '16px',
    sheet: '20px',
};

function TokenTable({ looks }: { looks: Record<string, Look> }) {
    const token = 'py-3 pr-6 align-top font-mono text-[12.5px] whitespace-nowrap';
    return (
        <div className="relative overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-[13px]">
                <thead>
                    <tr className="border-b border-rule text-muted-foreground">
                        <th className="py-2.5 pr-6 font-medium">Layer</th>
                        <th className="py-2.5 pr-6 font-medium">Surface</th>
                        <th className="py-2.5 pr-6 font-medium">Shadow</th>
                        <th className="py-2.5 pr-6 font-medium">Hairline</th>
                        <th className="py-2.5 pr-6 font-medium">Radius</th>
                        <th className="w-full py-2.5 font-medium">Motion</th>
                    </tr>
                </thead>
                <tbody>
                    {LAYERS.map((layer) => {
                        const look = looks[layer.id] ?? layer;
                        const cell = (key: keyof Look, text: string) => {
                            const changed = look[key] !== layer[key];
                            return (
                                <td className={cn(token, changed && 'font-bold text-primary')}>
                                    {text}
                                    {changed && (
                                        <span className="sr-only">
                                            {' '}
                                            (changed from {layer[key]})
                                        </span>
                                    )}
                                </td>
                            );
                        };
                        return (
                            <tr key={layer.id} className="border-b border-rule last:border-0">
                                <th
                                    scope="row"
                                    className="py-3 pr-6 align-top font-semibold whitespace-nowrap"
                                >
                                    {layer.name}
                                </th>
                                <td className={token}>{layer.surface}</td>
                                {cell(
                                    'shadow',
                                    look.shadow === 'none' ? 'none' : `elevation-${look.shadow}`,
                                )}
                                {cell('hairline', look.hairline)}
                                {cell(
                                    'radius',
                                    look.radius === 'none'
                                        ? '0'
                                        : `${look.radius} ${radiusPx[look.radius]}`,
                                )}
                                <td className="min-w-64 py-3 align-top text-pretty text-muted-foreground">
                                    {layer.motion}
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}

/* One layer on the warm ground, as it really draws, with what it's for and where. */
function Specimen({ layer, look }: { layer: Layer; look: Look }) {
    return (
        <article className="flex flex-col gap-3">
            <div className="rounded-2xl border border-(--pg-ground-edge) bg-(--pg-ground) p-6">
                <div
                    data-measure=""
                    className={cn(
                        'px-4 py-3.5 text-sm font-semibold',
                        layer.id !== 'toast' && 'h-20',
                    )}
                    style={lookStyle(look, layer)}
                >
                    {layer.name}
                </div>
            </div>
            <div className="flex flex-col gap-1">
                <h3 className="text-[15px] font-semibold">{layer.name}</h3>
                <p className="text-sm">{layer.use}</p>
                <p className="text-[13px] text-muted-foreground">{layer.source}</p>
                {layer.differs && <p className="text-[13px] text-warning">{layer.differs}</p>}
            </div>
        </article>
    );
}

export function LayersPage() {
    const [looks, setLooks] = useState<Record<string, Look>>({});
    const [view, setView] = useState<'flat' | 'tilted'>('tilted');
    const onChange = useCallback(
        (id: string, look: Look) => setLooks((current) => ({ ...current, [id]: look })),
        [],
    );
    return (
        <>
            {LAYERS.map((layer) => (
                <LayerDials key={layer.id} layer={layer} onChange={onChange} />
            ))}
            <section
                aria-labelledby="layers-title"
                className="flex flex-col gap-4 border-b border-rule px-5 py-8 sm:px-8"
            >
                <div className="flex flex-col gap-1">
                    <h2 id="layers-title" className="text-lg font-bold tracking-[-0.01em]">
                        Layers
                    </h2>
                    <p className="max-w-prose text-sm text-muted-foreground">
                        What HushOS stacks, bottom to top, each with its own shadow, hairline and
                        radius. In high contrast every shadow is none and the edge is a solid line.
                    </p>
                </div>
                <Stack looks={looks} tilted={view === 'tilted'} />
                <div className="flex justify-center">
                    <Segmented
                        label="Stack"
                        options={[
                            { value: 'flat', label: 'Flat' },
                            { value: 'tilted', label: 'Tilted' },
                        ]}
                        value={view}
                        onChange={setView}
                    />
                </div>
                <TokenTable looks={looks} />
            </section>
            <Demo
                id="each-layer"
                title="Each layer"
                note="As it draws, on the warm ground. Where the code and DESIGN.md disagree, the line under it says so."
            >
                <div className="grid gap-x-6 gap-y-8 sm:grid-cols-2 xl:grid-cols-3">
                    {LAYERS.map((layer) => (
                        <Specimen key={layer.id} layer={layer} look={looks[layer.id] ?? layer} />
                    ))}
                </div>
            </Demo>
        </>
    );
}

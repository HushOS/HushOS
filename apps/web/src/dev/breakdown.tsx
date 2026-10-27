import { useState, type ReactNode } from 'react';

import { Segmented } from '@/components/settings';
import { MeasureOverlay } from '@/dev/measure-overlay';

/*
 * A design breakdown: one demo large in a rounded frame on the warm ground, Measure always
 * drawn over it, and a segmented switch under it between two versions (Box | Text,
 * Geometric | Optical). The demo animates between them with CSS transitions, and the
 * overlay follows frame by frame. Mark the demo's reference edge `data-measure-heading`
 * and what to measure `data-measure`; `scale` is how much larger than life it's drawn.
 */
export function Breakdown<T extends string>({
    id,
    title,
    note,
    options,
    mode,
    scale = 1,
    children,
}: {
    id: string;
    title: string;
    note: ReactNode;
    options: readonly [{ value: T; label: string }, { value: T; label: string }];
    /* What the overlay draws: see MeasureOverlay. */
    mode: 'align' | 'padding';
    scale?: number;
    children: (version: T) => ReactNode;
}) {
    const [version, setVersion] = useState<T>(options[1].value);
    const [frame, setFrame] = useState<HTMLElement | null>(null);
    return (
        <section
            id={id}
            aria-labelledby={`${id}-title`}
            className="flex scroll-mt-20 flex-col gap-4 border-b border-rule px-5 py-8 sm:px-8"
        >
            <div className="flex flex-col gap-1">
                <h2 id={`${id}-title`} className="text-lg font-bold tracking-[-0.01em]">
                    {title}
                </h2>
                <p className="max-w-prose text-sm text-muted-foreground">{note}</p>
            </div>
            <figure
                ref={setFrame}
                className="relative m-0 flex min-h-72 items-center justify-center overflow-hidden rounded-2xl border border-(--pg-ground-edge) bg-(--pg-ground) px-6 py-14 sm:min-h-80 sm:px-12"
            >
                <div data-measure-area="" data-measure-mode={mode} data-measure-scale={scale}>
                    {children(version)}
                </div>
                <MeasureOverlay root={frame} />
            </figure>
            <div className="flex justify-center">
                <Segmented label={title} options={options} value={version} onChange={setVersion} />
            </div>
        </section>
    );
}

import { cn } from 'cn';
import { useState, type ComponentProps, type ReactNode } from 'react';

import { MeasureOverlay } from '@/dev/measure-overlay';
import { usePlayground } from '@/dev/playground-state';

/*
 * One component's section: a real heading, a line on what it's for, then its samples.
 * The measuring overlay draws over the samples and the heading's edge.
 */
export function Demo({
    id,
    title,
    note,
    children,
    className,
}: {
    id: string;
    title: string;
    note?: ReactNode;
    children: ReactNode;
    className?: string;
}) {
    const [root, setRoot] = useState<HTMLElement | null>(null);
    const { measure } = usePlayground();
    return (
        <section
            ref={setRoot}
            id={id}
            aria-labelledby={`${id}-title`}
            className="relative flex scroll-mt-20 flex-col gap-4 border-b border-rule px-5 py-8 sm:px-8"
        >
            <div className="flex flex-col gap-1">
                <h2
                    id={`${id}-title`}
                    data-measure-heading=""
                    className="w-fit text-lg font-bold tracking-[-0.01em]"
                >
                    {title}
                </h2>
                {note && <p className="max-w-prose text-sm text-muted-foreground">{note}</p>}
            </div>
            <div data-measure-area="" className={cn('flex flex-col gap-6', className)}>
                {children}
            </div>
            {measure && <MeasureOverlay root={root} />}
        </section>
    );
}

/* A row of samples with a caption under each: variants, sizes or states. */
export function Row({ label, children }: { label?: string; children: ReactNode }) {
    return (
        <div className="flex flex-col gap-2">
            {label && <h3 className="text-sm font-semibold">{label}</h3>}
            <div className="flex flex-wrap items-end gap-x-5 gap-y-4">{children}</div>
        </div>
    );
}

export function Sample({
    caption,
    force,
    children,
    className,
}: {
    caption: string;
    force?: string;
    children: ReactNode;
    className?: string;
}) {
    return (
        <figure className="m-0 flex flex-col items-start gap-1.5">
            <div data-force={force} className={className}>
                {children}
            </div>
            <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
        </figure>
    );
}

export type State = 'rest' | 'hover' | 'focus' | 'disabled' | 'busy' | 'invalid';
export type StateProps = {
    state: State;
    disabled: boolean;
    'aria-invalid': true | undefined;
    'aria-busy': true | undefined;
};

const CAPTIONS: Record<State, string> = {
    rest: 'Rest',
    hover: 'Hover',
    focus: 'Focus visible',
    disabled: 'Disabled',
    busy: 'Busy',
    invalid: 'Invalid',
};

/*
 * The same component in each state. Hover and focus are forced through `data-force`
 * (pseudo-states.ts); the rest are the component's own props and attributes.
 */
export function States({
    states,
    children,
}: {
    states: readonly State[];
    children: (props: StateProps) => ReactNode;
}) {
    const { states: shown } = usePlayground();
    if (!shown) return null;
    return (
        <Row label="States">
            {states.map((state) => (
                <Sample
                    key={state}
                    caption={CAPTIONS[state]}
                    force={state === 'hover' ? 'hover' : state === 'focus' ? 'focus' : undefined}
                >
                    {children({
                        state,
                        disabled: state === 'disabled' || state === 'busy',
                        'aria-invalid': state === 'invalid' ? true : undefined,
                        'aria-busy': state === 'busy' ? true : undefined,
                    })}
                </Sample>
            ))}
        </Row>
    );
}

/*
 * The app's page sheet (routes/_authenticated/app/route.tsx): the surface panel, its card
 * radius and rule hairline. App pieces bring their own 20px/32px gutters, as they do on the
 * sheet, so inside this frame they sit at the same widths as everything else on the page.
 */
export function SheetFrame({ className, ...props }: ComponentProps<'div'>) {
    return (
        <div
            data-sheet-frame=""
            className={cn('overflow-hidden rounded-xl border border-rule bg-card', className)}
            {...props}
        />
    );
}

/* What a panel's values are as CSS, for the tuned sample. */
export const pxs = (value: number) => `${value}px`;

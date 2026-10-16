import { cn } from 'cn';
import { LockIcon, LockOpenIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DitherAvatar } from '@/components/dither-kit/avatar';
import { randomGlyph } from '@/components/scramble';

/*
 * The home page's "How it works": the steps on the right, and on a wide screen
 * one file on the left that follows them as they scroll past. It is locked on
 * your laptop, arrives at our end as noise (only its rough size readable), is
 * opened again on someone's phone, and the last step shows the recovery kit.
 * The figure is decoration over the steps' own words, so it is hidden from
 * screen readers and from narrow screens, and it sits still with reduced motion.
 */

type Step = { title: string; body: string };

export function LockStory({ steps, children }: { steps: Step[]; children: ReactNode }) {
    const [active, setActive] = useState(0);
    const items = useRef<(HTMLLIElement | null)[]>([]);

    useEffect(() => {
        // The step crossing the middle of the window is the one being read.
        const observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const index = items.current.indexOf(entry.target as HTMLLIElement);
                    if (index >= 0) setActive(index);
                }
            },
            { rootMargin: '-50% 0px -50% 0px' },
        );
        for (const item of items.current) if (item) observer.observe(item);
        return () => observer.disconnect();
    }, []);

    return (
        <div className="grid gap-8 lg:grid-cols-[5fr_7fr] lg:gap-16">
            <div className="flex flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
                {children}
                <LockFigure step={active} />
            </div>
            <ol className="flex flex-col">
                {steps.map((step, index) => (
                    <li
                        key={step.title}
                        ref={(element) => {
                            items.current[index] = element;
                        }}
                        className="grid grid-cols-[28px_1fr] gap-x-5 border-b border-rule py-5 first:pt-0 last:border-b-0 lg:grid-cols-[36px_1fr] lg:py-14 lg:first:pt-6"
                    >
                        <span
                            className={cn(
                                'pt-0.5 text-lg font-bold tabular-nums transition-colors duration-300',
                                'text-muted-foreground',
                                active === index && 'lg:text-primary',
                            )}
                        >
                            {index + 1}
                        </span>
                        <span className="flex flex-col gap-1">
                            <span
                                className={cn(
                                    'text-lg font-bold transition-colors duration-300 lg:text-xl',
                                    active !== index && 'lg:text-muted-foreground',
                                )}
                            >
                                {step.title}
                            </span>
                            <span className="text-base leading-[1.6] text-pretty text-muted-foreground">
                                {step.body}
                            </span>
                        </span>
                    </li>
                ))}
            </ol>
        </div>
    );
}

const NAME = 'Flat lease.pdf';

/* A string of random characters as long as the one it hides. */
const noise = (length: number) => Array.from({ length }, randomGlyph).join('');

function useNoise(on: boolean) {
    const [tick, setTick] = useState(0);
    useEffect(() => {
        // The figure shows only on wide screens; elsewhere the noise would re-render for nothing.
        if (!on || !window.matchMedia('(min-width: 1024px)').matches) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        const timer = window.setInterval(() => setTick((value) => value + 1), 110);
        return () => window.clearInterval(timer);
    }, [on]);
    return tick;
}

const captions = [
    'On your laptop',
    'What reaches us',
    'On Sam’s phone',
    'Saved when you signed up',
];

function LockFigure({ step }: { step: number }) {
    // Re-rendered on each tick while the file is at our end, so the noise keeps moving.
    useNoise(step === 1);
    return (
        <div
            aria-hidden="true"
            className="mt-8 hidden aspect-[5/4] max-w-[440px] flex-col rounded-xl border border-rule bg-[var(--id-raised,var(--card))] p-6 shadow-md lg:flex"
        >
            <p className="flex items-center justify-between text-sm font-semibold text-muted-foreground">
                <span key={step} className="animate-in fade-in duration-300">
                    {captions[step]}
                </span>
                <span className="font-mono text-xs tabular-nums">{step + 1} / 4</span>
            </p>
            <div
                key={step}
                className="flex flex-1 animate-in items-center justify-center duration-500 fade-in slide-in-from-bottom-2"
            >
                {step === 3 ? <Kit /> : <Sheet step={step} />}
            </div>
        </div>
    );
}

/* The file: a page with a turned corner, readable or not. */
function Sheet({ step }: { step: number }) {
    const locked = step === 1;
    return (
        <div className="flex flex-col items-center gap-4">
            <div className="relative h-44 w-36 bg-[var(--id-quiet,var(--muted))] [clip-path:polygon(0_0,76%_0,100%_17%,100%_100%,0_100%)]">
                <div className="absolute top-0 right-0 size-[24%] bg-rule [aspect-ratio:1] [clip-path:polygon(0_0,100%_100%,0_100%)]" />
                {locked ? (
                    <p className="p-3 pt-9 font-mono text-[9px] leading-[1.35] break-all text-[var(--id-cipher,var(--primary))]">
                        {noise(190)}
                    </p>
                ) : (
                    <div className="flex flex-col gap-2 p-4 pt-10">
                        {[92, 78, 86, 60, 88, 70, 44].map((width, index) => (
                            <span
                                key={index}
                                className="h-1.5 rounded-full bg-muted-foreground/35"
                                style={{ width: `${width}%` }}
                            />
                        ))}
                    </div>
                )}
            </div>
            <div className="flex flex-col items-center gap-1.5">
                <span
                    className={cn(
                        'text-base font-semibold',
                        locked && 'font-mono text-[var(--id-cipher,var(--primary))]',
                    )}
                >
                    {locked ? noise(NAME.length) : NAME}
                </span>
                <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    {step === 0 && (
                        <>
                            <LockIcon className="size-3.5" strokeWidth={2.4} />
                            Locked before it leaves
                        </>
                    )}
                    {step === 1 && 'Scrambled, name included. Roughly 1.2 MB.'}
                    {step === 2 && (
                        <>
                            <span className="mr-1 flex -space-x-1.5">
                                <DitherAvatar
                                    name="You"
                                    size={22}
                                    animate
                                    className="rounded-full ring-2 ring-[var(--id-raised,var(--card))]"
                                />
                                <DitherAvatar
                                    name="Sam"
                                    size={22}
                                    animate
                                    className="rounded-full ring-2 ring-[var(--id-raised,var(--card))]"
                                />
                            </span>
                            <LockOpenIcon className="size-3.5" strokeWidth={2.4} />
                            You and Sam can open it
                        </>
                    )}
                </span>
            </div>
        </div>
    );
}

/* The recovery kit: twenty-four words, drawn as blanks. */
function Kit() {
    return (
        <div className="grid w-full max-w-[340px] grid-cols-3 gap-x-4 gap-y-2.5">
            {Array.from({ length: 24 }, (_, index) => (
                <span key={index} className="flex items-center gap-2">
                    <span className="w-4 text-right font-mono text-[10px] text-muted-foreground tabular-nums">
                        {index + 1}
                    </span>
                    <span
                        className="h-2 rounded-full bg-muted-foreground/30"
                        style={{ width: `${40 + ((index * 37) % 45)}%` }}
                    />
                </span>
            ))}
        </div>
    );
}

import { cn } from 'cn';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { TextLink } from '@/components/site';
import { formatQuota } from '@/lib/format';

/*
 * Pricing's "What will you keep?": three sliders for the things people actually
 * store, a rough total, and the smallest plan it fits in, with a bar of dots
 * showing how full that plan would be. The sizes are typical, not measured, and
 * the page says so; the plans and their sizes are the catalogue's own. A plan
 * fits with a tenth to spare, because versions, Trash and thumbnails count too.
 * The plan it names carries its own button, the one its card on the page has.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

/* Typical sizes: a phone photo, an hour of 1080p video, a PDF or document. */
const PHOTO = 3 * MB;
const VIDEO_HOUR = 4 * GB;
const DOCUMENT = 0.5 * MB;
const HEADROOM = 0.9;

export type FitPlan = {
    key: string;
    name: string;
    quotaBytes: number;
    action?: ReactNode;
    /* What the button charges, beside it, since the planner shows no prices of its own. */
    note?: string;
};

const count = new Intl.NumberFormat('en-GB');

/*
 * An estimate's size, as round as an estimate should be: whole GB from 10 GB, one
 * decimal below that (1000 MB reads as 1 GB), whole MB under it, TB from 1024 GB. Plan sizes keep
 * formatQuota, so "200 GB" reads as the plan cards do.
 */
function rough(bytes: number) {
    if (bytes >= 1024 * GB) return `${(bytes / (1024 * GB)).toFixed(1).replace(/\.0$/, '')} TB`;
    if (bytes >= 10 * GB) return `${Math.round(bytes / GB)} GB`;
    if (bytes >= 1000 * MB) return `${(bytes / GB).toFixed(1).replace(/\.0$/, '')} GB`;
    return `${Math.max(1, Math.round(bytes / MB))} MB`;
}

function Slider({
    label,
    value,
    max,
    step,
    unit,
    onChange,
}: {
    label: string;
    value: number;
    max: number;
    step: number;
    unit: (value: number) => string;
    onChange: (value: number) => void;
}) {
    const id = useId();
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-4 text-[15px]">
                <label htmlFor={id} className="font-semibold">
                    {label}
                </label>
                {/* Read through aria-valuetext; shown here for sight. */}
                <span aria-hidden="true" className="text-muted-foreground tabular-nums">
                    {unit(value)}
                </span>
            </div>
            <input
                id={id}
                type="range"
                min={0}
                max={max}
                step={step}
                value={value}
                aria-valuetext={unit(value)}
                onChange={(event) => onChange(Number(event.target.value))}
                className="fits-range w-full pointer-coarse:h-11"
            />
        </div>
    );
}

/* The plan as a bar of dots, filled column by column, as many lit as the share your files take. */
const DOTS = 120;

function Fill({ share }: { share: number }) {
    const lit = Math.min(DOTS, Math.max(share > 0 ? 1 : 0, Math.round(share * DOTS)));
    return (
        <div
            aria-hidden="true"
            className="grid auto-cols-fr grid-flow-col grid-rows-3 gap-0.5 sm:gap-1"
        >
            {Array.from({ length: DOTS }, (_, index) => (
                <span
                    key={index}
                    className={cn(
                        'aspect-square rounded-full transition-colors duration-300',
                        index < lit ? 'bg-primary' : 'fit-dot-off bg-foreground/12',
                    )}
                />
            ))}
        </div>
    );
}

/* The answer's button and, under it, what it charges. */
function PlanAction({ plan }: { plan: FitPlan }) {
    if (!plan.action) return null;
    return (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
            {plan.action}
            {plan.note && (
                <span className="text-sm text-muted-foreground tabular-nums">{plan.note}</span>
            )}
        </div>
    );
}

/* What a screen reader hears: the answer, once the sliders have been still for a moment. */
function useSettled(text: string) {
    const [settled, setSettled] = useState(text);
    useEffect(() => {
        const timer = window.setTimeout(() => setSettled(text), 600);
        return () => window.clearTimeout(timer);
    }, [text]);
    return settled;
}

export function FitPlanner({
    plans,
    error = null,
}: {
    plans: FitPlan[];
    /* A checkout that failed from here, shown only while the answer is still that plan. */
    error?: { key: string; message: string } | null;
}) {
    const [photos, setPhotos] = useState(8_000);
    const [hours, setHours] = useState(5);
    const [documents, setDocuments] = useState(2_000);
    const total = photos * PHOTO + hours * VIDEO_HOUR + documents * DOCUMENT;
    const sorted = [...plans].sort((a, b) => a.quotaBytes - b.quotaBytes);
    const fits = sorted.find((plan) => total <= plan.quotaBytes * HEADROOM);
    // Within a plan but past the headroom: it holds, with no room for versions and Trash.
    const tight = fits ? undefined : sorted.find((plan) => total <= plan.quotaBytes);
    const largest = sorted.at(-1);
    // en-GB on server and browser alike, as the counts are, so the numbers hydrate unchanged.
    const quota = (bytes: number) => formatQuota(bytes, 'en-GB');
    const amount = rough(total);
    const spoken = useSettled(
        !total
            ? 'Nothing yet.'
            : fits
              ? `About ${amount}. ${fits.name} fits, ${quota(fits.quotaBytes)}.`
              : tight
                ? `About ${amount}. Tight in ${tight.name}, ${quota(tight.quotaBytes)}.`
                : `About ${amount}. More than any plan holds.`,
    );
    return (
        <section aria-labelledby="fit-title" className="mt-20">
            <div className="grid gap-8 rounded-xl border border-rule bg-[var(--id-raised,var(--card))] p-5 sm:p-8 lg:grid-cols-[5fr_6fr] lg:gap-12">
                <div className="flex flex-col gap-6">
                    <div className="flex flex-col gap-2">
                        <h2
                            id="fit-title"
                            className="text-2xl font-extrabold tracking-[-0.02em] sm:text-[28px]"
                        >
                            What will you keep?
                        </h2>
                        <p className="text-[15px] leading-relaxed text-muted-foreground">
                            About 3 MB a photo, 4 GB an hour of 1080p video, 512 KB a document.
                            Yours will vary.
                        </p>
                    </div>
                    <Slider
                        label="Photos"
                        value={photos}
                        max={100_000}
                        step={500}
                        unit={(value) => count.format(value)}
                        onChange={setPhotos}
                    />
                    <Slider
                        label="Video"
                        value={hours}
                        max={200}
                        step={1}
                        unit={(value) => `${value} ${value === 1 ? 'hour' : 'hours'}`}
                        onChange={setHours}
                    />
                    <Slider
                        label="Documents"
                        value={documents}
                        max={50_000}
                        step={100}
                        unit={(value) => count.format(value)}
                        onChange={setDocuments}
                    />
                </div>
                <div className="flex flex-col justify-center gap-5">
                    {/* An output is a status region: read when it changes, not on every step. */}
                    <output className="sr-only">{spoken}</output>
                    <p className="text-[15px] text-muted-foreground">
                        {total ? (
                            <>
                                About{' '}
                                <span className="font-semibold text-foreground tabular-nums">
                                    {amount}
                                </span>{' '}
                                in all
                            </>
                        ) : (
                            'Nothing yet'
                        )}
                    </p>
                    {!total ? (
                        <p className="text-[28px] leading-tight font-extrabold tracking-[-0.025em] sm:text-[36px]">
                            Move a slider to start.
                        </p>
                    ) : fits ? (
                        <>
                            <p className="text-[28px] leading-tight font-extrabold tracking-[-0.025em] sm:text-[36px]">
                                {fits.name} fits.
                            </p>
                            <Fill share={total / fits.quotaBytes} />
                            <p className="text-[15px] text-muted-foreground tabular-nums">
                                {amount} of {quota(fits.quotaBytes)}, with room left for versions
                                and Trash.
                            </p>
                            <PlanAction plan={fits} />
                        </>
                    ) : tight ? (
                        <>
                            <p className="text-[28px] leading-tight font-extrabold tracking-[-0.025em] sm:text-[36px]">
                                Tight in {tight.name}.
                            </p>
                            <Fill share={total / tight.quotaBytes} />
                            <p className="text-[15px] text-muted-foreground tabular-nums">
                                {amount} of {quota(tight.quotaBytes)}, with little room left for
                                versions and Trash.
                            </p>
                            <PlanAction plan={tight} />
                        </>
                    ) : (
                        <>
                            <p className="text-[28px] leading-tight font-extrabold tracking-[-0.025em] sm:text-[36px]">
                                More than {largest ? quota(largest.quotaBytes) : 'any plan holds'}.
                            </p>
                            <p className="text-[15px] leading-relaxed text-muted-foreground">
                                Run HushOS on your own server and set each account’s storage
                                yourself.
                            </p>
                            <TextLink href="https://github.com/HushOS/HushOS/blob/main/docs/self-hosting.md">
                                Read the self-hosting guide
                            </TextLink>
                        </>
                    )}
                    {error && error.key === (fits ?? tight)?.key && (
                        <p
                            role="alert"
                            className="rounded-md bg-destructive-soft px-4 py-3 text-sm text-destructive"
                        >
                            {error.message}
                        </p>
                    )}
                </div>
            </div>
        </section>
    );
}

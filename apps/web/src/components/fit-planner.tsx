import { useQuery } from '@tanstack/react-query';
import { cn } from 'cn';
import { type ReactNode, useEffect, useId, useState } from 'react';
import {
    dotParts,
    familyNote,
    fitAnswer,
    keptWithin,
    slidersFor,
    totalOf,
    type FamilyPrice,
} from '@/components/fit-answer';
import { TalkToUs, TextLink } from '@/components/site';
import { formatQuota } from '@/lib/format';
import { salesContactQueryOptions } from '@/lib/social';

/*
 * Pricing's "What will you keep?": three sliders for the things people actually
 * store, a rough total, and the smallest plan it fits in, with a bar of dots
 * showing how full that plan would be. The sizes are typical, not measured, and
 * the page says so; the plans and their sizes are the catalogue's own. Where
 * family plans are offered, a fourth slider says how many people: one person is
 * answered with personal plans, two or more with family plans (fit-answer.ts).
 * The plan it names carries its own button, the one its card on the page has.
 */

const MB = 1024 * 1024;
const GB = 1024 * MB;

export type FitPlan = {
    key: string;
    name: string;
    quotaBytes: number;
    action?: ReactNode;
    /* What the button charges, beside it, since the planner shows no prices of its own. */
    note?: string;
};

/* A family plan: its note is worked out for the people chosen, from its own prices. */
export type FitFamilyPlan = Omit<FitPlan, 'note'> & {
    maxMembers: number;
    price: FamilyPrice;
};

/* What the people slider shows and a screen reader hears. */
const peopleWords = (value: number) => (value === 1 ? '1 person' : `${value} people`);

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

export function Slider({
    label,
    value,
    min = 0,
    max,
    step,
    unit,
    onChange,
}: {
    label: string;
    value: number;
    min?: number;
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
                min={min}
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

/*
 * The plan as a bar of dots, filled column by column, as many lit as the share your files take.
 * Several shares fill it one after another, each in its own look from `looks` (the family post's
 * storage view: everyone's own files, then the family folders); a dot no share reaches is off.
 */
const DOTS = 120;

export function Fill({
    shares,
    looks = ['bg-primary'],
}: {
    shares: readonly number[];
    looks?: readonly string[];
}) {
    const parts = dotParts(shares, DOTS);
    return (
        <div
            aria-hidden="true"
            className="grid auto-cols-fr grid-flow-col grid-rows-3 gap-0.5 sm:gap-1"
        >
            {parts.map((part, index) => (
                <span
                    key={index}
                    className={cn(
                        'aspect-square rounded-full transition-colors duration-300',
                        part === null ? 'fit-dot-off bg-foreground/12' : looks[part],
                    )}
                />
            ))}
        </div>
    );
}

/*
 * A plan card's size as a small block of the same dots, lit on a log scale from 2 GB (one dot)
 * to 4 TB (all but one), so each step up a plan reads as more without the small ones vanishing.
 * Decoration: the size is in words beside it.
 */
const SIZE_DOTS = 36;
const SIZE_FLOOR = 2 * GB;
const SIZE_CEILING = 4 * 1024 * GB;

export function SizeDots({ quotaBytes }: { quotaBytes: number }) {
    const share =
        Math.log(Math.min(SIZE_CEILING, Math.max(SIZE_FLOOR, quotaBytes)) / SIZE_FLOOR) /
        Math.log(SIZE_CEILING / SIZE_FLOOR);
    const lit = 1 + Math.round(share * (SIZE_DOTS - 2));
    return (
        <div aria-hidden="true" className="grid w-fit grid-flow-col grid-rows-3 gap-[3px]">
            {Array.from({ length: SIZE_DOTS }, (_, index) => (
                <span
                    key={index}
                    className={cn(
                        'size-1.5 rounded-full',
                        index < lit ? 'bg-primary' : 'fit-dot-off bg-foreground/12',
                    )}
                />
            ))}
        </div>
    );
}

/* The answer's button and, beside it, what it charges. */
function PlanAction({ plan }: { plan: FitPlan }) {
    if (!plan.action && !plan.note) return null;
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
export function useSettled(text: string) {
    const [settled, setSettled] = useState(text);
    useEffect(() => {
        const timer = window.setTimeout(() => setSettled(text), 600);
        return () => window.clearTimeout(timer);
    }, [text]);
    return settled;
}

const headline = 'text-[28px] leading-tight font-extrabold tracking-[-0.025em] sm:text-[36px]';

export function FitPlanner({
    plans,
    families = [],
    error = null,
}: {
    plans: FitPlan[];
    /* Family plans, only where the page offers them; with none the planner has no people slider. */
    families?: FitFamilyPlan[];
    /* A checkout that failed from here, shown only while the answer is still that plan. */
    error?: { key: string; message: string } | null;
}) {
    const [people, setPeople] = useState(1);
    const [photos, setPhotos] = useState(8_000);
    const [hours, setHours] = useState(5);
    const [documents, setDocuments] = useState(2_000);
    const { data: contact } = useQuery(salesContactQueryOptions);
    const total = totalOf({ photos, hours, documents });
    const most = Math.max(0, ...families.map((plan) => plan.maxMembers));
    // Without family plans there is one person, whatever the slider was left at.
    const party = most > 1 ? Math.min(people, most) : 1;
    const sliders = slidersFor(party);
    // Back to one person, a slider past one person's reach comes back within it.
    function choosePeople(value: number) {
        setPeople(value);
        const kept = keptWithin({ photos, hours, documents }, slidersFor(value));
        setPhotos(kept.photos);
        setHours(kept.hours);
        setDocuments(kept.documents);
    }
    const answer = fitAnswer<FitPlan & { maxMembers?: number }>({
        personal: plans,
        family: families.map((plan) => ({ ...plan, note: familyNote(plan.price, party) })),
        people: party,
        total,
        // Sales is offered past the biggest plan only beside the family plans; without them the
        // planner ends at self-hosting, as it always has.
        contact: most > 1 && Boolean(contact),
    });
    const named = answer.kind === 'fits' || answer.kind === 'tight' ? answer.plan : undefined;
    // en-GB on server and browser alike, as the counts are, so the numbers hydrate unchanged.
    const quota = (bytes: number) => formatQuota(bytes, 'en-GB');
    const amount = rough(total);
    const more =
        answer.kind === 'beyond' && answer.largest
            ? `More than ${quota(answer.largest.quotaBytes)}.`
            : 'More than any plan holds.';
    const ask = 'Tell us how much you need, and we’ll find you a plan.';
    const about = party > 1 ? `About ${amount} for ${peopleWords(party)}.` : `About ${amount}.`;
    const spoken = useSettled(
        answer.kind === 'empty'
            ? 'Nothing yet.'
            : answer.kind === 'fits'
              ? `${about} ${answer.plan.name} fits, ${quota(answer.plan.quotaBytes)}.`
              : answer.kind === 'tight'
                ? `${about} Tight in ${answer.plan.name}, ${quota(answer.plan.quotaBytes)}.`
                : answer.reach === 'contact'
                  ? `${about} ${more} ${ask}`
                  : `${about} More than any plan holds.`,
    );
    return (
        <section aria-labelledby="fit-title" className="mt-20">
            <div className="id-edge grid gap-8 rounded-xl bg-[var(--id-raised,var(--card))] p-5 sm:p-8 lg:grid-cols-[5fr_6fr] lg:gap-12">
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
                    {most > 1 && (
                        <Slider
                            label="People"
                            value={party}
                            min={1}
                            max={most}
                            step={1}
                            unit={peopleWords}
                            onChange={choosePeople}
                        />
                    )}
                    <Slider
                        label="Photos"
                        value={photos}
                        max={sliders.photos.max}
                        step={sliders.photos.step}
                        unit={(value) => count.format(value)}
                        onChange={setPhotos}
                    />
                    <Slider
                        label="Video"
                        value={hours}
                        max={sliders.hours.max}
                        step={sliders.hours.step}
                        unit={(value) => `${value} ${value === 1 ? 'hour' : 'hours'}`}
                        onChange={setHours}
                    />
                    <Slider
                        label="Documents"
                        value={documents}
                        max={sliders.documents.max}
                        step={sliders.documents.step}
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
                    {answer.kind === 'empty' ? (
                        <p className={headline}>Move a slider to start.</p>
                    ) : answer.kind === 'fits' ? (
                        <>
                            <p className={headline}>{answer.plan.name} fits.</p>
                            <Fill shares={[total / answer.plan.quotaBytes]} />
                            <p className="text-[15px] text-muted-foreground tabular-nums">
                                {amount} of {quota(answer.plan.quotaBytes)}, with room left for
                                versions and Trash.
                            </p>
                            <PlanAction plan={answer.plan} />
                        </>
                    ) : answer.kind === 'tight' ? (
                        <>
                            <p className={headline}>Tight in {answer.plan.name}.</p>
                            <Fill shares={[total / answer.plan.quotaBytes]} />
                            <p className="text-[15px] text-muted-foreground tabular-nums">
                                {amount} of {quota(answer.plan.quotaBytes)}, with little room left
                                for versions and Trash.
                            </p>
                            <PlanAction plan={answer.plan} />
                        </>
                    ) : answer.reach === 'contact' ? (
                        <>
                            <p className={headline}>{more}</p>
                            <p className="text-[15px] leading-relaxed text-muted-foreground">
                                {ask}
                            </p>
                            <TalkToUs subject="More storage" className="w-full sm:w-fit" />
                        </>
                    ) : (
                        <>
                            <p className={headline}>{more}</p>
                            <p className="text-[15px] leading-relaxed text-muted-foreground">
                                Run HushOS on your own server and set each account’s storage
                                yourself.
                            </p>
                            <TextLink href="https://github.com/HushOS/HushOS/blob/main/docs/self-hosting.md">
                                Read the self-hosting guide
                            </TextLink>
                        </>
                    )}
                    {error && error.key === named?.key && (
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

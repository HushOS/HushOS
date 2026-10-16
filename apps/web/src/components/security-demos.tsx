import { paddedLength } from '@hushos/crypto/padding';
import { cn } from 'cn';
import { useId, useState } from 'react';
import { SiteSwitch } from '@/components/site';

/*
 * The security page's hands-on parts. Each one shows a mechanism the page's
 * text already states, with the real rule where there is one (the padding is
 * the app's own Padmé function), and made-up sample values where a value would
 * be private (a link's token and secret, a file's ids).
 */

/* KB, MB, GB in 1024s, as everywhere in HushOS. */
function formatBytes(bytes: number) {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return unit === 0 ? `${value} bytes` : `${value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

const frame = 'mt-6 rounded-xl border border-rule bg-[var(--id-raised,var(--card))] p-4 sm:p-5';

/* ── A link, taken apart ─────────────────────────────────────────────── */

const linkParts = [
    {
        key: 'origin',
        text: 'https://hushos.com',
        sent: true,
        note: 'Where the link points. Sent, like any address.',
    },
    {
        key: 'token',
        text: '/s/Qm9vZGxlLWZha2UtdG9rZW4tZm9yLWV4YW1wbGVz',
        sent: true,
        note: 'Which link this is. We look it up to find the locked item, but it opens nothing on its own.',
    },
    {
        key: 'secret',
        text: '#c2FtcGxlLXNlY3JldC1uZXZlci1zZW50LXRvLXVzLWV4',
        sent: false,
        note: 'The key. Browsers never send the part after the #, so it stays on the screen of whoever opens the link.',
    },
] as const;

export function LinkAnatomy() {
    const [view, setView] = useState<'link' | 'server'>('link');
    const [part, setPart] = useState<(typeof linkParts)[number]['key']>('secret');
    const chosen = linkParts.find((entry) => entry.key === part)!;
    const noteId = useId();
    return (
        <figure className={frame}>
            <SiteSwitch
                label="Show"
                value={view}
                onChange={setView}
                options={[
                    { value: 'link', label: 'The link you send' },
                    { value: 'server', label: 'What reaches us' },
                ]}
            />
            <p className="mt-4 font-mono text-[13px] leading-relaxed break-all sm:text-sm">
                {linkParts.map((entry) => {
                    const hidden = view === 'server' && !entry.sent;
                    return (
                        <button
                            key={entry.key}
                            type="button"
                            aria-pressed={part === entry.key}
                            aria-describedby={part === entry.key ? noteId : undefined}
                            onClick={() => setPart(entry.key)}
                            onPointerEnter={() => setPart(entry.key)}
                            className={cn(
                                'cursor-pointer rounded-xs px-0.5 transition-colors duration-150',
                                part === entry.key && 'bg-accent text-accent-foreground',
                                hidden && 'text-muted-foreground line-through',
                            )}
                        >
                            {entry.text}
                        </button>
                    );
                })}
            </p>
            {/* Read through each part's aria-describedby on focus, not announced on every hover. */}
            <figcaption id={noteId} className="mt-3 text-[15px] leading-relaxed">
                <span className="font-semibold">
                    {chosen.sent ? 'Sent to us. ' : 'Never sent. '}
                </span>
                <span className="text-muted-foreground">{chosen.note}</span>
            </figcaption>
            <p className="mt-2 text-xs text-muted-foreground">
                A made-up link. Point at or pick a part.
            </p>
        </figure>
    );
}

/* ── Padding ─────────────────────────────────────────────────────────── */

/* The smallest size that pads to the same bucket: the sizes we cannot tell apart. */
function bucketStart(padded: number) {
    let low = 0;
    let high = padded;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (paddedLength(middle) < padded) low = middle + 1;
        else high = middle;
    }
    return low;
}

/* A slider from 1 KB to 4 GB, spaced by powers so small files get room too. */
const STEPS = 1000;
const MIN = Math.log2(1024);
const MAX = Math.log2(4 * 1024 ** 3);
const sizeAt = (step: number) => Math.round(2 ** (MIN + ((MAX - MIN) * step) / STEPS));

export function PaddingDemo() {
    const [step, setStep] = useState(560);
    const size = sizeAt(step);
    const padded = paddedLength(size);
    const start = bucketStart(padded);
    const inputId = useId();
    return (
        <figure className={frame}>
            <label htmlFor={inputId} className="text-[15px] font-semibold">
                Your file: <span className="tabular-nums">{formatBytes(size)}</span>
            </label>
            <input
                id={inputId}
                type="range"
                min={0}
                max={STEPS}
                value={step}
                onChange={(event) => setStep(Number(event.target.value))}
                aria-valuetext={formatBytes(size)}
                className="fits-range mt-3 w-full"
            />
            {/* The result is read out as the slider moves; the label alone is not re-read. */}
            <dl
                aria-live="polite"
                aria-atomic="true"
                className="mt-4 grid gap-4 text-[15px] sm:grid-cols-2 sm:gap-6"
            >
                <div className="flex flex-col gap-1 border-t border-rule pt-3">
                    <dt className="font-mono text-xs text-muted-foreground">Padded to</dt>
                    <dd className="font-semibold tabular-nums">{formatBytes(padded)}</dd>
                </div>
                <div className="flex flex-col gap-1 border-t border-rule pt-3">
                    <dt className="font-mono text-xs text-muted-foreground">
                        Looks the same to us as
                    </dt>
                    <dd className="font-semibold tabular-nums">
                        Any file from {formatBytes(start)} to {formatBytes(padded)}
                    </dd>
                </div>
            </dl>
            <figcaption className="mt-3 text-xs text-muted-foreground">
                The app’s own padding rule, for a file without a thumbnail; a thumbnail is padded
                with it. Drag to try a size.
            </figcaption>
        </figure>
    );
}

/* ── The same file, from both sides ─────────────────────────────────── */

const SAMPLE_SIZE = 1_268_734;

export function ServerView() {
    const [view, setView] = useState<'you' | 'us'>('us');
    const rows: [string, string][] =
        view === 'you'
            ? [
                  ['Name', 'Flat lease.pdf'],
                  ['Folder', 'Family › Lisbon 2026'],
                  ['Size', formatBytes(SAMPLE_SIZE)],
                  ['Contents', 'The lease, page by page'],
                  ['Changed', '14 Sept, 09:12'],
              ]
            : [
                  ['Name', 'Locked, unreadable to us'],
                  ['Folder', 'Item 0192f3a1-… inside 0192f2c7-…'],
                  ['Size', `About ${formatBytes(paddedLength(SAMPLE_SIZE))}, padded`],
                  ['Contents', 'Locked pieces in storage'],
                  ['Changed', 'Locked; we see a save on 14 Sept, 09:14, by your account'],
              ];
    return (
        <figure className={frame}>
            <SiteSwitch
                label="Seen by"
                value={view}
                onChange={setView}
                options={[
                    { value: 'you', label: 'You' },
                    { value: 'us', label: 'Us' },
                ]}
            />
            <dl className="mt-4 text-[15px]">
                {rows.map(([term, value]) => (
                    <div
                        key={term}
                        className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 border-b border-rule py-2.5 last:border-b-0"
                    >
                        <dt className="text-muted-foreground">{term}</dt>
                        <dd
                            className={cn(
                                'font-semibold',
                                view === 'us' && term === 'Folder' && 'font-mono text-sm',
                            )}
                        >
                            {value}
                        </dd>
                    </div>
                ))}
            </dl>
            <figcaption className="mt-3 text-xs text-muted-foreground">
                One sample file. The ids are made up; the rest follows the table below.
            </figcaption>
        </figure>
    );
}

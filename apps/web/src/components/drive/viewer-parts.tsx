import { DownloadIcon } from 'lucide-react';
import { cn } from 'cn';
import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/drive';
import { type LargeFileKind, type LargeFileStage, PREVIEW_LIMITS } from '@/lib/previews';

/*
 * Pieces every renderer in the viewer shares: the one card a file gets when it
 * can't be shown, the opening ring, and the Formatted | Source switch, which
 * lives in the viewer's header but is offered by whichever renderer can use it.
 */

export const viewerWords = {
    noPreview: 'This kind of file has no preview yet.',
    tooLarge: (size: number) => `This file is ${formatBytes(size)}, too large to preview here.`,
    elsewhere: 'Download it to open it in another app.',
    elsewhereMedia: 'Download it to play it in another app.',
    broken: 'This file can’t be shown',
    brokenText:
        'It may be damaged or use something the viewer doesn’t support. Download it to try another app.',
    nothing: 'Nothing to show in this file. Download it to open it in another app.',
};

/*
 * What a large file says, kind by kind: why it isn't shown in full (or
 * coloured), what continuing costs, the opt-in, and the words for past the
 * ceiling. One place, so the four read as one pattern (DESIGN.md, Content).
 */
const largeWords: Record<
    LargeFileKind,
    {
        lead: (size: number) => string;
        risk: string;
        action: string;
        ceiling: (size: number) => string;
        ceilingNext?: string;
    }
> = {
    colour: {
        lead: () => 'This file is large, so it isn’t coloured.',
        risk: 'Colouring it may slow this tab down.',
        action: 'Colour anyway',
        ceiling: () => 'This file is too large to colour, so it’s shown as plain text.',
    },
    text: {
        lead: (size) =>
            `Showing the first ${formatBytes(PREVIEW_LIMITS.text)} of ${formatBytes(size)}.`,
        risk: 'Loading the whole file uses a lot of memory and may be slow on this device.',
        action: 'Load the whole file',
        ceiling: (size) =>
            `Showing the first ${formatBytes(PREVIEW_LIMITS.text)} of ${formatBytes(size)}. Download it to read the rest.`,
    },
    image: {
        lead: (size) => `This file is ${formatBytes(size)}.`,
        risk: 'Opening it uses a lot of memory, and this device may not manage to show it.',
        action: 'Open anyway',
        ceiling: (size) => viewerWords.tooLarge(size),
        ceilingNext: viewerWords.elsewhere,
    },
    office: {
        lead: (size) => `This file is ${formatBytes(size)}.`,
        risk: 'Opening it uses a lot of memory and may be slow on this device.',
        action: 'Open anyway',
        ceiling: (size) => viewerWords.tooLarge(size),
        ceilingNext: viewerWords.elsewhere,
    },
};

/* An image chosen with Open anyway that the browser then couldn't decode. */
export const tooBigToDecode =
    'This image may be too large for this device to show. Download it to open it in another app.';

/*
 * The large-file card (docs/file-tools-design.md, "The large-file card").
 * Past a kind's threshold the person is told what the file is and what going
 * on costs, and chooses; past its ceiling there is no choice, only the way
 * out. As a card in place of what can't be shown (an image, an Office file);
 * as a bar above what is shown (code to colour, text shown in part) with
 * LargeFileBar. Choosing is for this viewing only.
 */
export function LargeFile({
    kind,
    size,
    stage,
    onContinue,
    icon,
    onDownload,
}: {
    kind: 'image' | 'office';
    size: number;
    stage: Exclude<LargeFileStage, 'fine'>;
    onContinue: () => void;
    icon?: ReactNode;
    onDownload: () => void;
}) {
    const words = largeWords[kind];
    if (stage === 'ceiling')
        return (
            <Notice
                icon={icon}
                title={words.ceiling(size)}
                text={words.ceilingNext}
                onDownload={onDownload}
            />
        );
    return (
        <Notice icon={icon} title={words.lead(size)} text={words.risk}>
            <div className="mt-1 flex flex-wrap justify-center gap-2">
                <Button variant="outline" onClick={onContinue}>
                    {words.action}
                </Button>
                <Button onClick={onDownload}>
                    <DownloadIcon />
                    Download
                </Button>
            </div>
        </Notice>
    );
}

/*
 * The bar form. Its status line is one <output> that stays in the page while
 * the bar does and only changes its words, so a screen reader hears the work
 * start and finish; after the opt-in, focus moves to it, since the button that
 * had focus is gone. Once the work is done the bar is no longer seen.
 */
export function LargeFileBar({
    kind,
    size,
    stage,
    onContinue,
    progress = null,
}: {
    kind: 'colour' | 'text';
    size: number;
    /* `working` and `done` follow the opt-in, for work that runs inside the bar (colouring). */
    stage: Exclude<LargeFileStage, 'fine'> | 'working' | 'done';
    onContinue?: () => void;
    /* 0 to 1 while working. */
    progress?: number | null;
}) {
    const words = largeWords[kind];
    const status = useRef<HTMLOutputElement>(null);
    const chosen = stage === 'working' || stage === 'done';
    useEffect(() => {
        if (chosen) status.current?.focus({ preventScroll: true });
    }, [chosen]);
    return (
        // Done, the bar leaves the page's look and keeps its status for a screen reader: the
        // colour itself says it is coloured, and a bar saying so would only take a row.
        <div
            className={cn(
                'flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule px-4 py-2.5 text-[13px] text-muted-foreground sm:px-6',
                stage === 'done' && 'sr-only',
            )}
        >
            {stage === 'offer' && (
                <>
                    <p className="min-w-0 flex-1 basis-64">
                        {words.lead(size)} {words.risk}
                    </p>
                    <Button variant="outline" onClick={onContinue}>
                        {words.action}
                    </Button>
                </>
            )}
            {stage === 'ceiling' && <p>{words.ceiling(size)}</p>}
            {chosen && stage === 'working' && <Spinner />}
            <output
                ref={status}
                tabIndex={-1}
                className={cn(
                    'rounded-xs outline-hidden focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring',
                    !chosen && 'sr-only',
                )}
            >
                {stage === 'working' && 'Colouring…'}
                {/* The share is seen, not spoken, so the status is read once and not at every step. */}
                {stage === 'working' && progress !== null && (
                    <span className="ml-2 tabular-nums" aria-hidden="true">
                        {Math.floor(progress * 100)}%
                    </span>
                )}
                {stage === 'done' && 'Coloured.'}
            </output>
        </div>
    );
}

/* One card in the middle of the viewer: what happened, in a line, and the way forward. */
export function Notice({
    icon,
    title,
    text,
    onDownload,
    children,
}: {
    icon?: ReactNode;
    title: string;
    text?: ReactNode;
    onDownload?: () => void;
    children?: ReactNode;
}) {
    return (
        // A focus target after an opt-in, when what was asked for can't be shown after all.
        <div
            data-viewer-body
            tabIndex={-1}
            className="flex min-h-0 flex-1 overflow-auto p-4 outline-hidden sm:p-6"
        >
            <div className="m-auto flex w-full max-w-[420px] flex-col items-center gap-3 rounded-2xl bg-card p-8 text-center shadow-sm">
                {icon}
                <h2 className="text-lg font-bold text-balance">{title}</h2>
                {text && <p className="text-sm text-muted-foreground wrap-anywhere">{text}</p>}
                {children}
                {onDownload && (
                    <Button className="mt-1" onClick={onDownload}>
                        <DownloadIcon />
                        Download
                    </Button>
                )}
            </div>
        </div>
    );
}

/* How much of a whole read has arrived, as a ring. */
export function Ring({ value, size = 40 }: { value: number; size?: number }) {
    const radius = (size - 4) / 2;
    const length = 2 * Math.PI * radius;
    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="-rotate-90 text-primary"
            aria-hidden="true"
        >
            <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                strokeWidth={3}
                className="stroke-muted"
            />
            <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                strokeWidth={3}
                stroke="currentColor"
                strokeLinecap="round"
                strokeDasharray={length}
                strokeDashoffset={length * (1 - Math.min(Math.max(value, 0), 1))}
                className="transition-[stroke-dashoffset] duration-200"
            />
        </svg>
    );
}

/* A file that opens in a blink needs no ring; one that takes a moment does. */
const RING_FROM = 2 * 1024 * 1024;

/*
 * While a file is fetched and decrypted. A read that reports progress gets a ring
 * and how much is left; a ranged read (a large PDF, streamed media) a spinner.
 */
export function Opening({
    name,
    progress,
}: {
    name?: string;
    progress?: { done: number; total: number } | null;
}) {
    if (!progress || progress.total < RING_FROM || !name)
        return (
            <output
                className="flex min-h-24 flex-1 items-center justify-center text-muted-foreground"
                aria-label="Opening"
            >
                <Spinner />
            </output>
        );
    const share = progress.done / progress.total;
    return (
        <output className="flex min-h-0 flex-1 p-6">
            <div className="m-auto flex max-w-[420px] flex-col items-center gap-3 text-center">
                <Ring value={share} />
                <p className="text-[15px] font-semibold wrap-anywhere">Opening “{name}”…</p>
                <p className="text-[13px] text-muted-foreground tabular-nums">
                    {Math.round(share * 100)}% of {formatBytes(progress.total)}
                </p>
            </div>
        </output>
    );
}

/*
 * Formatted | Source. A renderer that has both (Markdown, a delimited
 * spreadsheet) offers the switch while it shows; the header draws it.
 */
export const SourceSwitch = createContext<{
    source: boolean;
    offer: (available: boolean) => void;
}>({ source: false, offer: () => {} });

export function useSourceSwitch(available: boolean) {
    const { source, offer } = useContext(SourceSwitch);
    useEffect(() => {
        offer(available);
        return () => offer(false);
    }, [available, offer]);
    return available && source;
}

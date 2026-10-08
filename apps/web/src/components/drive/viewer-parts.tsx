import { DownloadIcon } from 'lucide-react';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import { formatBytes } from '@/lib/drive';

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
        <div className="flex min-h-0 flex-1 overflow-auto p-4 sm:p-6">
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

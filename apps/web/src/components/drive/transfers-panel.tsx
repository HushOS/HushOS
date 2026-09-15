import type { DownloadItem } from '@hushos/drive/downloads';
import { formatRate, type UploadItem } from '@hushos/drive/transfers';
import {
    ChevronDownIcon,
    FileDownIcon,
    FileUpIcon,
    PauseIcon,
    PlayIcon,
    RotateCcwIcon,
    XIcon,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { downloads, useDownloads } from '@/lib/downloads';
import { formatBytes } from '@/lib/drive';
import { transfers, useTransfers } from '@/lib/transfers';
import { useBatchProgress } from '@/lib/batch-progress';
import { formatTimeLeft } from '@/lib/progress';

/*
 * The one panel that follows the person around the app while transfers run: a
 * raised cell, bottom right, with a row per file, uploads and downloads
 * together. It appears with the first transfer and can be dismissed once
 * everything has settled.
 */

function statusLine(item: UploadItem) {
    switch (item.status) {
        case 'queued':
            return 'Waiting';
        case 'preparing':
            return 'Encrypting keys';
        case 'uploading':
            return item.bytesPerSecond
                ? `${formatBytes(item.loaded)} of ${formatBytes(item.total)} · ${formatRate(item.bytesPerSecond)}`
                : `${formatBytes(item.loaded)} of ${formatBytes(item.total)}`;
        case 'paused':
            if (!item.needsFile)
                return `Paused · ${formatBytes(item.loaded)} of ${formatBytes(item.total)}`;
            // Came back after a reload: what the store already has, or nothing yet.
            return item.startedAt === null
                ? (item.error ?? 'Waiting for its file')
                : `${item.error ?? 'Interrupted'} · ${formatBytes(item.loaded)} of ${formatBytes(item.total)} kept`;
        case 'completing':
            return 'Finishing';
        case 'done':
            return `Done · ${formatBytes(item.size)}`;
        case 'failed':
            return item.error ?? 'Failed';
        case 'cancelled':
            return 'Cancelled';
    }
}

function downloadLine(item: DownloadItem) {
    const files = item.files > 1 ? ` · ${item.files} files` : '';
    switch (item.status) {
        case 'queued':
            return 'Waiting';
        case 'preparing':
            return `Preparing${files}`;
        case 'paused':
            return item.size !== null
                ? `Paused · ${formatBytes(item.loaded)} of ${formatBytes(item.size)}`
                : `Paused · ${formatBytes(item.loaded)}`;
        case 'downloading': {
            const progress =
                item.size !== null
                    ? `${formatBytes(item.loaded)} of ${formatBytes(item.size)}`
                    : formatBytes(item.loaded);
            return item.bytesPerSecond
                ? `${progress} · ${formatRate(item.bytesPerSecond)}`
                : progress;
        }
        case 'done':
            return `Saved · ${formatBytes(item.size ?? item.loaded)}${files}`;
        case 'failed':
            return item.error ?? 'Failed';
        case 'cancelled':
            return 'Cancelled';
    }
}

const bar = (tone: 'failed' | 'paused' | 'active') =>
    `block h-0.5 w-full appearance-none overflow-hidden border-0 bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-300 ${tone === 'failed' ? '[&::-moz-progress-bar]:bg-destructive [&::-webkit-progress-value]:bg-destructive' : tone === 'paused' ? '[&::-moz-progress-bar]:bg-muted-foreground [&::-webkit-progress-value]:bg-muted-foreground' : '[&::-moz-progress-bar]:bg-primary [&::-webkit-progress-value]:bg-primary'}`;

function DownloadRow({ item }: { item: DownloadItem }) {
    const settled =
        item.status === 'done' || item.status === 'cancelled' || item.status === 'failed';
    return (
        <li className="border-b last:border-b-0">
            <div className="flex items-center gap-2 py-2 pr-1 pl-3.5">
                <FileDownIcon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                />
                <div className="min-w-0 flex-1">
                    <p className="truncate text-sm">{item.name}</p>
                    <p
                        className={`truncate font-mono text-[11px] ${item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
                    >
                        {downloadLine(item)}
                    </p>
                </div>
                {item.status === 'paused' ? (
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Resume download"
                        onClick={() => downloads.resume(item.id)}
                    >
                        <PlayIcon />
                    </Button>
                ) : !settled ? (
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Pause download"
                        onClick={() => downloads.pause(item.id)}
                    >
                        <PauseIcon />
                    </Button>
                ) : null}
                {settled ? (
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Remove from list"
                        onClick={() => downloads.remove(item.id)}
                    >
                        <XIcon />
                    </Button>
                ) : (
                    <Button
                        variant="ghost"
                        size="icon-xs"
                        aria-label="Cancel download"
                        onClick={() => void downloads.cancel(item.id)}
                    >
                        <XIcon />
                    </Button>
                )}
            </div>
            {!settled && (
                <progress
                    value={item.size === null ? undefined : item.loaded}
                    max={item.size ?? undefined}
                    aria-label={`${item.name} progress`}
                    className={bar(item.status === 'paused' ? 'paused' : 'active')}
                />
            )}
        </li>
    );
}

/*
 * A restored upload needs its file again. Where the browser kept a handle, one
 * click reopens it after a permission prompt; otherwise the person picks it, and
 * the engine proves it is the same file before continuing.
 */
function AttachFile({ item }: { item: UploadItem }) {
    const input = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                ref={input}
                type="file"
                hidden
                onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = '';
                    if (file) void transfers.attachFile(item.id, file);
                }}
            />
            <Button
                variant="outline"
                size="xs"
                onClick={() =>
                    item.hasHandle ? void transfers.resume(item.id) : input.current?.click()
                }
            >
                <FileUpIcon />
                {item.hasHandle ? 'Resume' : 'Choose file'}
            </Button>
        </>
    );
}

export function TransfersPanel() {
    const state = useTransfers();
    const down = useDownloads();
    const [collapsed, setCollapsed] = useState(false);
    const { batch, timeLeft } = useBatchProgress();
    if (!state.uploads.length && !down.downloads.length) return null;
    const settled = (status: string) => status === 'done' || status === 'cancelled';
    const finished =
        state.uploads.filter((item) => settled(item.status)).length +
        down.downloads.filter((item) => settled(item.status)).length;
    const paused =
        state.uploads.filter((item) => item.status === 'paused').length +
        down.downloads.filter((item) => item.status === 'paused').length;
    const failed =
        state.uploads.filter((item) => item.status === 'failed').length +
        down.downloads.filter((item) => item.status === 'failed').length;
    const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
    const title =
        state.active && down.active
            ? `Transferring ${plural(state.active + down.active, 'file')}`
            : state.active
              ? `Uploading ${plural(state.active, 'file')}`
              : down.active
                ? `Downloading ${plural(down.active, 'file')}`
                : failed
                  ? `${plural(failed, 'transfer')} failed`
                  : paused
                    ? `${paused} paused`
                    : `${plural(finished, 'transfer')} finished`;
    const rate = state.bytesPerSecond + down.bytesPerSecond;
    const active = state.active + down.active;
    // The batch as a whole: files and bytes done, and the time left once the rate has settled.
    // Two short lines rather than one long one: a phone's panel is 340px wide, and
    // the time left is the part worth reading, so it goes first with the file count.
    const summary =
        active > 0
            ? [
                  [
                      batch.files.total > 1
                          ? `${batch.files.done} of ${batch.files.total} files`
                          : null,
                      timeLeft !== null ? formatTimeLeft(timeLeft) : null,
                  ]
                      .filter(Boolean)
                      .join(' · '),
                  [
                      `${formatBytes(batch.bytes.loaded)} of ${formatBytes(batch.bytes.total)}`,
                      rate > 0 ? formatRate(rate) : null,
                  ]
                      .filter(Boolean)
                      .join(' · '),
              ].filter(Boolean)
            : null;
    // Failed items first: the reason the panel is still open is what to look at.
    const uploadRows = [
        ...state.uploads.filter((item) => item.status === 'failed'),
        ...state.uploads.filter((item) => item.status !== 'failed'),
    ];
    const retryable = state.uploads.filter((item) => item.status === 'failed' && !item.needsFile);
    const clearable = [
        ...state.uploads.filter((item) => settled(item.status) || item.status === 'failed'),
        ...down.downloads.filter((item) => settled(item.status) || item.status === 'failed'),
    ].length;
    return (
        <section
            aria-label="Transfers"
            className="fixed right-4 bottom-4 z-40 flex w-[calc(100%-2rem)] max-w-sm flex-col border bg-popover text-popover-foreground shadow-hard sm:right-6 sm:bottom-6"
        >
            <header className="flex min-h-11 items-center gap-2 border-b py-2.5 pr-1 pl-3.5">
                <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs">{title}</p>
                    {summary && (
                        <div className="mt-1.5 space-y-1 text-muted-foreground" data-batch-progress>
                            {summary.map((line) => (
                                <p key={line} className="eyebrow truncate">
                                    {line}
                                </p>
                            ))}
                        </div>
                    )}
                </div>
                {active > 0 ? (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Pause all"
                        onClick={() => {
                            transfers.pauseAll();
                            downloads.pauseAll();
                        }}
                    >
                        <PauseIcon />
                    </Button>
                ) : paused > 0 ? (
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Resume all"
                        onClick={() => {
                            transfers.resumeAll();
                            downloads.resumeAll();
                        }}
                    >
                        <PlayIcon />
                    </Button>
                ) : null}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={collapsed ? 'Expand transfers' : 'Collapse transfers'}
                    aria-expanded={!collapsed}
                    onClick={() => setCollapsed((value) => !value)}
                >
                    <ChevronDownIcon className={collapsed ? 'rotate-180' : ''} />
                </Button>
            </header>
            {/* One place for the batch's leftovers: retry what failed, clear what is done, or clear the lot. */}
            {(retryable.length > 0 || (active === 0 && clearable > 0)) && (
                <div
                    className="flex flex-wrap items-center gap-1 border-b bg-muted/40 px-2 py-1"
                    data-batch-actions
                >
                    {retryable.length > 0 && (
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => {
                                for (const item of retryable) void transfers.retry(item.id);
                            }}
                        >
                            <RotateCcwIcon />
                            Retry{' '}
                            {retryable.length === 1
                                ? 'the failed one'
                                : `all ${retryable.length} failed`}
                        </Button>
                    )}
                    {finished > 0 && (
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => {
                                transfers.clearFinished();
                                downloads.clearFinished();
                            }}
                        >
                            <XIcon />
                            Clear finished
                        </Button>
                    )}
                    {active === 0 && clearable > 0 && (
                        <Button
                            variant="ghost"
                            size="xs"
                            onClick={() => {
                                for (const item of state.uploads)
                                    if (settled(item.status) || item.status === 'failed')
                                        transfers.remove(item.id);
                                for (const item of down.downloads)
                                    if (settled(item.status) || item.status === 'failed')
                                        downloads.remove(item.id);
                            }}
                        >
                            <XIcon />
                            Clear all
                        </Button>
                    )}
                </div>
            )}
            {active > 0 && batch.bytes.total > 0 && (
                <progress
                    value={batch.bytes.loaded}
                    max={batch.bytes.total}
                    aria-label="All transfers progress"
                    className="block h-0.5 w-full appearance-none overflow-hidden border-0 bg-muted [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-300"
                />
            )}
            {!collapsed && (
                <ul className="max-h-72 overflow-y-auto">
                    {down.downloads.map((item) => (
                        <DownloadRow key={item.id} item={item} />
                    ))}
                    {uploadRows.map((item) => (
                        <li key={item.id} className="border-b last:border-b-0">
                            <div className="flex items-center gap-2 py-2 pr-1 pl-3.5">
                                <div className="min-w-0 flex-1">
                                    <p className="truncate text-sm">{item.name}</p>
                                    <p
                                        className={`truncate font-mono text-[11px] ${item.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
                                    >
                                        {statusLine(item)}
                                    </p>
                                </div>
                                {item.status === 'uploading' || item.status === 'queued' ? (
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label="Pause"
                                        onClick={() => void transfers.pause(item.id)}
                                    >
                                        <PauseIcon />
                                    </Button>
                                ) : item.status === 'paused' && item.needsFile ? (
                                    <AttachFile item={item} />
                                ) : item.status === 'paused' ? (
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label="Resume"
                                        onClick={() => void transfers.resume(item.id)}
                                    >
                                        <PlayIcon />
                                    </Button>
                                ) : item.status === 'failed' && !item.needsFile ? (
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label="Retry"
                                        onClick={() => void transfers.retry(item.id)}
                                    >
                                        <RotateCcwIcon />
                                    </Button>
                                ) : null}
                                {item.status === 'done' ||
                                item.status === 'cancelled' ||
                                item.status === 'failed' ? (
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label="Remove from list"
                                        onClick={() => transfers.remove(item.id)}
                                    >
                                        <XIcon />
                                    </Button>
                                ) : item.status === 'paused' && item.needsFile ? (
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label="Discard"
                                        onClick={() => void transfers.discard(item.id)}
                                    >
                                        <XIcon />
                                    </Button>
                                ) : (
                                    <Button
                                        variant="ghost"
                                        size="icon-xs"
                                        aria-label="Cancel"
                                        onClick={() => void transfers.cancel(item.id)}
                                    >
                                        <XIcon />
                                    </Button>
                                )}
                            </div>
                            {item.status !== 'done' && item.status !== 'cancelled' && (
                                <progress
                                    value={item.loaded}
                                    max={item.total || 1}
                                    aria-label={`${item.name} progress`}
                                    className={`block h-0.5 w-full appearance-none overflow-hidden border-0 bg-muted [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-300 ${item.status === 'failed' ? '[&::-moz-progress-bar]:bg-destructive [&::-webkit-progress-value]:bg-destructive' : item.status === 'paused' ? '[&::-moz-progress-bar]:bg-muted-foreground [&::-webkit-progress-value]:bg-muted-foreground' : '[&::-moz-progress-bar]:bg-primary [&::-webkit-progress-value]:bg-primary'}`}
                                />
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}

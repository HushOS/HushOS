import type { DownloadItem } from '@hushos/drive/downloads';
import { formatRate, type UploadItem } from '@hushos/drive/transfers';
import { cn } from 'cn';
import {
    ChevronDownIcon,
    CircleCheckIcon,
    CloudOffIcon,
    FileUpIcon,
    PauseIcon,
    PlayIcon,
    RotateCcwIcon,
    TriangleAlertIcon,
    XIcon,
} from 'lucide-react';
import { useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { FileMark } from '@/components/drive/file-mark';
import { openStorageFull } from '@/components/drive/storage-full-dialog';
import { Ring } from '@/components/drive/viewer-parts';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { downloads, useDownloads } from '@/lib/downloads';
import { formatBytes, isNetworkFailure, OFFLINE_WORDS } from '@/lib/drive';
import { transfers, useTransfers } from '@/lib/transfers';
import { useBatchProgress } from '@/lib/batch-progress';
import { formatTimeLeft } from '@/lib/progress';

/*
 * The one panel that follows the person around the app while transfers run: a
 * lifted card, bottom right, with a row per file, uploads and downloads
 * together. One headline, one status line per file, the same words the phones
 * use. It appears with the first transfer and can be closed once everything
 * has settled; cancelling what is still on its way always asks.
 */

const OVER_QUOTA = 'over-quota';

/*
 * Whether the browser has a network. Uploads and downloads both stop and wait for
 * it on their own; the panel only has to say so.
 */
function subscribeOnline(onChange: () => void) {
    window.addEventListener('online', onChange);
    window.addEventListener('offline', onChange);
    return () => {
        window.removeEventListener('online', onChange);
        window.removeEventListener('offline', onChange);
    };
}
function useOffline() {
    return useSyncExternalStore(
        subscribeOnline,
        () => !navigator.onLine,
        () => false,
    );
}
const WAITING = 'Waiting for a connection';

/* What went wrong, said as what to do about it. */
function failure(item: { error: string | null; errorCode?: string | null }) {
    if (item.errorCode === 'unavailable' || isNetworkFailure(item.error)) return OFFLINE_WORDS;
    return item.error ?? 'This didn’t finish. Retry, or remove it from the list.';
}

function statusLine(item: UploadItem, offline: boolean) {
    const sent = `${formatBytes(item.loaded)} of ${formatBytes(item.total)}`;
    switch (item.status) {
        case 'queued':
            return 'Waiting';
        case 'preparing':
            return 'Preparing';
        case 'uploading':
            if (offline) return `${WAITING} · ${sent}`;
            return item.bytesPerSecond ? `${sent} · ${formatRate(item.bytesPerSecond)}` : sent;
        case 'paused':
            if (!item.needsFile) return `Paused · ${sent}`;
            // Came back after a reload: what the store already has, or nothing yet.
            return item.startedAt === null
                ? `Choose “${item.name}” again to finish`
                : `Choose “${item.name}” again to finish · ${sent} kept`;
        case 'completing':
            return 'Finishing';
        case 'done':
            return `Uploaded · ${formatBytes(item.size)}`;
        case 'failed':
            return item.errorCode === OVER_QUOTA
                ? `Not enough room · needs ${formatBytes(item.total)}`
                : failure(item);
        case 'cancelled':
            return 'Cancelled';
    }
}

function downloadLine(item: DownloadItem, offline: boolean) {
    const files = item.files > 1 ? ` · ${item.files} files` : '';
    const sent =
        item.size !== null
            ? `${formatBytes(item.loaded)} of ${formatBytes(item.size)}`
            : formatBytes(item.loaded);
    switch (item.status) {
        case 'queued':
            return 'Waiting';
        case 'preparing':
            return `Preparing${files}`;
        case 'paused':
            return `Paused · ${sent}`;
        case 'downloading':
            if (offline) return `${WAITING} · ${sent}`;
            return item.bytesPerSecond ? `${sent} · ${formatRate(item.bytesPerSecond)}` : sent;
        case 'done':
            return `Downloaded · ${formatBytes(item.size ?? item.loaded)}${files}`;
        case 'failed':
            return failure({ error: item.error });
        case 'cancelled':
            return 'Cancelled';
    }
}

type Tone = 'active' | 'paused' | 'failed' | 'done';

/* One file: its mark, name, a bar while it moves, the status line, and what can be done. */
function Row({
    name,
    line,
    tone,
    progress,
    actions,
}: {
    name: string;
    line: string;
    tone: Tone;
    progress: { value: number | undefined; max: number | undefined } | null;
    actions: ReactNode;
}) {
    return (
        <li className="flex items-center gap-3 border-t border-rule py-2.5 pr-2 pl-4">
            <FileMark kind="file" name={name} size="row" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="truncate text-sm font-semibold">{name}</p>
                {progress && (
                    <progress
                        value={progress.value}
                        max={progress.max}
                        aria-label={`${name} progress`}
                        className={cn(
                            'block h-1 w-full appearance-none overflow-hidden rounded-full border-0 bg-rule [&::-webkit-progress-bar]:bg-rule [&::-webkit-progress-value]:transition-[width] [&::-webkit-progress-value]:duration-300',
                            tone === 'failed'
                                ? '[&::-moz-progress-bar]:bg-destructive [&::-webkit-progress-value]:bg-destructive'
                                : tone === 'paused'
                                  ? '[&::-moz-progress-bar]:bg-muted-foreground [&::-webkit-progress-value]:bg-muted-foreground'
                                  : '[&::-moz-progress-bar]:bg-primary [&::-webkit-progress-value]:bg-primary',
                        )}
                    />
                )}
                <p
                    className={cn(
                        'truncate text-xs leading-snug tabular-nums',
                        tone === 'failed'
                            ? 'text-destructive'
                            : tone === 'done'
                              ? 'text-success'
                              : 'text-muted-foreground',
                    )}
                    title={line}
                >
                    {line}
                </p>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">{actions}</div>
        </li>
    );
}

function IconAction({
    label,
    icon: Icon,
    onClick,
}: {
    label: string;
    icon: typeof PauseIcon;
    onClick: () => void;
}) {
    return (
        <Button variant="ghost" size="icon-sm" aria-label={label} title={label} onClick={onClick}>
            <Icon />
        </Button>
    );
}

function DownloadRow({ item, offline }: { item: DownloadItem; offline: boolean }) {
    const settled =
        item.status === 'done' || item.status === 'cancelled' || item.status === 'failed';
    return (
        <Row
            name={item.name}
            line={downloadLine(item, offline)}
            tone={
                item.status === 'failed'
                    ? 'failed'
                    : item.status === 'done'
                      ? 'done'
                      : item.status === 'paused'
                        ? 'paused'
                        : 'active'
            }
            progress={
                settled
                    ? null
                    : {
                          value: item.size === null ? undefined : item.loaded,
                          max: item.size ?? undefined,
                      }
            }
            actions={
                <>
                    {item.status === 'paused' ? (
                        <IconAction
                            label={`Resume ${item.name}`}
                            icon={PlayIcon}
                            onClick={() => downloads.resume(item.id)}
                        />
                    ) : !settled ? (
                        <IconAction
                            label={`Pause ${item.name}`}
                            icon={PauseIcon}
                            onClick={() => downloads.pause(item.id)}
                        />
                    ) : null}
                    {settled ? (
                        <IconAction
                            label={`Remove ${item.name} from the list`}
                            icon={XIcon}
                            onClick={() => downloads.remove(item.id)}
                        />
                    ) : (
                        <IconAction
                            label={`Cancel ${item.name}`}
                            icon={XIcon}
                            onClick={() => void downloads.cancel(item.id)}
                        />
                    )}
                </>
            }
        />
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
                size="sm"
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

function UploadRow({ item, offline }: { item: UploadItem; offline: boolean }) {
    const overQuota = item.status === 'failed' && item.errorCode === OVER_QUOTA;
    return (
        <Row
            name={item.name}
            line={statusLine(item, offline)}
            tone={
                item.status === 'failed'
                    ? 'failed'
                    : item.status === 'done'
                      ? 'done'
                      : item.status === 'paused'
                        ? 'paused'
                        : 'active'
            }
            progress={
                item.status === 'done' || item.status === 'cancelled' || item.status === 'failed'
                    ? null
                    : { value: item.loaded, max: item.total || 1 }
            }
            actions={
                <>
                    {overQuota && (
                        <Button variant="outline" size="sm" onClick={openStorageFull}>
                            Make room
                        </Button>
                    )}
                    {item.status === 'uploading' || item.status === 'queued' ? (
                        <IconAction
                            label={`Pause ${item.name}`}
                            icon={PauseIcon}
                            onClick={() => void transfers.pause(item.id)}
                        />
                    ) : item.status === 'paused' && item.needsFile ? (
                        <AttachFile item={item} />
                    ) : item.status === 'paused' ? (
                        <IconAction
                            label={`Resume ${item.name}`}
                            icon={PlayIcon}
                            onClick={() => void transfers.resume(item.id)}
                        />
                    ) : item.status === 'failed' && !item.needsFile && !overQuota ? (
                        <IconAction
                            label={`Retry ${item.name}`}
                            icon={RotateCcwIcon}
                            onClick={() => void transfers.retry(item.id)}
                        />
                    ) : null}
                    {item.status === 'done' ||
                    item.status === 'cancelled' ||
                    item.status === 'failed' ? (
                        <IconAction
                            label={`Remove ${item.name} from the list`}
                            icon={XIcon}
                            onClick={() => transfers.remove(item.id)}
                        />
                    ) : item.status === 'paused' && item.needsFile ? (
                        <IconAction
                            label={`Discard ${item.name}`}
                            icon={XIcon}
                            onClick={() => void transfers.discard(item.id)}
                        />
                    ) : (
                        <IconAction
                            label={`Cancel ${item.name}`}
                            icon={XIcon}
                            onClick={() => void transfers.cancel(item.id)}
                        />
                    )}
                </>
            }
        />
    );
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function TransfersPanel() {
    const state = useTransfers();
    const down = useDownloads();
    const [collapsed, setCollapsed] = useState(false);
    const [confirming, setConfirming] = useState(false);
    const { batch, timeLeft } = useBatchProgress();
    const offline = useOffline();
    if (!state.uploads.length && !down.downloads.length) return null;
    const settled = (status: string) => status === 'done' || status === 'cancelled';
    const doneUploads = state.uploads.filter((item) => item.status === 'done').length;
    const doneDownloads = down.downloads.filter((item) => item.status === 'done').length;
    const finished =
        state.uploads.filter((item) => settled(item.status)).length +
        down.downloads.filter((item) => settled(item.status)).length;
    const paused =
        state.uploads.filter((item) => item.status === 'paused').length +
        down.downloads.filter((item) => item.status === 'paused').length;
    const failed =
        state.uploads.filter((item) => item.status === 'failed').length +
        down.downloads.filter((item) => item.status === 'failed').length;
    const active = state.active + down.active;
    // The one headline every client uses.
    const title =
        active > 0 && offline
            ? WAITING
            : state.active && down.active
              ? `Transferring ${plural(active, 'file')}`
              : state.active
                ? `Uploading ${plural(state.active, 'file')}`
                : down.active
                  ? `Downloading ${plural(down.active, 'file')}`
                  : paused
                    ? `${paused} paused`
                    : failed
                      ? `${plural(failed, 'transfer')} didn’t finish`
                      : doneDownloads === 0 && doneUploads > 0
                        ? `${plural(doneUploads, 'file')} uploaded`
                        : `${plural(doneUploads + doneDownloads, 'transfer')} finished`;
    const rate = state.bytesPerSecond + down.bytesPerSecond;
    const counted = state.uploads.length + down.downloads.length;
    // Under the headline: files done of all, and the time left once the rate has settled.
    const summary =
        active > 0
            ? [
                  batch.files.total > 1
                      ? `${batch.files.done} of ${batch.files.total} files`
                      : `${formatBytes(batch.bytes.loaded)} of ${formatBytes(batch.bytes.total)}`,
                  // Nothing moves while offline, so no estimate.
                  offline
                      ? null
                      : timeLeft !== null
                        ? formatTimeLeft(timeLeft)
                        : rate > 0
                          ? formatRate(rate)
                          : null,
              ]
                  .filter(Boolean)
                  .join(' · ')
            : `${doneUploads + doneDownloads} of ${counted} files`;
    // Failed items first: the reason the panel is still open is what to look at.
    const uploadRows = [
        ...state.uploads.filter((item) => item.status === 'failed'),
        ...state.uploads.filter((item) => item.status !== 'failed'),
    ];
    const retryable = state.uploads.filter(
        (item) => item.status === 'failed' && !item.needsFile && item.errorCode !== OVER_QUOTA,
    );
    // Still on their way, paused included: what the header's cross would cancel.
    const unsettled = [
        ...state.uploads.filter((item) => !settled(item.status) && item.status !== 'failed'),
        ...down.downloads.filter((item) => !settled(item.status) && item.status !== 'failed'),
    ];
    function removeEverything() {
        for (const item of state.uploads) transfers.remove(item.id);
        for (const item of down.downloads) downloads.remove(item.id);
    }
    async function cancelEverything() {
        await Promise.all([
            ...state.uploads
                .filter((item) => !settled(item.status) && item.status !== 'failed')
                .map((item) => transfers.cancel(item.id)),
            ...down.downloads
                .filter((item) => !settled(item.status) && item.status !== 'failed')
                .map((item) => downloads.cancel(item.id)),
        ]);
        transfers.clearFinished();
        downloads.clearFinished();
        for (const item of transfers.getState().uploads) transfers.remove(item.id);
        for (const item of downloads.getState().downloads) downloads.remove(item.id);
    }
    return (
        <section
            aria-label="Transfers"
            // Its height, for toasts to sit above it. It sits above the selection bar itself.
            ref={(element) => {
                if (!element) return;
                const root = document.documentElement;
                const lift = () =>
                    root.style.setProperty('--transfers-lift', `${element.offsetHeight + 8}px`);
                lift();
                const observer = new ResizeObserver(lift);
                observer.observe(element);
                return () => {
                    observer.disconnect();
                    root.style.removeProperty('--transfers-lift');
                };
            }}
            className="fixed right-4 bottom-[calc(1rem+var(--selection-lift,0px))] z-40 flex w-[calc(100%-2rem)] max-w-[420px] flex-col overflow-hidden rounded-xl border border-edge bg-card text-card-foreground shadow-xl transition-[bottom] duration-200 sm:right-6 sm:bottom-[calc(1.5rem+var(--selection-lift,0px))]"
        >
            <header className="flex items-center gap-3 py-3 pr-2 pl-4">
                <span className="flex size-[22px] shrink-0 items-center justify-center">
                    {active > 0 && offline ? (
                        <CloudOffIcon className="size-5 text-muted-foreground" aria-hidden="true" />
                    ) : active > 0 ? (
                        <Ring
                            value={batch.bytes.total ? batch.bytes.loaded / batch.bytes.total : 0}
                            size={22}
                        />
                    ) : paused > 0 ? (
                        <PauseIcon className="size-5 text-muted-foreground" aria-hidden="true" />
                    ) : failed > 0 ? (
                        <TriangleAlertIcon className="size-5 text-destructive" aria-hidden="true" />
                    ) : (
                        <CircleCheckIcon className="size-5 text-success" aria-hidden="true" />
                    )}
                </span>
                <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-bold">{title}</p>
                    <p
                        className="truncate text-xs text-muted-foreground tabular-nums"
                        data-batch-progress
                    >
                        {summary}
                    </p>
                </div>
                {active > 0 ? (
                    <IconAction
                        label="Pause all"
                        icon={PauseIcon}
                        onClick={() => {
                            transfers.pauseAll();
                            downloads.pauseAll();
                        }}
                    />
                ) : paused > 0 ? (
                    <IconAction
                        label="Resume all"
                        icon={PlayIcon}
                        onClick={() => {
                            transfers.resumeAll();
                            downloads.resumeAll();
                        }}
                    />
                ) : null}
                <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={collapsed ? 'Expand transfers' : 'Collapse transfers'}
                    aria-expanded={!collapsed}
                    // The ghost variant paints an expanded trigger as open, meant for menus; this one is open most of the time.
                    className="aria-expanded:bg-transparent hover:aria-expanded:bg-muted"
                    onClick={() => setCollapsed((value) => !value)}
                >
                    <ChevronDownIcon className={collapsed ? 'rotate-180' : ''} />
                </Button>
                {/* The cross ends it all: cancels what is on its way, after asking, or closes a finished panel. */}
                <IconAction
                    label={unsettled.length > 0 ? 'Cancel all transfers' : 'Close transfers'}
                    icon={XIcon}
                    onClick={() => {
                        if (unsettled.length > 0) setConfirming(true);
                        else removeEverything();
                    }}
                />
            </header>
            {!collapsed && (
                <>
                    <ul className="max-h-[min(380px,32svh)] overflow-y-auto">
                        {down.downloads.map((item) => (
                            <DownloadRow key={item.id} item={item} offline={offline} />
                        ))}
                        {uploadRows.map((item) => (
                            <UploadRow key={item.id} item={item} offline={offline} />
                        ))}
                    </ul>
                    {/* The batch's leftovers: clear what is done, retry what failed. */}
                    {(retryable.length > 0 || finished > 0) && (
                        <div
                            className="flex items-center justify-end gap-2 border-t border-rule bg-muted px-4 py-2.5"
                            data-batch-actions
                        >
                            {finished > 0 && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => {
                                        transfers.clearFinished();
                                        downloads.clearFinished();
                                    }}
                                >
                                    Clear finished
                                </Button>
                            )}
                            {retryable.length > 0 && (
                                <Button
                                    size="sm"
                                    onClick={() => {
                                        for (const item of retryable) void transfers.retry(item.id);
                                    }}
                                >
                                    <RotateCcwIcon />
                                    {retryable.length === 1
                                        ? 'Retry the failed one'
                                        : `Retry ${retryable.length} failed`}
                                </Button>
                            )}
                        </div>
                    )}
                </>
            )}
            <AlertDialog open={confirming} onOpenChange={setConfirming}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            {unsettled.length === 1
                                ? 'Cancel this transfer?'
                                : `Cancel ${unsettled.length} transfers?`}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            What is still on its way stops and isn’t kept. What already finished
                            stays where it is.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Keep going</AlertDialogCancel>
                        <AlertDialogAction
                            variant="destructive"
                            onClick={() => {
                                setConfirming(false);
                                void cancelEverything();
                            }}
                        >
                            {unsettled.length === 1 ? 'Cancel it' : 'Cancel them all'}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </section>
    );
}

import type { DownloadItem } from '@hushos/drive/downloads';
import type { UploadItem } from '@hushos/drive/transfers';

/*
 * The transfers panel's one headline (DESIGN.md, Transfers), from what is in
 * the list. An upload waiting out a family folder's key change moves nothing:
 * it is never counted as uploading, so the panel shows no progress, bytes or
 * Pause for it, and says what it waits for.
 */

export const WAITING_FOR_CONNECTION = 'Waiting for a connection';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* An upload held until a family folder's key change reaches its folder; it goes on by itself. */
export function waitsForKeyChange(item: Pick<UploadItem, 'status' | 'waitingFor'>) {
    return (
        (item.status === 'preparing' || item.status === 'completing') && Boolean(item.waitingFor)
    );
}

export type HeadlineMode = 'offline' | 'moving' | 'waiting' | 'paused' | 'failed' | 'done';

export function transferHeadline({
    uploads,
    downloads,
    downloadsActive,
    offline,
}: {
    uploads: readonly Pick<UploadItem, 'status' | 'waitingFor'>[];
    downloads: readonly Pick<DownloadItem, 'status'>[];
    /* The downloads engine's own count of those moving. */
    downloadsActive: number;
    offline: boolean;
}): { title: string; mode: HeadlineMode; uploading: number; moving: number; waiting: number } {
    const waiting = uploads.filter(waitsForKeyChange).length;
    const uploading = uploads.filter(
        (item) =>
            !waitsForKeyChange(item) &&
            (item.status === 'preparing' ||
                item.status === 'uploading' ||
                item.status === 'completing'),
    ).length;
    const moving = uploading + downloadsActive;
    const count = (status: string) =>
        uploads.filter((item) => item.status === status).length +
        downloads.filter((item) => item.status === status).length;
    const paused = count('paused');
    const failed = count('failed');
    const doneUploads = uploads.filter((item) => item.status === 'done').length;
    const doneDownloads = downloads.filter((item) => item.status === 'done').length;
    const out = (title: string, mode: HeadlineMode) => ({
        title,
        mode,
        uploading,
        moving,
        waiting,
    });
    if (moving > 0 && offline) return out(WAITING_FOR_CONNECTION, 'offline');
    if (uploading && downloadsActive)
        return out(`Transferring ${plural(moving, 'file')}`, 'moving');
    if (uploading) return out(`Uploading ${plural(uploading, 'file')}`, 'moving');
    if (downloadsActive) return out(`Downloading ${plural(downloadsActive, 'file')}`, 'moving');
    if (waiting) return out(`${plural(waiting, 'file')} waiting for a key change`, 'waiting');
    if (paused) return out(`${paused} paused`, 'paused');
    if (failed) return out(`${plural(failed, 'transfer')} didn’t finish`, 'failed');
    if (doneDownloads === 0 && doneUploads > 0)
        return out(`${plural(doneUploads, 'file')} uploaded`, 'done');
    return out(`${plural(doneUploads + doneDownloads, 'transfer')} finished`, 'done');
}

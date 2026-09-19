import type { ReportCategory, ReportStatus, ReportView } from '@hushos/drive/api';
import { contentSize, type DriveNode } from '@hushos/drive/client';
import { queryOptions } from '@tanstack/react-query';
import { reportApi } from '@/lib/drive-api';
import { driveClient } from '@/lib/drive';
import { openReader, readAll } from '@/lib/previews';

/*
 * Reports, from both sides. A reporter's device seals the node key to every
 * operator and, for a file it can read in one go, digests the plaintext so the
 * report carries a hash an authority can match. An operator's queue is ordered
 * by the clock each category runs on.
 */

export const CATEGORIES: { value: ReportCategory; label: string }[] = [
    { value: 'csam', label: 'Child sexual abuse material' },
    { value: 'terrorism', label: 'Terrorist or violent extremist content' },
    { value: 'ncii', label: 'Intimate images shared without consent' },
    { value: 'malware', label: 'Malware or phishing' },
    { value: 'copyright', label: 'Copyright infringement' },
    { value: 'harassment', label: 'Harassment or threats' },
    { value: 'other', label: 'Something else' },
];
export function categoryLabel(category: ReportCategory) {
    return CATEGORIES.find((entry) => entry.value === category)?.label ?? category;
}

/*
 * How long an open report of each kind should wait, in hours: terrorist
 * content under the EU's one-hour removal orders, intimate images under the
 * 48 hours the Take It Down Act allows, child sexual abuse material a day as
 * an internal target ahead of the CyberTipline filing, the rest a working
 * week. These are defaults for the queue's ordering and colour, not legal advice.
 */
export const DUE_HOURS: Record<ReportCategory, number> = {
    terrorism: 1,
    csam: 24,
    ncii: 48,
    malware: 72,
    harassment: 72,
    copyright: 168,
    other: 168,
};
export function dueAt(report: Pick<ReportView, 'category' | 'createdAt'>) {
    return new Date(new Date(report.createdAt).getTime() + DUE_HOURS[report.category] * 3600_000);
}
export function describeDue(report: Pick<ReportView, 'category' | 'createdAt' | 'status'>) {
    if (report.status !== 'open') return null;
    const remaining = dueAt(report).getTime() - Date.now();
    const hours = Math.abs(remaining) / 3600_000;
    const span =
        hours < 1
            ? `${Math.max(1, Math.round(hours * 60))}m`
            : hours < 48
              ? `${Math.round(hours)}h`
              : `${Math.round(hours / 24)}d`;
    return remaining < 0
        ? { overdue: true, label: `${span} overdue` }
        : { overdue: false, label: `${span} left` };
}

export const STATUS_LABELS: Record<ReportStatus, string> = {
    open: 'Open',
    dismissed: 'Dismissed',
    removed: 'Content removed',
    filed: 'Filed with an authority',
};

export const reportKeys = {
    all: ['reports'] as const,
    list: (filter: { status?: string; category?: string }) =>
        ['reports', 'list', filter.status ?? 'open', filter.category ?? ''] as const,
    one: (reportId: string) => ['reports', 'one', reportId] as const,
};
export const reportsQueryOptions = (filter: {
    status?: ReportStatus | 'all';
    category?: ReportCategory;
}) =>
    queryOptions({
        queryKey: reportKeys.list(filter),
        queryFn: () => reportApi.list(filter),
        staleTime: 10_000,
        retry: false,
    });
export const reportQueryOptions = (reportId: string) =>
    queryOptions({
        queryKey: reportKeys.one(reportId),
        queryFn: () => reportApi.get(reportId),
        staleTime: 5_000,
        retry: false,
    });

/* Files up to this size are digested on the reporter's device; larger ones are reported without a hash. */
export const HASH_MAX_BYTES = 64 * 1024 * 1024;

async function contentHash(node: DriveNode) {
    if (node.kind !== 'file') return null;
    if ((contentSize(node) ?? 0) > HASH_MAX_BYTES) return null;
    const reader = openReader(node);
    try {
        const { bytes } = await readAll(reader, HASH_MAX_BYTES);
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return btoa(String.fromCharCode(...digest))
            .replaceAll('+', '-')
            .replaceAll('/', '_')
            .replace(/=+$/, '');
    } catch {
        return null;
    } finally {
        await reader.close();
    }
}

export async function fileReport(
    node: DriveNode,
    input: {
        category: ReportCategory;
        reason: string;
        via: { link: string } | { share: true };
        reporterEmail: string | null;
    },
) {
    return driveClient.fileReport(node, { ...input, contentHash: await contentHash(node) });
}

import { DriveApiError, type DriveApi, type LinkApi, type ReportApi } from '@hushos/drive/api';
import { apiClient } from '@/lib/api-client';

const api = () => apiClient().drive;

/*
 * A visitor holding a link has no session. While the link page is open, reads
 * inside the linked workspace go through the link's own endpoints, so the
 * engines (downloads, previews, thumbnails) need no idea a link is in play.
 */
let activeLink: { token: string; workspaceId: string } | null = null;
export function setActiveLink(link: { token: string; workspaceId: string } | null) {
    activeLink = link;
}
function viaLink(workspaceId: string) {
    return activeLink && activeLink.workspaceId === workspaceId ? activeLink.token : null;
}
/* Likewise for an operator reviewing a report: reads in the reported workspace come from the snapshot. */
let activeReport: {
    reportId: string;
    workspaceId: string;
    /* URLs to the evidence copies, by version, once the worker answered a request for them. */
    evidenceUrls?: { urls: Record<string, string>; expiresAt: string };
} | null = null;
export function setActiveReport(report: typeof activeReport) {
    activeReport = report;
}
export function setEvidenceUrls(urls: Record<string, string>, expiresAt: string) {
    if (activeReport) activeReport = { ...activeReport, evidenceUrls: { urls, expiresAt } };
}
function viaReport(workspaceId: string) {
    return activeReport && activeReport.workspaceId === workspaceId ? activeReport.reportId : null;
}
function evidenceUrl(versionId: string) {
    const held = activeReport?.evidenceUrls;
    if (!held || new Date(held.expiresAt).getTime() <= Date.now()) return null;
    return held.urls[versionId] ? { url: held.urls[versionId], expiresAt: held.expiresAt } : null;
}

/* Like `unwrap`, but keeps the code and data a Drive refusal carries. */
async function unwrapDrive<R extends { data: unknown; error: unknown; status: number }>(
    pending: Promise<R>,
) {
    const { data, error, status } = await pending;
    if (error) {
        const value = (error as { value?: unknown }).value;
        const body =
            value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
        throw new DriveApiError(
            typeof body?.message === 'string' ? body.message : 'Please try again.',
            typeof body?.code === 'string'
                ? (body.code as DriveApiError['code'])
                : status === 401
                  ? 'forbidden'
                  : 'unavailable',
            status,
            body?.data,
        );
    }
    return data as NonNullable<R['data']>;
}

export const driveApi: DriveApi = {
    capabilities: () => unwrapDrive(api().capabilities.get()),
    workspace: () => unwrapDrive(api().workspace.get()),
    allocateEpochs: (workspaceId, count) =>
        unwrapDrive(api().workspaces({ id: workspaceId }).epochs.post({ count })),
    createRoot: (workspaceId, input) =>
        unwrapDrive(api().workspaces({ id: workspaceId }).root.post(input)),
    children: (workspaceId, parentId, after) => {
        const token = viaLink(workspaceId);
        if (token) return linkApi.children(token, parentId, after);
        const reportId = viaReport(workspaceId);
        if (reportId) return reportApi.children(reportId, parentId);
        return unwrapDrive(
            api()
                .nodes({ id: parentId })
                .children.get({ query: after ? { workspaceId, after } : { workspaceId } }),
        );
    },
    createFolders: (workspaceId, folders) =>
        unwrapDrive(api().folders.post({ workspaceId, folders })),
    rename: (workspaceId, nodeId, input) =>
        unwrapDrive(
            api()
                .nodes({ id: nodeId })
                .metadata.post({ workspaceId, ...input }),
        ),
    move: (workspaceId, nodeId, input) =>
        unwrapDrive(
            api()
                .nodes({ id: nodeId })
                .parent.post({ workspaceId, ...input }),
        ),
    trash: (workspaceId, nodeId) =>
        unwrapDrive(api().nodes({ id: nodeId }).trash.post({ workspaceId })),
    restore: (workspaceId, nodeId, toRoot) =>
        unwrapDrive(
            api()
                .nodes({ id: nodeId })
                .restore.post(toRoot ? { workspaceId, toRoot } : { workspaceId }),
        ),
    beginUpload: (workspaceId, input) => unwrapDrive(api().uploads.post({ workspaceId, ...input })),
    uploadState: (workspaceId, uploadId) =>
        unwrapDrive(api().uploads({ id: uploadId }).get({ query: { workspaceId } })),
    uploadPartUrls: (workspaceId, uploadId, from, count) =>
        unwrapDrive(
            api()
                .uploads({ id: uploadId })
                .parts.get({ query: count ? { workspaceId, from, count } : { workspaceId, from } }),
        ),
    completeUpload: (workspaceId, uploadId, parts) =>
        unwrapDrive(api().uploads({ id: uploadId }).complete.post({ workspaceId, parts })),
    attachUpload: (workspaceId, uploadId, attach) =>
        unwrapDrive(api().uploads({ id: uploadId }).attach.post({ workspaceId, attach })),
    abortUpload: (workspaceId, uploadId) =>
        unwrapDrive(api().uploads({ id: uploadId }).abort.post({ workspaceId })),
    thumbnailUrls: (workspaceId, versionIds) => {
        const token = viaLink(workspaceId);
        if (token) return linkApi.thumbnailUrls(token, versionIds);
        const reportId = viaReport(workspaceId);
        if (reportId) return reportApi.thumbnailUrls(reportId, versionIds);
        return unwrapDrive(
            api().thumbnails.get({ query: { workspaceId, versions: versionIds.join(',') } }),
        );
    },
    downloadUrls: (workspaceId, versionIds) => {
        const token = viaLink(workspaceId);
        if (token) return linkApi.downloadUrls(token, versionIds);
        const reportId = viaReport(workspaceId);
        if (reportId) {
            const held = versionIds.flatMap((id) => {
                const found = evidenceUrl(id);
                return found ? [{ versionId: id, url: found.url, expiresAt: found.expiresAt }] : [];
            });
            if (held.length === versionIds.length)
                return Promise.resolve({ urls: held, urlExpiresAt: held[0]!.expiresAt });
            return reportApi.downloadUrls(reportId, versionIds);
        }
        return unwrapDrive(api().versions.urls.post({ workspaceId, versionIds }));
    },
    downloadUrl: (workspaceId, versionId) => {
        const token = viaLink(workspaceId);
        if (token) return linkApi.downloadUrl(token, versionId);
        const reportId = viaReport(workspaceId);
        if (reportId)
            return reportApi.downloadUrl(reportId, versionId).then((issued) => {
                const held = evidenceUrl(versionId);
                return held ? { ...issued, url: held.url, urlExpiresAt: held.expiresAt } : issued;
            });
        return unwrapDrive(api().versions({ id: versionId }).url.get({ query: { workspaceId } }));
    },
    purge: (workspaceId, nodeId) =>
        unwrapDrive(api().nodes({ id: nodeId }).delete({ workspaceId })),
    storageBreakdown: (workspaceId) =>
        unwrapDrive(api().workspaces({ id: workspaceId }).storage.get()),
    discardSupersededVersions: (workspaceId) =>
        unwrapDrive(api().workspaces({ id: workspaceId }).versions['discard-superseded'].post({})),
    emptyTrash: (workspaceId) =>
        unwrapDrive(api().workspaces({ id: workspaceId }).trash.empty.post({})),
    copy: (workspaceId, sourceNodeId, input) =>
        unwrapDrive(
            api()
                .nodes({ id: sourceNodeId })
                .copy.post({ workspaceId, ...input }),
        ),
    versions: (workspaceId, nodeId) =>
        unwrapDrive(api().nodes({ id: nodeId }).versions.get({ query: { workspaceId } })),
    restoreVersion: (workspaceId, versionId) =>
        unwrapDrive(api().versions({ id: versionId }).restore.post({ workspaceId })),
    discardVersion: (workspaceId, versionId) =>
        unwrapDrive(api().versions({ id: versionId }).delete({ workspaceId })),
    share: (workspaceId, nodeId, input) =>
        unwrapDrive(
            api()
                .nodes({ id: nodeId })
                .shares.post({ workspaceId, ...input }),
        ),
    nodeShares: (workspaceId, nodeId) =>
        unwrapDrive(api().nodes({ id: nodeId }).shares.get({ query: { workspaceId } })),
    revokeShare: (workspaceId, shareId) =>
        unwrapDrive(api().shares({ id: shareId }).delete({ workspaceId })),
    resealShare: (workspaceId, shareId, input) =>
        unwrapDrive(
            api()
                .shares({ id: shareId })
                .envelope.put({ workspaceId, ...input }),
        ),
    sharedWithMe: () => unwrapDrive(api().shares.get()),
    sharedByMe: () => unwrapDrive(api().shares.mine.get()),
    createLink: (workspaceId, nodeId, input) =>
        unwrapDrive(
            api()
                .nodes({ id: nodeId })
                .links.post({ workspaceId, ...input }),
        ),
    nodeLinks: (workspaceId, nodeId) =>
        unwrapDrive(api().nodes({ id: nodeId }).links.get({ query: { workspaceId } })),
    updateLink: (workspaceId, linkId, input) =>
        unwrapDrive(
            api()
                .links({ id: linkId })
                .patch({ workspaceId, ...input }),
        ),
    revokeLink: (workspaceId, linkId) =>
        unwrapDrive(api().links({ id: linkId }).delete({ workspaceId })),
    trashListing: (workspaceId, after) =>
        unwrapDrive(
            api()
                .workspaces({ id: workspaceId })
                .trash.get({ query: after ? { after } : {} }),
        ),
    changes: (workspaceId, since, limit) =>
        unwrapDrive(
            api()
                .workspaces({ id: workspaceId })
                .changes.get({ query: limit ? { since, limit } : { since } }),
        ),
    shareChanges: (shareId, since) =>
        unwrapDrive(api().shares({ id: shareId }).changes.get({ query: { since } })),
    startRotation: (workspaceId, nodeId) =>
        unwrapDrive(api().nodes({ id: nodeId }).rotation.post({ workspaceId })),
    rotationWork: (workspaceId, nodeId, after) =>
        unwrapDrive(
            api()
                .nodes({ id: nodeId })
                .rotation.work.get({ query: after ? { workspaceId, after } : { workspaceId } }),
        ),
    rotateNodes: (workspaceId, nodeId, nodes) =>
        unwrapDrive(api().nodes({ id: nodeId }).rotation.nodes.post({ workspaceId, nodes })),
    reportOperators: () => unwrapDrive(api().reports.operators.get()),
    report: (input) => unwrapDrive(api().reports.post(input)),
};

export const linkApi: LinkApi = {
    open: (token) => unwrapDrive(api().links({ id: token }).open.get()),
    children: (token, parentId, after) =>
        unwrapDrive(
            api()
                .links({ id: token })
                .nodes({ nodeId: parentId })
                .children.get({ query: after ? { after } : {} }),
        ),
    downloadUrl: (token, versionId) =>
        unwrapDrive(api().links({ id: token }).versions({ versionId }).url.get()),
    downloadUrls: (token, versionIds) =>
        unwrapDrive(api().links({ id: token }).versions.urls.post({ versionIds })),
    thumbnailUrls: (token, versionIds) =>
        unwrapDrive(
            api()
                .links({ id: token })
                .thumbnails.get({ query: { versions: versionIds.join(',') } }),
        ),
};

const admin = () => apiClient().admin;
export const reportApi: ReportApi = {
    list: (filter) =>
        unwrapDrive(
            admin().reports.get({
                query: {
                    ...(filter.status ? { status: filter.status } : {}),
                    ...(filter.category ? { category: filter.category } : {}),
                },
            }),
        ),
    get: (reportId) => unwrapDrive(admin().reports({ id: reportId }).get()),
    open: (reportId) => unwrapDrive(admin().reports({ id: reportId }).open.post({})),
    children: (reportId, parentId) =>
        unwrapDrive(admin().reports({ id: reportId }).nodes({ nodeId: parentId }).children.get()),
    downloadUrl: (reportId, versionId) =>
        unwrapDrive(admin().reports({ id: reportId }).versions({ versionId }).url.get()),
    downloadUrls: (reportId, versionIds) =>
        unwrapDrive(admin().reports({ id: reportId }).versions.urls.post({ versionIds })),
    resolve: (reportId, resolution) =>
        unwrapDrive(admin().reports({ id: reportId }).resolve.post(resolution)),
    hold: (reportId, held) => unwrapDrive(admin().reports({ id: reportId }).hold.post({ held })),
    reopen: (reportId) => unwrapDrive(admin().reports({ id: reportId }).reopen.post({})),
    suspendUploader: (reportId, suspended) =>
        unwrapDrive(admin().reports({ id: reportId }).uploader.post({ suspended })),
    note: (reportId, note) => unwrapDrive(admin().reports({ id: reportId }).notes.post({ note })),
    thumbnailUrls: (reportId, versionIds) =>
        unwrapDrive(
            admin()
                .reports({ id: reportId })
                .thumbnails.get({ query: { versions: versionIds.join(',') } }),
        ),
    requestEvidence: (reportId) => unwrapDrive(admin().reports({ id: reportId }).evidence.post({})),
    evidenceRequest: (reportId, requestId) =>
        unwrapDrive(admin().reports({ id: reportId }).evidence({ requestId }).get()),
    recordPacket: (reportId) => unwrapDrive(admin().reports({ id: reportId }).packet.post({})),
    keyHolders: (reportId) => unwrapDrive(admin().reports({ id: reportId }).keys.get()),
    reseal: (reportId, keys) => unwrapDrive(admin().reports({ id: reportId }).keys.post({ keys })),
};

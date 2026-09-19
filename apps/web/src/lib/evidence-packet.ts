import type { ReportEventView, ReportView } from '@hushos/drive/api';
import { contentSize, type DriveNode } from '@hushos/drive/client';
import { makeZip } from 'client-zip';
import { createMD5, createSHA1 } from 'hash-wasm';
import { openSink } from '@/lib/download-sinks';
import { driveClient } from '@/lib/drive';
import { openReader, readAll } from '@/lib/previews';
import { DISCLAIMER, GUIDANCE } from '@/lib/authorities';
import { categoryLabel, STATUS_LABELS } from '@/lib/reports';

/*
 * The evidence packet: everything an operator hands to an authority, built on
 * their device from the report and the decrypted content. A zip holding the
 * report as JSON and as prose, the record, every file's hashes (MD5 and SHA-1
 * because hotlines still key on them, SHA-256 because they should), the
 * category's guidance, and the files themselves except where possessing them
 * would itself be the offence.
 */

export const PACKET_FILE_MAX_BYTES = 256 * 1024 * 1024;

type Hashed = {
    path: string;
    name: string;
    size: number;
    mime: string | null;
    modified: string | null;
    versionId: string | null;
    md5: string | null;
    sha1: string | null;
    sha256: string | null;
    omitted: string | null;
};

async function digests(bytes: Uint8Array<ArrayBuffer>) {
    const [md5, sha1] = await Promise.all([createMD5(), createSHA1()]);
    md5.update(bytes);
    sha1.update(bytes);
    const sha256 = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return {
        md5: md5.digest('hex'),
        sha1: sha1.digest('hex'),
        sha256: Array.from(sha256, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
}

const safe = (name: string) => name.replaceAll(/[\\/:*?"<>|]/g, '_');

export async function buildEvidencePacket(
    report: ReportView,
    events: ReportEventView[],
    root: DriveNode,
    onProgress?: (done: number, total: number) => void,
) {
    const guidance = GUIDANCE[report.category];
    const includeFiles = guidance.includeFiles;
    // Walk the snapshot the way the operator sees it, names decrypted on this device.
    const files: { node: DriveNode; path: string }[] = [];
    async function walk(node: DriveNode, prefix: string) {
        if (node.kind === 'file') {
            files.push({ node, path: `${prefix}${safe(node.name)}` });
            return;
        }
        const listing = await driveClient.listFolder(node.id);
        for (const child of listing.children) await walk(child, `${prefix}${safe(node.name)}/`);
    }
    await walk(root, '');

    const hashed: Hashed[] = [];
    const contents: { name: string; input: Uint8Array; lastModified?: Date }[] = [];
    let done = 0;
    for (const file of files) {
        const size = contentSize(file.node) ?? 0;
        const base: Hashed = {
            path: file.path,
            name: file.node.name,
            size,
            mime: file.node.metadata?.mime ?? null,
            modified: file.node.metadata?.modified ?? null,
            versionId: file.node.currentVersion?.id ?? null,
            md5: null,
            sha1: null,
            sha256: null,
            omitted: null,
        };
        if (!file.node.currentVersion) {
            hashed.push({ ...base, omitted: 'no content' });
        } else if (size > PACKET_FILE_MAX_BYTES) {
            hashed.push({ ...base, omitted: `larger than ${PACKET_FILE_MAX_BYTES} bytes` });
        } else {
            const reader = openReader(file.node);
            try {
                const { bytes } = await readAll(reader, PACKET_FILE_MAX_BYTES);
                hashed.push({
                    ...base,
                    ...(await digests(bytes as Uint8Array<ArrayBuffer>)),
                    omitted: includeFiles ? null : 'withheld: hashes only for this category',
                });
                if (includeFiles)
                    contents.push({
                        name: `files/${file.path}`,
                        input: bytes,
                        lastModified: file.node.metadata?.modified
                            ? new Date(file.node.metadata.modified)
                            : undefined,
                    });
            } catch (error) {
                hashed.push({
                    ...base,
                    omitted: `could not be read: ${error instanceof Error ? error.message : 'unknown error'}`,
                });
            } finally {
                await reader.close();
            }
        }
        done += 1;
        onProgress?.(done, files.length);
    }

    const generatedAt = new Date().toISOString();
    const summary = {
        generatedAt,
        report,
        item: { id: root.id, name: root.name, kind: root.kind },
        files: hashed,
        record: events,
        guidance: { ...guidance, disclaimer: DISCLAIMER },
    };
    const text = [
        `HushOS evidence packet`,
        `Generated ${generatedAt}`,
        ``,
        `Report ${report.id}`,
        `Category: ${categoryLabel(report.category)}`,
        `Status: ${STATUS_LABELS[report.status]}${report.heldAt ? ' (on hold)' : ''}`,
        `Reported: ${report.createdAt} via ${report.via}`,
        `Reporter: ${report.reporter.userId ? `account ${report.reporter.userId}` : `anonymous${report.reporter.email ? `, ${report.reporter.email}` : ''}`}`,
        `Uploader: ${report.uploader.email ?? 'unknown'}${report.uploader.userId ? ` (account ${report.uploader.userId})` : ''}${report.uploader.suspended ? ', suspended' : ''}`,
        `Workspace: ${report.workspaceId}`,
        `Reported item: ${root.name} (${root.kind}, node ${root.id})`,
        report.filedWith
            ? `Filed with: ${report.filedWith}${report.filedReference ? ` · ${report.filedReference}` : ''}`
            : `Filed with: nobody yet`,
        ``,
        `Reason given by the reporter:`,
        report.reason,
        ``,
        `Files (${hashed.length})`,
        ...hashed.flatMap((file) => [
            `- ${file.path}  ${file.size} bytes${file.mime ? `  ${file.mime}` : ''}${file.modified ? `  modified ${file.modified}` : ''}`,
            `    md5 ${file.md5 ?? '-'}`,
            `    sha1 ${file.sha1 ?? '-'}`,
            `    sha256 ${file.sha256 ?? '-'}`,
            ...(file.omitted ? [`    ${file.omitted}`] : []),
        ]),
        ``,
        `Record`,
        ...events.map(
            (event) =>
                `- ${event.createdAt}  ${event.action}${event.actorUserId ? `  by ${event.actorUserId}` : ''}${event.note ? `  ${event.note}` : ''}`,
        ),
        ``,
        `Guidance: ${guidance.title}`,
        guidance.deadline,
        ``,
        ...guidance.handling.map((line) => `- ${line}`),
        ``,
        `Where to file`,
        ...(guidance.authorities.length
            ? guidance.authorities.map(
                  (a) =>
                      `- ${a.name} (${a.where})${a.url ? `  ${a.url}` : ''}${a.note ? `  ${a.note}` : ''}`,
              )
            : ['- No authority applies to this category as reported.']),
        ``,
        DISCLAIMER,
        ``,
    ].join('\n');
    const hashesText = hashed
        .map((file) =>
            [
                file.path,
                `md5=${file.md5 ?? '-'}`,
                `sha1=${file.sha1 ?? '-'}`,
                `sha256=${file.sha256 ?? '-'}`,
            ].join('  '),
        )
        .join('\n');
    const encoder = new TextEncoder();
    const entries = [
        { name: 'report.txt', input: encoder.encode(text) },
        { name: 'report.json', input: encoder.encode(JSON.stringify(summary, null, 2)) },
        { name: 'hashes.txt', input: encoder.encode(`${hashesText}\n`) },
        ...contents,
    ];
    return { entries, files: hashed, includeFiles };
}

/* Streams the zip to disk through the same sinks a download uses. */
export async function saveEvidencePacket(
    report: ReportView,
    entries: { name: string; input: Uint8Array; lastModified?: Date }[],
) {
    const name = `hushos-report-${report.id.slice(0, 8)}-${report.category}.zip`;
    const sink = await openSink({ name, size: null });
    try {
        const reader = makeZip(
            entries.map((e) => ({ ...e, input: e.input as BlobPart })),
        ).getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            await sink.write(value);
        }
        await sink.close();
    } catch (error) {
        await sink.abort(error);
        throw error;
    }
    return name;
}

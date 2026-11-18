import type { DriveNode } from '@hushos/drive/client';
import { PREVIEW_LIMITS } from '@/lib/preview-limits';
import { extensionOf, previewKindOf } from '@/lib/previews';

/*
 * Which files the text editor opens, and whether it may change them
 * (docs/editing-design.md section 1, Editing 1a). An edit is saved byte for
 * byte except for what the person changed, so a file opens for editing only
 * when its bytes come back out of the editor exactly as they went in: UTF-8
 * without a byte order mark, lines ending in LF alone, and text rather than
 * binary. Anything else opens read-only with a plain note; byte order marks,
 * UTF-16 and CRLF are Editing 1b's.
 *
 * The phones ask the same of the core (crates/hushos-core/src/text_edit.rs),
 * and both are held to fixtures/text-edit-cases.json.
 */

/* Up to the text preview limit (8 MiB). A larger file opens read-only. */
export const TEXT_EDIT_LIMIT = PREVIEW_LIMITS.text;

/* Why a text file opens read-only. */
export type ReadOnlyReason =
    | 'too-large'
    | 'byte-order-mark'
    | 'utf-16'
    | 'encoding'
    | 'binary'
    | 'line-endings';

/* What each reason says, in one sentence, on every client. */
export const READ_ONLY_WORDS: Record<ReadOnlyReason, string> = {
    'too-large': 'This file is too large to edit here.',
    'byte-order-mark': 'HushOS can’t edit this file’s encoding yet.',
    'utf-16': 'HushOS can’t edit this file’s encoding yet.',
    encoding: 'This file uses an encoding HushOS can’t edit without changing it.',
    binary: 'This file isn’t plain text, so it can’t be edited here.',
    'line-endings': 'This file uses Windows line endings, which HushOS can’t edit yet.',
};

/* The viewer's own sniff (looksLikeText): this much of the start is looked at for control characters. */
const SNIFF_BYTES = 8 * 1024;

/*
 * Why these bytes can't be edited without changing what the person didn't
 * touch, or null when they can. In this order: the size, a byte order mark
 * (UTF-8, then UTF-16 either way), bytes that aren't UTF-8, binary (a NUL
 * anywhere, or more than 2% control characters in the first 8 KiB, as the
 * viewer decides), then a carriage return anywhere.
 */
export function readOnlyReason(bytes: Uint8Array): ReadOnlyReason | null {
    if (bytes.length > TEXT_EDIT_LIMIT) return 'too-large';
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'byte-order-mark';
    if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
        return 'utf-16';
    try {
        new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return 'encoding';
    }
    if (bytes.includes(0)) return 'binary';
    const sample = bytes.subarray(0, SNIFF_BYTES);
    let control = 0;
    for (const byte of sample)
        if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13) control++;
    if (sample.length > 0 && control / sample.length > 0.02) return 'binary';
    if (bytes.includes(13)) return 'line-endings';
    return null;
}

export type TextOpen =
    | { editable: true; text: string }
    | { editable: false; reason: ReadOnlyReason; text: string | null };

/*
 * The bytes as the editor holds them: the text, editable when it comes back
 * out byte for byte (encodeText). A read-only file still shows its text where
 * it decodes as UTF-8, never past the limit.
 */
export function openText(bytes: Uint8Array): TextOpen {
    const reason = readOnlyReason(bytes);
    if (reason === null)
        return {
            editable: true,
            text: new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes),
        };
    if (reason === 'too-large' || reason === 'binary' || reason === 'utf-16')
        return { editable: false, reason, text: null };
    // Shown as the viewer shows it (a byte order mark dropped, anything not UTF-8 replaced): never saved.
    return { editable: false, reason, text: new TextDecoder().decode(bytes) };
}

/* What a save writes: the text as UTF-8, nothing added, nothing taken away. */
export function encodeText(text: string) {
    return new TextEncoder().encode(text);
}

/*
 * Whether a file is one the editor opens, from its recorded type and name: what
 * the viewer shows as text or Markdown, CSV and TSV (as text, before the table
 * of Editing 2), and SVG (always as text, never rendered from the editor). The
 * bytes decide after that (readOnlyReason).
 */
export function editableKind(name: string, mime: string | null | undefined) {
    const type = (mime ?? '').split(';')[0]!.trim().toLowerCase();
    const ext = extensionOf(name);
    if (type === 'image/svg+xml' || ext === 'svg') return true;
    if (type === 'text/csv' || type === 'text/tab-separated-values') return true;
    if (ext === 'csv' || ext === 'tsv') return true;
    const kind = previewKindOf(name, mime);
    return kind === 'text' || kind === 'markdown';
}

/*
 * A file the editor opens: its current version, never an earlier one, by kind, or (`sniffed`) a
 * file of no known kind the viewer found to be text by reading it (an extensionless README). The
 * bytes still decide after that (readOnlyReason).
 */
export function editableFile(node: DriveNode, sniffed = false) {
    if (node.kind !== 'file' || node.currentVersion === null) return false;
    if (editableKind(node.name, node.metadata?.mime)) return true;
    return sniffed && previewKindOf(node.name, node.metadata?.mime) === 'none';
}

/* A share this person received: where it is (its workspace and node) and what it lets them do. */
export type Grant = { workspaceId: string; nodeId: string; role: 'viewer' | 'editor' };

/*
 * Whether this person may change a file in someone else's folder: as the server decides it
 * (packages/db accessFor), the grant nearest the file wins, the file's own first, then each folder
 * up. A viewer's grant there wins over an editor's further up (two grants on one node: the viewer's).
 * A grant on the file itself never lets it be edited: its folder can't be listed, and a save needs it.
 * `chain`: the file, then its folders up to the top, nearest first; matched by workspace and id.
 */
export function editableThroughShares(
    chain: readonly { id: string; workspaceId: string }[],
    grants: readonly Grant[],
) {
    for (const [index, node] of chain.entries()) {
        const here = grants.filter(
            (grant) => grant.nodeId === node.id && grant.workspaceId === node.workspaceId,
        );
        if (!here.length) continue;
        return index > 0 && here.every((grant) => grant.role === 'editor');
    }
    return false;
}

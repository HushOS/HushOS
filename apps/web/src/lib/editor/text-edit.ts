import type { DriveNode } from '@hushos/drive/client';
import { PREVIEW_LIMITS } from '@/lib/viewers/preview-limits';
import { extensionOf, previewKindOf } from '@/lib/viewers/previews';

/*
 * Which files the text editor opens, whether it may change them, and the bytes a save writes
 * (docs/editing-design.md section 1, Editing 1a and 1b). An edit is saved byte for byte except
 * for what the person changed, so a file opens for editing only when the editor can write it
 * back in its own encoding, byte order mark and line endings:
 *
 * - UTF-8 with or without a byte order mark, or UTF-16 either way with one;
 * - lines ending in LF or CRLF; a file mixing them keeps the majority on an edit, and says so;
 * - text rather than binary.
 *
 * Anything else opens read-only with a plain note and is never transcoded. The editor holds the
 * text without its byte order mark and with every line break as LF (as CodeMirror does); a save
 * writes it back in the file's encoding and line breaks, and a text still as it opened is its
 * original bytes again.
 *
 * The phones ask the same of the core (crates/hushos-core/src/tools/text_edit.rs), and all are held to
 * fixtures/text-edit-cases.json.
 */

/* Up to the text preview limit (8 MiB), on the file's bytes. A larger file opens read-only. */
export const TEXT_EDIT_LIMIT = PREVIEW_LIMITS.text;

/* Why a text file opens read-only. */
export type ReadOnlyReason = 'too-large' | 'encoding' | 'binary' | 'line-endings';

/* What each reason says, in one sentence, on every client. */
export const READ_ONLY_WORDS: Record<ReadOnlyReason, string> = {
    'too-large': 'This file is too large to edit here.',
    encoding: 'This file uses an encoding HushOS can’t edit without changing it.',
    binary: 'This file isn’t plain text, so it can’t be edited here.',
    'line-endings': 'This file uses line endings HushOS can’t edit without changing them.',
};

export type TextEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be';
export type LineEnding = 'lf' | 'crlf';

/*
 * An editable file's encoding, the line break a save writes (the majority when it mixes them, the
 * first one's on a tie, LF when it has none), and whether it mixes LF and CRLF.
 */
export type TextFormat = { encoding: TextEncoding; lineEnding: LineEnding; mixed: boolean };

/* What the editor says of a file that mixes line endings: an edit writes them all one way. */
export function mixedNote(format: TextFormat) {
    if (!format.mixed) return null;
    return `This file mixes line endings; saving uses ${format.lineEnding === 'crlf' ? 'Windows (CRLF)' : 'Unix (LF)'}.`;
}

/* The viewer's own sniff (looksLikeText): this much of the start is looked at for control characters. */
const SNIFF_BYTES = 8 * 1024;

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
    prefix.every((byte, at) => bytes[at] === byte);
const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16_LE_BOM = [0xff, 0xfe] as const;
const UTF16_BE_BOM = [0xfe, 0xff] as const;

const unitAt = (bytes: Uint8Array, at: number, encoding: TextEncoding) =>
    encoding === 'utf-16be'
        ? (bytes[at]! << 8) | bytes[at + 1]!
        : bytes[at]! | (bytes[at + 1]! << 8);

/* UTF-16 code units, or null for an odd length or a surrogate without its pair. */
function decodeUtf16(payload: Uint8Array, encoding: TextEncoding) {
    if (payload.length % 2 !== 0) return null;
    const units = new Uint16Array(payload.length / 2);
    for (let at = 0; at < units.length; at++) units[at] = unitAt(payload, at * 2, encoding);
    for (let at = 0; at < units.length; at++) {
        const unit = units[at]!;
        if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = units[at + 1];
            if (next === undefined || next < 0xdc00 || next > 0xdfff) return null;
            at++;
        } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
    }
    let text = '';
    // In pieces: an 8 MiB file's units are too many arguments for one call.
    for (let at = 0; at < units.length; at += 8192)
        text += String.fromCharCode(...units.subarray(at, at + 8192));
    return text;
}

/*
 * UTF-16 that came without a byte order mark: an even length whose NUL bytes in the first 8 KiB
 * all sit on one side of each pair and make up at least half of those pairs. Never transcoded: it
 * gets the encoding note rather than "not plain text".
 */
function utf16WithoutMark(bytes: Uint8Array) {
    if (bytes.length < 2 || bytes.length % 2 !== 0) return false;
    const sample = bytes.subarray(0, SNIFF_BYTES);
    let even = 0;
    let odd = 0;
    for (let at = 0; at < sample.length; at++)
        if (sample[at] === 0) {
            if (at % 2 === 0) even++;
            else odd++;
        }
    const pairs = Math.floor(sample.length / 2);
    return (even === 0 && odd * 2 >= pairs) || (odd === 0 && even * 2 >= pairs);
}

const isControl = (value: number) =>
    value < 32 && value !== 9 && value !== 10 && value !== 12 && value !== 13;

/*
 * The viewer's binary rule on the text's own bytes (after any byte order mark): a NUL anywhere,
 * or control characters in more than 2% of the first 8 KiB, in bytes for UTF-8 and in code units
 * for UTF-16.
 */
function binary(payload: Uint8Array, encoding: TextEncoding) {
    const sample = payload.subarray(0, SNIFF_BYTES);
    if (encoding === 'utf-8' || encoding === 'utf-8-bom') {
        if (payload.includes(0)) return true;
        let control = 0;
        for (const byte of sample) if (isControl(byte)) control++;
        return sample.length > 0 && control / sample.length > 0.02;
    }
    for (let at = 0; at + 1 < payload.length; at += 2)
        if (unitAt(payload, at, encoding) === 0) return true;
    const units = Math.floor(sample.length / 2);
    let control = 0;
    for (let at = 0; at + 1 < sample.length; at += 2)
        if (isControl(unitAt(sample, at, encoding))) control++;
    return units > 0 && control * 50 > units;
}

/*
 * The line break a save writes and whether the text mixes LF and CRLF, or null for a carriage
 * return on its own. The majority wins; a tie goes to the first break; no break at all is LF.
 */
function lineEndingsOf(text: string): { lineEnding: LineEnding; mixed: boolean } | null {
    let lf = 0;
    let crlf = 0;
    let first: LineEnding | null = null;
    for (let at = 0; at < text.length; at++) {
        const code = text.charCodeAt(at);
        if (code === 13) {
            if (text.charCodeAt(at + 1) !== 10) return null;
            crlf++;
            first ??= 'crlf';
            at++;
        } else if (code === 10) {
            lf++;
            first ??= 'lf';
        }
    }
    const lineEnding = crlf > lf ? 'crlf' : lf > crlf ? 'lf' : (first ?? 'lf');
    return { lineEnding, mixed: lf > 0 && crlf > 0 };
}

export type TextOpen =
    | { editable: true; format: TextFormat; text: string }
    | { editable: false; reason: ReadOnlyReason; text: string | null };

/*
 * The bytes as the editor holds them. In this order: the size, the encoding (a UTF-8 or UTF-16
 * byte order mark, else UTF-8; UTF-16 without one, or bytes that don't decode, are `encoding`),
 * binary, then a lone carriage return anywhere. An editable file's text has no byte order mark and
 * every line break as LF. A read-only file still shows its words where they decode (never past the
 * limit, never binary, never a guess at another encoding), and is never saved.
 */
export function openText(bytes: Uint8Array): TextOpen {
    if (bytes.length > TEXT_EDIT_LIMIT) return { editable: false, reason: 'too-large', text: null };
    let encoding: TextEncoding = 'utf-8';
    let payload = bytes;
    if (startsWith(bytes, UTF8_BOM)) [encoding, payload] = ['utf-8-bom', bytes.subarray(3)];
    else if (startsWith(bytes, UTF16_LE_BOM)) [encoding, payload] = ['utf-16le', bytes.subarray(2)];
    else if (startsWith(bytes, UTF16_BE_BOM)) [encoding, payload] = ['utf-16be', bytes.subarray(2)];
    let decoded: string;
    if (encoding === 'utf-8' || encoding === 'utf-8-bom') {
        if (encoding === 'utf-8' && utf16WithoutMark(payload))
            return { editable: false, reason: 'encoding', text: null };
        try {
            decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload);
        } catch {
            // Shown as the viewer shows it (anything not UTF-8 replaced): never saved.
            const shown = new TextDecoder('utf-8', { ignoreBOM: true }).decode(payload);
            return { editable: false, reason: 'encoding', text: shown };
        }
    } else {
        const text = decodeUtf16(payload, encoding);
        if (text === null) return { editable: false, reason: 'encoding', text: null };
        decoded = text;
    }
    if (binary(payload, encoding)) return { editable: false, reason: 'binary', text: null };
    const endings = lineEndingsOf(decoded);
    if (!endings) return { editable: false, reason: 'line-endings', text: decoded };
    const text = decoded.includes('\r') ? decoded.replaceAll('\r\n', '\n') : decoded;
    return { editable: true, format: { encoding, ...endings }, text };
}

/* Why these bytes can't be edited without changing what the person didn't touch, or null when they can. */
export function readOnlyReason(bytes: Uint8Array): ReadOnlyReason | null {
    const opened = openText(bytes);
    return opened.editable ? null : opened.reason;
}

/*
 * The editor's text written in `format`, the one openText found when the file opened: every CRLF,
 * lone CR or LF as the file's line break, then encoded, the byte order mark first.
 */
export function encodeText(format: TextFormat, text: string) {
    const lines = text.replace(/\r\n?|\n/g, format.lineEnding === 'crlf' ? '\r\n' : '\n');
    if (format.encoding === 'utf-8' || format.encoding === 'utf-8-bom') {
        const body = new TextEncoder().encode(lines);
        if (format.encoding === 'utf-8') return body;
        const out = new Uint8Array(body.length + 3);
        out.set(UTF8_BOM);
        out.set(body, 3);
        return out;
    }
    const out = new Uint8Array(2 + lines.length * 2);
    out.set(format.encoding === 'utf-16le' ? UTF16_LE_BOM : UTF16_BE_BOM);
    for (let at = 0; at < lines.length; at++) {
        const unit = lines.charCodeAt(at);
        const [first, second] =
            format.encoding === 'utf-16le' ? [unit & 0xff, unit >> 8] : [unit >> 8, unit & 0xff];
        out[2 + at * 2] = first;
        out[3 + at * 2] = second;
    }
    return out;
}

/*
 * One editing session's saves: the format found when the file opened, kept for the whole session
 * (a save that removed every line break still writes CRLF for the next one typed; a text grown
 * past the limit still saves), and the text and bytes last opened or saved, which only answer
 * "nothing changed". The core's twin rule is held to the same fixture (`sessions`).
 */
export type SaveState = { format: TextFormat; text: string; bytes: Uint8Array };

/* The session of bytes that open for editing, or null when they open read-only. */
export function openedState(bytes: Uint8Array): SaveState | null {
    const opened = openText(bytes);
    return opened.editable ? { format: opened.format, text: opened.text, bytes } : null;
}

/* A surrogate without its pair: half of an emoji or another character past U+FFFF. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/*
 * Whether `text` can be written as it is. A surrogate without its pair (typing between an emoji's
 * halves, where Go to Line can put the cursor) would be written as a UTF-16 file no reader opens
 * again, and TextEncoder would write U+FFFD in its place, a character nobody typed.
 */
export function writable(text: string) {
    return !LONE_SURROGATE.test(text);
}

/*
 * What a save writes for `text`: the bytes last opened or saved while the text is still theirs (a
 * file opened and saved without an edit is byte for byte the same, a mixed one included),
 * otherwise the text in the session's format. Null when the text can't be written as it is
 * (writable): nothing is saved, and the edit stays for the person to mend.
 */
export function saveBytes(state: SaveState, text: string): Uint8Array | null {
    if (text === state.text) return state.bytes;
    return writable(text) ? encodeText(state.format, text) : null;
}

/* After a save of `text` landed as `bytes`: what the next one compares with. */
export function savedState(state: SaveState, text: string, bytes: Uint8Array): SaveState {
    return { ...state, text, bytes };
}

/*
 * The words a viewer shows for bytes it read (a part of a larger file included): UTF-16 with a
 * byte order mark as UTF-16, anything else as UTF-8 with what doesn't decode replaced. Shown only,
 * never saved.
 */
export function viewText(bytes: Uint8Array) {
    if (startsWith(bytes, UTF16_LE_BOM)) return new TextDecoder('utf-16le').decode(bytes);
    if (startsWith(bytes, UTF16_BE_BOM)) return new TextDecoder('utf-16be').decode(bytes);
    return new TextDecoder().decode(bytes);
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
 * (packages/db accessFor), the grant nearest the file decides the role, the file's own first, then
 * each folder up (two grants on one node: the viewer's). It must be an editor's, and a grant on a
 * folder above it must exist too: a save lists the file's folder, which a grant on the file alone
 * doesn't open. `chain`: the file, then its folders up to the top, nearest first; matched by
 * workspace and id.
 */
export function editableThroughShares(
    chain: readonly { id: string; workspaceId: string }[],
    grants: readonly Grant[],
) {
    let role: 'viewer' | 'editor' | null = null;
    let folderAbove = false;
    for (const [index, node] of chain.entries()) {
        const here = grants.filter(
            (grant) => grant.nodeId === node.id && grant.workspaceId === node.workspaceId,
        );
        if (!here.length) continue;
        role ??= here.every((grant) => grant.role === 'editor') ? 'editor' : 'viewer';
        if (index > 0) folderAbove = true;
        if (folderAbove) break;
    }
    return role === 'editor' && folderAbove;
}

/*
 * How many bytes `text` takes in UTF-8, counted without encoding it (what a size limit measures,
 * asked on every pause in typing). A surrogate without its pair counts as the three bytes of the
 * replacement character TextEncoder writes for it.
 */
export function utf8Length(text: string) {
    let bytes = 0;
    for (let at = 0; at < text.length; at++) {
        const unit = text.charCodeAt(at);
        if (unit < 0x80) bytes += 1;
        else if (unit < 0x800) bytes += 2;
        else if (unit >= 0xd800 && unit <= 0xdbff) {
            const next = text.charCodeAt(at + 1);
            if (next >= 0xdc00 && next <= 0xdfff) {
                bytes += 4;
                at++;
            } else bytes += 3;
        } else bytes += 3;
    }
    return bytes;
}

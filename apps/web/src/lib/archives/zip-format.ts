/*
 * Reading a zip's list of contents, and the rules every entry is held to (docs/file-tools-design.md,
 * section 1 (a) and section 3). Pure and dependency-free: it runs in the archive's tools worker,
 * in the page's tests, and its twin is crates/hushos-core/src/archive.rs, held to the same
 * behaviour by the fixtures in e2e/fixtures/archives and their expected.json. Change one, change
 * both.
 *
 * The parser is strict on purpose. Archives come from anyone, and two readers that see different
 * files in one archive is an attack of its own, so anything ambiguous is refused rather than
 * reconciled: an end record that doesn't reach the end of the file, a directory that isn't
 * exactly where the end record says, more or fewer records than declared, entries whose spans
 * overlap. The data itself is decoded by zip.js (the worker) or the `zip` crate (the core),
 * each checked against this listing first.
 */

const MiB = 1024 * 1024;

export const ZIP_LIMITS = {
    /* The largest central directory read: 100,000 entries of ordinary names take about 10 MiB. */
    directoryBytes: 64 * MiB,
    entries: 100_000,
    /* Inflating past this many times the compressed bytes read so far is refused, once 1 MiB has come out. */
    ratio: 200,
    ratioFrom: MiB,
    /* An entry this large at more than `ratio` asks before downloading. */
    askAbove: 4 * 1024 * MiB,
};

/* Whether this build decodes Deflate64 (method 9): zip.js 2.24.0 does, through its JavaScript inflater, and so does the core's `zip` crate. */
export const DEFLATE64 = true;

/* Why an archive or an entry was refused: a code the page puts into words (archive-words.ts). */
export type ZipRefusal =
    | 'damaged'
    | 'directory-too-large'
    | 'too-many-entries'
    | 'encrypted-directory'
    | 'split'
    | 'overlap'
    | 'local'
    | 'method'
    | 'encryption'
    | 'password'
    | 'wrong-password'
    | 'crc'
    | 'auth'
    | 'size'
    | 'short'
    | 'ratio'
    | 'nested'
    | 'link'
    | 'directory'
    | 'too-large';

export class ZipError extends Error {
    constructor(readonly code: ZipRefusal) {
        super(code);
        this.name = 'ZipError';
    }
}

export type Lock = 'none' | 'zipcrypto' | 'aes' | 'other';

export type ZipEntry = {
    /* Its place in the central directory. */
    index: number;
    /* The name's bytes as stored, for the local header check. */
    raw: Uint8Array;
    /* The name as decoded (UTF-8 flag, Unicode path field, strict UTF-8, else CP437). */
    path: string;
    directory: boolean;
    flags: number;
    /* The method as stored: 99 for WinZip AES, whose real method is `aes.method`. */
    method: number;
    crc: number;
    packed: number;
    size: number;
    /* Where its local header starts, and where the next entry's (or the directory) does. */
    offset: number;
    bound: number;
    /* MS-DOS date and time as stored (date << 16 | time), and the Unix time in ms when an extended timestamp gives one. */
    dos: number;
    mtime: number | null;
    lock: Lock;
    aes: { strength: number; version: number; method: number } | null;
    link: boolean;
};

export type Directory = { offset: number; size: number; count: number; zip64: boolean };

export type Read = (offset: number, length: number) => Promise<Uint8Array>;

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const SIG_ARCHIVE_EXTRA = 0x08064b50;
const EOCD_LENGTH = 22;
const LOCATOR_LENGTH = 20;
const ZIP64_EOCD_LENGTH = 56;
const CENTRAL_LENGTH = 46;
export const LOCAL_LENGTH = 30;
const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/* A little-endian u64 that must fit a safe integer, or the archive is damaged. */
function u64(data: DataView, at: number) {
    const value = data.getBigUint64(at, true);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('damaged');
    return Number(value);
}

/*
 * Where the central directory is, from the end of the file: the end record in the last
 * 64 KiB + 22 bytes, its comment reaching exactly to the end; then the ZIP64 locator and record
 * when there is one. Caps and refusals come before the directory is read: more than 100,000
 * entries, a directory over 64 MiB, a split archive, an encrypted directory.
 */
export async function findDirectory(size: number, read: Read): Promise<Directory> {
    if (size < EOCD_LENGTH) throw new ZipError('damaged');
    const tailLength = Math.min(size, EOCD_LENGTH + MAX16);
    const tailStart = size - tailLength;
    const tail = await read(tailStart, tailLength);
    if (tail.length !== tailLength) throw new ZipError('damaged');
    const data = view(tail);
    let at = -1;
    for (let i = tail.length - EOCD_LENGTH; i >= 0; i--) {
        if (data.getUint32(i, true) !== SIG_EOCD) continue;
        if (i + EOCD_LENGTH + data.getUint16(i + 20, true) === tail.length) {
            at = i;
            break;
        }
    }
    if (at < 0) throw new ZipError('damaged');
    const eocdOffset = tailStart + at;
    const disk = data.getUint16(at + 4, true);
    const directoryDisk = data.getUint16(at + 6, true);
    let onDisk: number = data.getUint16(at + 8, true);
    let count: number = data.getUint16(at + 10, true);
    let directorySize: number = data.getUint32(at + 12, true);
    let directoryOffset: number = data.getUint32(at + 16, true);
    let end = eocdOffset;
    let zip64 = false;
    let locator: DataView | null = null;
    if (eocdOffset >= LOCATOR_LENGTH) {
        const bytes = await read(eocdOffset - LOCATOR_LENGTH, LOCATOR_LENGTH);
        if (bytes.length === LOCATOR_LENGTH && view(bytes).getUint32(0, true) === SIG_ZIP64_LOCATOR)
            locator = view(bytes);
    }
    const sentinel =
        disk === MAX16 ||
        directoryDisk === MAX16 ||
        onDisk === MAX16 ||
        count === MAX16 ||
        directorySize === MAX32 ||
        directoryOffset === MAX32;
    if (sentinel && !locator) throw new ZipError('damaged');
    if (!sentinel && (disk !== 0 || directoryDisk !== 0)) throw new ZipError('split');
    if (locator) {
        zip64 = true;
        if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) > 1)
            throw new ZipError('split');
        const recordOffset = u64(locator, 8);
        if (recordOffset + ZIP64_EOCD_LENGTH > eocdOffset - LOCATOR_LENGTH)
            throw new ZipError('damaged');
        const record = view(await read(recordOffset, ZIP64_EOCD_LENGTH));
        if (record.byteLength !== ZIP64_EOCD_LENGTH || record.getUint32(0, true) !== SIG_ZIP64_EOCD)
            throw new ZipError('damaged');
        const recordSize = u64(record, 4);
        // Version 2 of the record carries how a strong-encrypted directory is encrypted.
        if (recordSize > ZIP64_EOCD_LENGTH - 12 && record.getUint16(14, true) >= 62)
            throw new ZipError('encrypted-directory');
        if (recordOffset + 12 + recordSize !== eocdOffset - LOCATOR_LENGTH)
            throw new ZipError('damaged');
        if (record.getUint32(16, true) !== 0 || record.getUint32(20, true) !== 0)
            throw new ZipError('split');
        const pick = (stored: number, max: number, wide: number) => {
            if (stored === max) return wide;
            if (stored !== wide) throw new ZipError('damaged');
            return stored;
        };
        onDisk = pick(onDisk, MAX16, u64(record, 24));
        count = pick(count, MAX16, u64(record, 32));
        directorySize = pick(directorySize, MAX32, u64(record, 40));
        directoryOffset = pick(directoryOffset, MAX32, u64(record, 48));
        end = recordOffset;
    }
    if (onDisk !== count) throw new ZipError('split');
    if (count > ZIP_LIMITS.entries) throw new ZipError('too-many-entries');
    if (directorySize > ZIP_LIMITS.directoryBytes) throw new ZipError('directory-too-large');
    if (directoryOffset + directorySize !== end) throw new ZipError('damaged');
    if (count * CENTRAL_LENGTH > directorySize) throw new ZipError('damaged');
    return { offset: directoryOffset, size: directorySize, count, zip64 };
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/* CP437's upper half, as Python's codec and zip.js map it; the lower half is ASCII. */
const CP437 =
    'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function cp437(bytes: Uint8Array) {
    let out = '';
    for (const byte of bytes) out += byte < 0x80 ? String.fromCharCode(byte) : CP437[byte - 0x80];
    return out;
}

// A byte order mark is kept: it is part of the name as stored, and the core keeps it too.
const lossy = new TextDecoder('utf-8', { ignoreBOM: true });
const strict = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function crc32Table() {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
}
let table: Uint32Array | null = null;
export function crc32(bytes: Uint8Array, crc = 0) {
    table ??= crc32Table();
    let c = ~crc >>> 0;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    return ~c >>> 0;
}

/* Each extra field by id (the first of an id wins); a field that overruns the rest is where reading stops. */
export function extraFields(extra: Uint8Array) {
    const fields = new Map<number, Uint8Array>();
    const data = view(extra);
    let at = 0;
    while (at + 4 <= extra.length) {
        const id = data.getUint16(at, true);
        const length = data.getUint16(at + 2, true);
        if (at + 4 + length > extra.length) break;
        if (!fields.has(id)) fields.set(id, extra.subarray(at + 4, at + 4 + length));
        at += 4 + length;
    }
    return fields;
}

/*
 * The name as the person sees it: UTF-8 when the flag says so, or from the Unicode path field
 * (0x7075) when its CRC matches the stored name; otherwise the stored bytes as strict UTF-8 if
 * they are that, else as CP437.
 */
export function decodeName(raw: Uint8Array, flags: number, fields: Map<number, Uint8Array>) {
    if (flags & 0x800) return lossy.decode(raw);
    const unicode = fields.get(0x7075);
    if (unicode && unicode.length >= 5 && unicode[0] === 1) {
        if (view(unicode).getUint32(1, true) === crc32(raw))
            return lossy.decode(unicode.subarray(5));
    }
    try {
        return strict.decode(raw);
    } catch {
        return cp437(raw);
    }
}

// ---------------------------------------------------------------------------------------------
// The central directory
// ---------------------------------------------------------------------------------------------

/*
 * Every record of the directory, in order, exactly as many as declared and filling it exactly;
 * then the overlap check. Fails with a refusal code.
 */
export function readDirectory(bytes: Uint8Array, directory: Directory): ZipEntry[] {
    if (bytes.length !== directory.size) throw new ZipError('damaged');
    const data = view(bytes);
    if (bytes.length >= 4 && data.getUint32(0, true) === SIG_ARCHIVE_EXTRA)
        throw new ZipError('encrypted-directory');
    const entries: ZipEntry[] = [];
    let at = 0;
    for (let index = 0; index < directory.count; index++) {
        if (at + CENTRAL_LENGTH > bytes.length || data.getUint32(at, true) !== SIG_CENTRAL)
            throw new ZipError('damaged');
        const madeBy = data.getUint16(at + 4, true);
        const flags = data.getUint16(at + 8, true);
        const method = data.getUint16(at + 10, true);
        const time = data.getUint16(at + 12, true);
        const date = data.getUint16(at + 14, true);
        const crc = data.getUint32(at + 16, true);
        let packed: number = data.getUint32(at + 20, true);
        let size: number = data.getUint32(at + 24, true);
        const nameLength = data.getUint16(at + 28, true);
        const extraLength = data.getUint16(at + 30, true);
        const commentLength = data.getUint16(at + 32, true);
        let disk: number = data.getUint16(at + 34, true);
        const external = data.getUint32(at + 38, true);
        let offset: number = data.getUint32(at + 42, true);
        const next = at + CENTRAL_LENGTH + nameLength + extraLength + commentLength;
        if (next > bytes.length) throw new ZipError('damaged');
        const raw = bytes.slice(at + CENTRAL_LENGTH, at + CENTRAL_LENGTH + nameLength);
        const fields = extraFields(
            bytes.subarray(
                at + CENTRAL_LENGTH + nameLength,
                at + CENTRAL_LENGTH + nameLength + extraLength,
            ),
        );
        // ZIP64: the values stored as all ones, in this order, from field 0x0001.
        if (size === MAX32 || packed === MAX32 || offset === MAX32 || disk === MAX16) {
            const wide = fields.get(0x0001);
            if (!wide) throw new ZipError('damaged');
            const w = view(wide);
            let p = 0;
            const take = () => {
                if (p + 8 > wide.length) throw new ZipError('damaged');
                const value = u64(w, p);
                p += 8;
                return value;
            };
            if (size === MAX32) size = take();
            if (packed === MAX32) packed = take();
            if (offset === MAX32) offset = take();
            if (disk === MAX16) {
                if (p + 4 > wide.length) throw new ZipError('damaged');
                disk = w.getUint32(p, true);
            }
        }
        if (disk !== 0) throw new ZipError('split');
        const encrypted = (flags & 1) !== 0;
        let lock: Lock = 'none';
        let aes: ZipEntry['aes'] = null;
        if (encrypted) {
            const field = fields.get(0x9901);
            if (flags & 0x40) lock = 'other';
            else if (method === 99) {
                if (field && field.length >= 7 && field[2] === 0x41 && field[3] === 0x45) {
                    const f = view(field);
                    const version = f.getUint16(0, true);
                    const strength = field[4]!;
                    if ((version === 1 || version === 2) && strength >= 1 && strength <= 3) {
                        lock = 'aes';
                        aes = { version, strength, method: f.getUint16(5, true) };
                    } else lock = 'other';
                } else lock = 'other';
            } else lock = 'zipcrypto';
        }
        const host = madeBy >> 8;
        const kind = (external >>> 16) & 0o170000;
        const directoryFlag =
            raw.length > 0 && (raw[raw.length - 1] === 0x2f || raw[raw.length - 1] === 0x5c);
        const dosDirectory = host === 0 && (external & 0x10) !== 0 && size === 0 && packed === 0;
        let mtime: number | null = null;
        const stamp = fields.get(0x5455);
        if (stamp && stamp.length >= 5 && stamp[0]! & 1)
            mtime = view(stamp).getInt32(1, true) * 1000;
        entries.push({
            index,
            raw,
            path: decodeName(raw, flags, fields),
            directory: directoryFlag || dosDirectory,
            flags,
            method,
            crc,
            packed,
            size,
            offset,
            bound: 0,
            dos: ((date << 16) | time) >>> 0,
            mtime,
            lock,
            aes,
            link: (host === 3 || host === 19) && kind === 0o120000,
        });
        at = next;
    }
    if (at !== bytes.length) throw new ZipError('damaged');
    checkOverlap(entries, directory.offset);
    return entries;
}

/*
 * No two entries' spans may overlap: each local header, its name and its data must end before
 * the next entry's local header starts (and the last before the directory). From the directory
 * alone the local extra field's length is unknown, so this checks the least each span can be
 * (30 + name + data); opening an entry checks the whole of it against `bound`.
 */
export function checkOverlap(entries: ZipEntry[], directoryOffset: number) {
    const order = [...entries].sort((a, b) => a.offset - b.offset || a.index - b.index);
    for (let i = 0; i < order.length; i++) {
        const entry = order[i]!;
        const bound = i + 1 < order.length ? order[i + 1]!.offset : directoryOffset;
        if (entry.offset + LOCAL_LENGTH > directoryOffset) throw new ZipError('damaged');
        if (entry.offset + LOCAL_LENGTH + entry.raw.length + entry.packed > bound)
            throw new ZipError('overlap');
        entry.bound = bound;
    }
}

/*
 * The local header must agree with the directory: the same name bytes, method and encryption,
 * and (without a data descriptor) the same CRC and sizes. Its whole span, data descriptor
 * included, must end by the entry's bound. Returns where the entry's data starts.
 */
export function checkLocalHeader(entry: ZipEntry, header: Uint8Array) {
    if (header.length < LOCAL_LENGTH) throw new ZipError('damaged');
    const data = view(header);
    if (data.getUint32(0, true) !== SIG_LOCAL) throw new ZipError('local');
    const flags = data.getUint16(6, true);
    const method = data.getUint16(8, true);
    const crc = data.getUint32(14, true);
    let packed: number = data.getUint32(18, true);
    let size: number = data.getUint32(22, true);
    const nameLength = data.getUint16(26, true);
    const extraLength = data.getUint16(28, true);
    // What the fixed part says first: the method, and the encryption and data-descriptor flags.
    // (encryption 0x1, data descriptor 0x8, UTF-8 names 0x800: each must say the same in both places)
    if (method !== entry.method || (flags & 0x809) !== (entry.flags & 0x809))
        throw new ZipError('local');
    // Then the whole span: a header whose name and extra field run past the next entry overlaps it.
    const start = entry.offset + LOCAL_LENGTH + nameLength + extraLength;
    if (start + entry.packed + ((flags & 8) !== 0 ? 12 : 0) > entry.bound)
        throw new ZipError('overlap');
    if (header.length < LOCAL_LENGTH + nameLength + extraLength) throw new ZipError('damaged');
    const name = header.subarray(LOCAL_LENGTH, LOCAL_LENGTH + nameLength);
    if (name.length !== entry.raw.length || name.some((byte, i) => byte !== entry.raw[i]))
        throw new ZipError('local');
    const fields = extraFields(
        header.subarray(LOCAL_LENGTH + nameLength, LOCAL_LENGTH + nameLength + extraLength),
    );
    // A WinZip AES entry says so in both places: a local header without its AES field is another entry.
    if (entry.lock === 'aes' && !fields.has(0x9901)) throw new ZipError('local');
    if (size === MAX32 || packed === MAX32) {
        const wide = fields.get(0x0001);
        if (!wide) throw new ZipError('local');
        const w = view(wide);
        let p = 0;
        if (size === MAX32) {
            if (p + 8 > wide.length) throw new ZipError('local');
            size = u64(w, p);
            p += 8;
        }
        if (packed === MAX32) {
            if (p + 8 > wide.length) throw new ZipError('local');
            packed = u64(w, p);
        }
    }
    const descriptor = (flags & 8) !== 0;
    const agrees = (local: number, central: number) =>
        local === central || (descriptor && local === 0);
    if (!agrees(crc, entry.crc) || !agrees(packed, entry.packed) || !agrees(size, entry.size))
        throw new ZipError('local');
    return start;
}

/* How many bytes of local header to read for an entry: the fixed part, its name and the largest extra field. */
export const LOCAL_HEADER_READ = (entry: ZipEntry) =>
    Math.min(LOCAL_LENGTH + entry.raw.length + MAX16, entry.bound - entry.offset);

// ---------------------------------------------------------------------------------------------
// What each entry is, for the list
// ---------------------------------------------------------------------------------------------

/* Archives inside archives are listed as files and never opened in place. */
const ARCHIVE_EXTENSIONS = new Set([
    'zip',
    'zipx',
    'jar',
    'war',
    'ear',
    'apk',
    'aab',
    'ipa',
    'xpi',
    '7z',
    'rar',
    'tar',
    'gz',
    'tgz',
    'bz2',
    'tbz',
    'tbz2',
    'xz',
    'txz',
    'zst',
    'tzst',
    'lz',
    'lzma',
    'z',
    'cab',
    'iso',
    'dmg',
]);

/* A path's folders and name, `/` and `\` both separating; empty and `.` parts dropped, `..` kept as a name. */
export function pathParts(path: string) {
    return path.split(/[\\/]/).filter((part) => part !== '' && part !== '.');
}

export function extensionOf(name: string) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export type Support = 'ok' | 'method' | 'encryption';

/* Whether HushOS can read the entry's data: its method (inside AES, the real one) and its kind of encryption. */
export function supportOf(entry: Pick<ZipEntry, 'lock' | 'method' | 'aes'>): Support {
    if (entry.lock === 'other') return 'encryption';
    const method = entry.lock === 'aes' ? entry.aes!.method : entry.method;
    if (method === 0 || method === 8 || (method === 9 && DEFLATE64)) return 'ok';
    return 'method';
}

export type Listed = {
    index: number;
    path: string;
    /* Its folders and name for the list (pathParts), never empty. */
    parts: string[];
    directory: boolean;
    size: number;
    packed: number;
    dos: number;
    mtime: number | null;
    lock: Lock;
    support: Support;
    link: boolean;
    nested: boolean;
    /* A Mac resource entry: under __MACOSX/, or an AppleDouble `._x` beside its `x`. */
    hidden: boolean;
    /* A file stored without compression or encryption: read by range at any size. */
    stored: boolean;
    /* What a download of it is saved as (saveName of its last part). */
    saveName: string;
};

/*
 * How deep the list goes: past 256 parts, or once the archive's entries have used a million parts
 * between them, an entry is listed flat, under its whole path, at the top. Without it one 64 KiB
 * name of `a/a/a/…` costs gigabytes in prefixes.
 */
export const LIST_DEPTH_MAX = 256;
export const LIST_PARTS_MAX = 1_000_000;

/* Names as a tree, each node a number and each child found by its parent and name: memory grows with the parts, never with their prefixes. */
export class NameTree {
    #children = new Map<string, number>();
    #next = 1;
    /* The child `name` of `parent` (0 is the top), made if asked; 0 when absent. */
    child(parent: number, name: string, make = false) {
        const key = `${parent}/${name}`;
        let found = this.#children.get(key) ?? 0;
        if (!found && make) this.#children.set(key, (found = this.#next++));
        return found;
    }
    /* The node at `parts`, 0 when any step is absent (or `parts` is empty: the top). */
    find(parts: string[]) {
        let node = 0;
        for (const part of parts) {
            node = this.child(node, part);
            if (!node) return 0;
        }
        return node;
    }
}

/* Characters no file system takes, or that change how a name reads (controls, bidi marks): save-file.ts's set. */
const FORBIDDEN = new Set('\\/:*?"<>|');
function unsafe(code: number) {
    return (
        FORBIDDEN.has(String.fromCodePoint(code)) ||
        code < 0x20 ||
        (code >= 0x7f && code <= 0x9f) ||
        code === 0x061c ||
        code === 0x200e ||
        code === 0x200f ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069)
    );
}
/* Dots and the whitespace JavaScript's \s matches, written out so the core strips the same. */
const EDGE = new Set(
    [
        0x2e, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f,
        0x3000, 0xfeff,
    ].concat(Array.from({ length: 11 }, (_, i) => 0x2000 + i)),
);
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
const utf8Length = (text: string) => new TextEncoder().encode(text).length;
/* Never `String.fromCodePoint(...codes)`: a 64 KiB name is more arguments than a worker's stack takes. */
const fromCodes = (codes: number[]) => codes.map((code) => String.fromCodePoint(code)).join('');

function trimEdges(chars: number[]) {
    let start = 0;
    let end = chars.length;
    while (start < end && EDGE.has(chars[start]!)) start++;
    while (end > start && EDGE.has(chars[end - 1]!)) end--;
    return chars.slice(start, end);
}

/*
 * The name an entry is saved as when downloaded, from the last part of its path: NFC, forbidden
 * and invisible characters (controls, bidi overrides) as `_`, no leading or trailing dots or
 * spaces, a Windows device name given a leading `_`, and at most 255 bytes of UTF-8, cut between
 * code points before the extension so ".txt" stays ".txt". A right-to-left override can't make
 * "…exe" read as "…txt", and a NUL can't cut the name short. Ported as is to the core.
 */
export function saveName(name: string) {
    let chars = trimEdges(
        Array.from(name.normalize('NFC'), (char) => {
            const code = char.codePointAt(0)!;
            return unsafe(code) ? 0x5f : code;
        }),
    );
    let text = fromCodes(chars);
    if (!text) return 'Untitled';
    if (RESERVED.test(text)) {
        text = `_${text}`;
        chars = [0x5f, ...chars];
    }
    if (utf8Length(text) <= 255) return text;
    const dot = text.lastIndexOf('.');
    const extension = dot > 0 && utf8Length(text.slice(dot)) <= 32 ? text.slice(dot) : '';
    const room = 255 - utf8Length(extension);
    const base: number[] = [];
    let bytes = 0;
    for (const code of Array.from(extension ? text.slice(0, dot) : text, (c) =>
        c.codePointAt(0)!,
    )) {
        const length = utf8Length(String.fromCodePoint(code));
        if (bytes + length > room) break;
        bytes += length;
        base.push(code);
    }
    const kept = fromCodes(trimEdges(base));
    return kept ? kept + extension : 'Untitled';
}

/*
 * The list as the person sees it: each entry's parts, what it is, and whether it is a Mac
 * resource entry to hide. An entry whose path has no parts (a name of only separators) is named
 * as stored, so nothing in the archive goes unlisted.
 */
export function listEntries(entries: ZipEntry[]): Listed[] {
    let budget = LIST_PARTS_MAX;
    const listed: Listed[] = entries.map((entry, at) => {
        const remaining = entries.length - at - 1;
        let parts = pathParts(entry.path);
        if (parts.length === 0) parts = entry.directory ? [] : [entry.path || '_'];
        // Too deep, or past what the archive may spend in all: listed flat, under its whole path.
        // Each entry still to come is owed at least one part, so the last ones list flat, never past the cap.
        if (parts.length > LIST_DEPTH_MAX || parts.length + remaining > budget)
            parts = [entry.path || '_'];
        budget -= parts.length;
        const name = parts[parts.length - 1] ?? '';
        const support = supportOf(entry);
        return {
            index: entry.index,
            path: entry.path,
            parts,
            directory: entry.directory,
            size: entry.size,
            packed: entry.packed,
            dos: entry.dos,
            mtime: entry.mtime,
            lock: entry.lock,
            support,
            link: entry.link && !entry.directory,
            nested: !entry.directory && !entry.link && ARCHIVE_EXTENSIONS.has(extensionOf(name)),
            hidden: false,
            stored: !entry.directory && !entry.link && entry.method === 0 && entry.lock === 'none',
            saveName: saveName(name),
        };
    });
    // Every path, explicit or implied by a deeper one, so a `._x` is hidden only beside an `x`.
    const tree = new NameTree();
    for (const item of listed) {
        let node = 0;
        for (const part of item.parts) node = tree.child(node, part, true);
    }
    for (const item of listed) {
        if (item.parts[0] === '__MACOSX') {
            item.hidden = true;
            continue;
        }
        const name = item.parts[item.parts.length - 1];
        if (!item.directory && name && name.startsWith('._') && name.length > 2) {
            const parent = item.parts.length > 1 ? tree.find(item.parts.slice(0, -1)) : 0;
            if ((item.parts.length === 1 || parent) && tree.child(parent, name.slice(2)))
                item.hidden = true;
        }
    }
    return listed.filter((item) => item.parts.length > 0 || !item.directory);
}

/* Mac resource files hidden from the list (directories not counted). */
export function hiddenCount(listed: Listed[]) {
    return listed.filter((item) => item.hidden && !item.directory).length;
}

// ---------------------------------------------------------------------------------------------
// Bombs: the counter every inflated byte goes through
// ---------------------------------------------------------------------------------------------

/*
 * Held to the entry's declared size at the byte that passes it, and for a preview to 200 times
 * the compressed bytes read so far once 1 MiB has come out. A download is held to its size only:
 * a large one past the ratio asks first instead (`asksFirst`).
 */
export class InflateCounter {
    produced = 0;
    consumed = 0;
    constructor(
        readonly declared: number,
        readonly ratio: boolean,
    ) {}

    read(bytes: number) {
        this.consumed += bytes;
    }

    /* The compressed bytes consumed so far, as how far into the entry's data reading has reached. */
    reached(position: number) {
        this.consumed = Math.max(this.consumed, position);
    }

    wrote(bytes: number) {
        this.produced += bytes;
        if (this.produced > this.declared) throw new ZipError('size');
        if (
            this.ratio &&
            this.produced > ZIP_LIMITS.ratioFrom &&
            this.produced > ZIP_LIMITS.ratio * this.consumed
        )
            throw new ZipError('ratio');
    }

    /* At the end: fewer bytes than declared is damage too. */
    /* At the end: fewer bytes than declared is damage too, said as such. */
    finish() {
        if (this.produced > this.declared) throw new ZipError('size');
        if (this.produced < this.declared) throw new ZipError('short');
    }
}

/*
 * Whether the entry declares more than 200 times what it packs, once it declares over 1 MiB: a
 * preview refuses it before reading a byte. Nothing more is needed while inflating: what comes out
 * is held to the declared size at the byte past it, so the declared ratio bounds the real one. A
 * running ratio would only refuse honest files that start blank (a scanned page, a disk image).
 */
export function declaresTooMuch(entry: { size: number; packed: number }) {
    return entry.size > ZIP_LIMITS.ratioFrom && entry.size > ZIP_LIMITS.ratio * entry.packed;
}

/* Whether downloading the entry asks first: over 4 GiB declared, at more than 200 to 1. */
export function asksFirst(entry: { size: number; packed: number }) {
    return entry.size > ZIP_LIMITS.askAbove && entry.size > ZIP_LIMITS.ratio * entry.packed;
}

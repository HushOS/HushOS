/*
 * The archive fixtures of docs/file-tools-design.md, section 7: real malicious zips, written byte
 * by byte with a writer of our own, never through a library that would clean a name or fix a
 * size. The small ones are committed beside this file; the large ones (a central directory of
 * 65 MiB, 100,001 entries, 1 GiB and 5 GiB of zeros) are written when a test needs them.
 *
 *     bun e2e/fixtures/archives/make.ts            # rewrite the committed fixtures here
 *     bun e2e/fixtures/archives/make.ts --large D  # write the large ones into D
 *
 * Every fixture is deterministic (fixed times, salts and ZipCrypto headers), so a rewrite that
 * changes a committed file's bytes is a change to review. expected.json beside this file says
 * what HushOS must make of each, on the web and in the Rust core alike; fixtures.test.ts checks
 * each fixture is what it claims through Python's zipfile and bsdtar.
 */
import { createCipheriv, createHmac, pbkdf2Sync } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateRawSync, inflateRawSync } from 'node:zlib';

/* What a test looks for after a run: plaintext of an inflated entry, which must never reach storage. */
export const CANARY = 'HUSHOS-CANARY-ZIP-5b1e9c';
export const PASSWORD = 'correct horse battery';
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// ---------------------------------------------------------------------------------------------
// CRC-32
// ---------------------------------------------------------------------------------------------

const TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

export function crc32(bytes: Uint8Array, crc = 0) {
    let c = ~crc >>> 0;
    for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
    return ~c >>> 0;
}

/* The CRC-32 of `length` zero bytes, by doubling: 5 GiB of zeros without touching 5 GiB. */
function crc32Zeros(length: number) {
    // a(x) * b(x) modulo the polynomial, reflected (zlib's multmodp).
    const multiply = (a: number, b: number) => {
        let m = 0x80000000;
        let p = 0;
        for (;;) {
            if (a & m) {
                p ^= b;
                if ((a & (m - 1)) === 0) break;
            }
            m >>>= 1;
            b = b & 1 ? (b >>> 1) ^ 0xedb88320 : b >>> 1;
        }
        return p >>> 0;
    };
    // x^(2^k) modulo the polynomial, for k in 0..31.
    const powers: number[] = [];
    let p = 0x40000000; // x^1
    for (let k = 0; k < 32; k++) {
        powers.push(p);
        p = multiply(p, p);
    }
    // The operator for `bits` zero bits applied to `crc`.
    const shift = (crc: number, bits: number) => {
        let op = 0x80000000; // x^0
        let k = 0;
        while (bits > 0) {
            if (bits % 2) op = multiply(powers[k % 32]!, op);
            bits = Math.floor(bits / 2);
            k++;
        }
        return multiply(op, crc);
    };
    // crc(A || B) = shift(crc(A), len B) ^ crc(B); doubling zeros from one block.
    const block = 1 << 16;
    const crcBlock = crc32(new Uint8Array(block));
    let crc = 0;
    let done = 0;
    let unit = crcBlock;
    let unitLength = block;
    let remaining = Math.floor(length / block);
    // Binary decomposition of the number of whole blocks.
    while (remaining > 0) {
        if (remaining % 2) {
            crc = (shift(crc, unitLength * 8) ^ unit) >>> 0;
            done += unitLength;
        }
        unit = (shift(unit, unitLength * 8) ^ unit) >>> 0;
        unitLength *= 2;
        remaining = Math.floor(remaining / 2);
    }
    const rest = length - done;
    return rest ? crc32(new Uint8Array(rest), crc) : crc;
}

// ---------------------------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------------------------

const utf8 = (text: string) => new TextEncoder().encode(text);

function deflate(bytes: Uint8Array) {
    return new Uint8Array(deflateRawSync(bytes, { level: 9 }));
}

/*
 * A raw deflate stream of `length` zeros, of about length / 1,000 bytes: one full-flushed block
 * of 1 MiB of zeros (its own history, so it can be repeated), repeated, then a final empty block.
 */
function deflatedZeros(length: number) {
    if (length % MiB) throw new Error('Whole MiB only.');
    const block = new Uint8Array(
        deflateRawSync(new Uint8Array(MiB), { level: 9, finishFlush: constants.Z_FULL_FLUSH }),
    );
    const count = length / MiB;
    const out = new Uint8Array(block.length * count + 2);
    for (let i = 0; i < count; i++) out.set(block, i * block.length);
    // A final fixed-Huffman block holding only its end: BFINAL 1, BTYPE 01, code 0000000.
    out.set([0x03, 0x00], block.length * count);
    return out;
}

/* A 1x1 PNG, red. */
const PNG = Uint8Array.from(
    Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
        'base64',
    ),
);

// ---------------------------------------------------------------------------------------------
// Encryption: WinZip AES and traditional PKWARE (ZipCrypto)
// ---------------------------------------------------------------------------------------------

/* WinZip AE-x: salt, password verifier, AES-CTR (little-endian counter from 1), HMAC-SHA1 cut to 10 bytes. */
function aesEncrypt(data: Uint8Array, password: string, salt: Uint8Array) {
    const keyLength = 32;
    const derived = pbkdf2Sync(password, salt, 1000, keyLength * 2 + 2, 'sha1');
    const key = derived.subarray(0, keyLength);
    const macKey = derived.subarray(keyLength, keyLength * 2);
    const verifier = derived.subarray(keyLength * 2);
    const cipher = createCipheriv('aes-256-ecb', key, null).setAutoPadding(false);
    const out = new Uint8Array(data.length);
    const counter = new Uint8Array(16);
    for (let at = 0, block = 1; at < data.length; at += 16, block++) {
        let value = block;
        for (let i = 0; i < 8; i++) {
            counter[i] = value % 256;
            value = Math.floor(value / 256);
        }
        const stream = cipher.update(counter);
        for (let i = 0; i < 16 && at + i < data.length; i++)
            out[at + i] = data[at + i]! ^ stream[i]!;
    }
    const mac = createHmac('sha1', macKey).update(out).digest().subarray(0, 10);
    return concat([salt, verifier, out, mac]);
}

function zipCryptoEncrypt(data: Uint8Array, password: string, check: number, header: Uint8Array) {
    const keys = [0x12345678, 0x23456789, 0x34567890];
    const crcByte = (crc: number, byte: number) =>
        (TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
    const update = (byte: number) => {
        keys[0] = crcByte(keys[0]!, byte);
        keys[1] = (Math.imul((keys[1]! + (keys[0]! & 0xff)) >>> 0, 134775813) + 1) >>> 0;
        keys[2] = crcByte(keys[2]!, keys[1]! >>> 24);
    };
    const streamByte = () => {
        const temp = (keys[2]! | 2) >>> 0;
        return (Math.imul(temp, temp ^ 1) >>> 8) & 0xff;
    };
    for (const byte of utf8(password)) update(byte);
    const plain = concat([header.subarray(0, 11), Uint8Array.of(check), data]);
    const out = new Uint8Array(plain.length);
    for (let i = 0; i < plain.length; i++) {
        out[i] = plain[i]! ^ streamByte();
        update(plain[i]!);
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// The writer
// ---------------------------------------------------------------------------------------------

export type Spec = {
    /* The name in the central directory, as bytes or UTF-8 text. */
    name: string | Uint8Array;
    /* The local header's name when it differs (a fixture that lies). */
    localName?: string | Uint8Array;
    /* The entry's plaintext. */
    data?: Uint8Array;
    /* 0 stored, 8 deflated (compressed here); any other method needs `packed`. */
    method?: number;
    /* The bytes stored for the entry as they are, instead of compressing `data`. */
    packed?: Uint8Array;
    /* What the headers declare, when it is not the truth. */
    crc?: number;
    size?: number;
    flags?: number;
    extra?: Uint8Array;
    localExtra?: Uint8Array;
    /* The local header's flags and declared size, when they lie (the central record keeps the truth). */
    localFlags?: number;
    localSize?: number;
    versionMadeBy?: number;
    externalAttributes?: number;
    comment?: Uint8Array;
    /* Sizes and offset through the ZIP64 extra field, in both headers. */
    zip64?: boolean;
    /* A data descriptor (with its signature) after the data, the local header's CRC and sizes zero. */
    descriptor?: boolean;
    encrypt?: { kind: 'aes'; version: 1 | 2 } | { kind: 'zipcrypto' };
    /* No local header or data of its own: the central record points at another entry's (by index). */
    sharesWith?: number;
};

export type ArchiveOptions = {
    /* The EOCD's counts and sizes as 0xFFFF / 0xFFFFFFFF, read from a ZIP64 record. */
    zip64Directory?: boolean;
    /* Bytes before the central directory: PKWARE's archive extra data record of a strong-encrypted directory. */
    beforeDirectory?: Uint8Array;
    /* The ZIP64 end record's version needed and extensible data (strong encryption). */
    zip64Version2?: Uint8Array;
};

const DOS_TIME = (14 << 11) | (30 << 5) | (0 >> 1); // 14:30:00
const DOS_DATE = ((2026 - 1980) << 9) | (11 << 5) | 3; // 2026-11-03

function concat(parts: Uint8Array[]) {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

class Bytes {
    parts: Uint8Array[] = [];
    length = 0;
    push(part: Uint8Array) {
        this.parts.push(part);
        this.length += part.length;
    }
    u8(n: number) {
        this.push(Uint8Array.of(n));
    }
    u16(n: number) {
        this.push(Uint8Array.of(n & 0xff, (n >>> 8) & 0xff));
    }
    u32(n: number) {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, n >>> 0, true);
        this.push(b);
    }
    u64(n: number) {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
        this.push(b);
    }
    done() {
        return concat(this.parts);
    }
}

const nameBytes = (name: string | Uint8Array) => (typeof name === 'string' ? utf8(name) : name);

export function field(id: number, body: Uint8Array) {
    const out = new Bytes();
    out.u16(id);
    out.u16(body.length);
    out.push(body);
    return out.done();
}

function zip64Field(values: number[]) {
    const body = new Bytes();
    for (const value of values) body.u64(value);
    return field(0x0001, body.done());
}

/* The Info-ZIP Unicode path field: version 1, the CRC-32 of the header's name, the UTF-8 name. */
export function unicodePath(headerName: Uint8Array, name: string, crc = crc32(headerName)) {
    const body = new Bytes();
    body.u8(1);
    body.u32(crc);
    body.push(utf8(name));
    return field(0x7075, body.done());
}

function aesField(version: 1 | 2, method: number) {
    const body = new Bytes();
    body.u16(version);
    body.push(utf8('AE'));
    body.u8(3); // AES-256
    body.u16(method);
    return field(0x9901, body.done());
}

/* A salt and ZipCrypto header per entry, fixed so a rewrite gives the same bytes. */
function fixed(seed: number, length: number) {
    const out = new Uint8Array(length);
    let x = seed >>> 0 || 1;
    for (let i = 0; i < length; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        out[i] = x & 0xff;
    }
    return out;
}

export function writeZip(specs: Spec[], options: ArchiveOptions = {}) {
    const out = new Bytes();
    type Placed = {
        spec: Spec;
        name: Uint8Array;
        method: number;
        flags: number;
        crc: number;
        size: number;
        packedLength: number;
        offset: number;
        extra: Uint8Array;
    };
    const placed: Placed[] = [];
    specs.forEach((spec, index) => {
        const name = nameBytes(spec.name);
        const data = spec.data ?? new Uint8Array(0);
        const realCrc = crc32(data);
        let method = spec.method ?? (data.length ? 8 : 0);
        let packed =
            spec.packed ?? (method === 8 ? deflate(data) : method === 0 ? data : new Uint8Array(0));
        let flags = spec.flags ?? 0x800 * (typeof spec.name === 'string' ? 1 : 0);
        let extra = spec.extra ?? new Uint8Array(0);
        let localExtra = spec.localExtra ?? spec.extra ?? new Uint8Array(0);
        let crc = spec.crc ?? realCrc;
        if (spec.encrypt?.kind === 'aes') {
            const { version } = spec.encrypt;
            packed = aesEncrypt(packed, PASSWORD, fixed(index + 7, 16));
            const aes = aesField(version, method);
            extra = concat([extra, aes]);
            localExtra = concat([localExtra, aes]);
            method = 99;
            flags |= 1;
            if (version === 2) crc = 0;
        } else if (spec.encrypt?.kind === 'zipcrypto') {
            flags |= 1;
            packed = zipCryptoEncrypt(packed, PASSWORD, (crc >>> 24) & 0xff, fixed(index + 11, 12));
        }
        if (spec.descriptor) flags |= 8;
        const size = spec.size ?? data.length;
        if (spec.sharesWith !== undefined) {
            const other = placed[spec.sharesWith]!;
            placed.push({ ...other, spec, name, flags, crc, size, extra });
            return;
        }
        const offset = out.length;
        const local = new Bytes();
        local.u32(0x04034b50);
        local.u16(spec.zip64 ? 45 : 20);
        local.u16(spec.localFlags ?? flags);
        local.u16(method);
        local.u16(DOS_TIME);
        local.u16(DOS_DATE);
        const zero = spec.descriptor;
        local.u32(zero ? 0 : crc);
        local.u32(zero ? 0 : spec.zip64 ? 0xffffffff : packed.length);
        local.u32(zero ? 0 : spec.zip64 ? 0xffffffff : (spec.localSize ?? size));
        const localName = nameBytes(spec.localName ?? spec.name);
        const localExtras = spec.zip64
            ? concat([zip64Field([size, packed.length]), localExtra])
            : localExtra;
        local.u16(localName.length);
        local.u16(localExtras.length);
        local.push(localName);
        local.push(localExtras);
        out.push(local.done());
        out.push(packed);
        if (spec.descriptor) {
            out.u32(0x08074b50);
            out.u32(crc);
            out.u32(packed.length);
            out.u32(size);
        }
        placed.push({
            spec,
            name,
            method,
            flags,
            crc,
            size,
            packedLength: packed.length,
            offset,
            extra,
        });
    });
    const directoryOffset = out.length;
    // Counted as the directory's: its offset points at it, as PKWARE's strong encryption does.
    const before = options.beforeDirectory ?? new Uint8Array(0);
    out.push(before);
    const directory = new Bytes();
    for (const entry of placed) {
        const { spec } = entry;
        const big = spec.zip64;
        const extras = big
            ? concat([zip64Field([entry.size, entry.packedLength, entry.offset]), entry.extra])
            : entry.extra;
        const comment = spec.comment ?? new Uint8Array(0);
        directory.u32(0x02014b50);
        directory.u16(spec.versionMadeBy ?? (3 << 8) | 45);
        directory.u16(big ? 45 : 20);
        directory.u16(entry.flags);
        directory.u16(entry.method);
        directory.u16(DOS_TIME);
        directory.u16(DOS_DATE);
        directory.u32(entry.crc);
        directory.u32(big ? 0xffffffff : entry.packedLength);
        directory.u32(big ? 0xffffffff : entry.size);
        directory.u16(entry.name.length);
        directory.u16(extras.length);
        directory.u16(comment.length);
        directory.u16(0);
        directory.u16(0);
        directory.u32(spec.externalAttributes ?? (0o100644 << 16) >>> 0);
        directory.u32(big ? 0xffffffff : entry.offset);
        directory.push(entry.name);
        directory.push(extras);
        directory.push(comment);
    }
    const directoryBytes = directory.done();
    out.push(directoryBytes);
    const directorySize = before.length + directoryBytes.length;
    const count = placed.length;
    if (options.zip64Directory || options.zip64Version2) {
        const recordOffset = out.length;
        const extensible = options.zip64Version2 ?? new Uint8Array(0);
        out.u32(0x06064b50);
        out.u64(44 + extensible.length);
        out.u16((3 << 8) | (options.zip64Version2 ? 62 : 45));
        out.u16(options.zip64Version2 ? 62 : 45);
        out.u32(0);
        out.u32(0);
        out.u64(count);
        out.u64(count);
        out.u64(directorySize);
        out.u64(directoryOffset);
        out.push(extensible);
        out.u32(0x07064b50);
        out.u32(0);
        out.u64(recordOffset);
        out.u32(1);
    }
    const sentinel = options.zip64Directory || options.zip64Version2;
    out.u32(0x06054b50);
    out.u16(0);
    out.u16(0);
    out.u16(sentinel ? 0xffff : Math.min(count, 0xffff));
    out.u16(sentinel ? 0xffff : Math.min(count, 0xffff));
    out.u32(sentinel ? 0xffffffff : directorySize);
    out.u32(sentinel ? 0xffffffff : directoryOffset);
    out.u16(0);
    return out.done();
}

// ---------------------------------------------------------------------------------------------
// The fixtures
// ---------------------------------------------------------------------------------------------

const text = (body: string) => utf8(`${body}\n${CANARY}\n`);
const mode = (bits: number) => (bits << 16) >>> 0;
const unix = (bits: number) => ({ versionMadeBy: (3 << 8) | 20, externalAttributes: mode(bits) });

/* A short text with no run of 258 bytes, so its raw deflate stream is valid Deflate64 too. */
const DEFLATE64_TEXT = utf8(
    Array.from(
        { length: 40 },
        (_, i) => `line ${i}: the quick brown fox ${i * 7} jumps over the lazy dog ${i * 13}`,
    ).join('\n') + '\n',
);

function cp437Fixture() {
    // "café-ö.txt" in CP437: é is 0x82, ö is 0x94. No UTF-8 flag, and not valid UTF-8.
    const cp437 = Uint8Array.from([0x63, 0x61, 0x66, 0x82, 0x2d, 0x94, 0x2e, 0x74, 0x78, 0x74]);
    // The same name's bytes, carrying a Unicode path field that names it properly (CRC matches).
    const withUnicode = Uint8Array.from([0x6e, 0x61, 0x6d, 0x65, 0x82, 0x2e, 0x74, 0x78, 0x74]);
    // A Unicode path field whose CRC doesn't match its header's name: ignored.
    const staleUnicode = Uint8Array.from([0x6f, 0x6c, 0x64, 0x82, 0x2e, 0x74, 0x78, 0x74]);
    return writeZip([
        { name: cp437, data: utf8('cp437\n'), flags: 0 },
        {
            name: withUnicode,
            data: utf8('unicode path\n'),
            flags: 0,
            extra: unicodePath(withUnicode, 'Ünïcødé.txt'),
        },
        {
            name: staleUnicode,
            data: utf8('stale unicode path\n'),
            flags: 0,
            extra: unicodePath(staleUnicode, 'wrong.txt', 0x12345678),
        },
        // Valid UTF-8 without the flag: read as UTF-8.
        { name: utf8('naïve-utf8.txt'), data: utf8('utf-8, no flag\n'), flags: 0 },
        // The flag set: UTF-8.
        { name: '日本語.txt', data: utf8('flagged utf-8\n') },
    ]);
}

function namesFixture() {
    const nfc = 'é.txt'.normalize('NFC');
    const nfd = 'é.txt'.normalize('NFD');
    const deep = Array.from({ length: 40 }, (_, i) => `d${i}`).join('/') + '/deep.txt';
    const long = `${'x'.repeat(300)}.txt`;
    const names = [
        '../evil.txt',
        '../../etc/passwd',
        'a/../../b',
        'a\\..\\..\\b',
        '/abs.txt',
        '\\abs.txt',
        'C:\\win.txt',
        'C:evil.txt',
        '\\\\server\\share\\x',
        './a',
        'a//b',
        nfc,
        nfd,
        long,
        deep,
        'nul\u0000name.txt',
        'rtl\u202Etxt.exe',
        'CON',
        'aux.txt',
        'same',
        'same/inner.txt',
    ];
    return writeZip(names.map((name) => ({ name, data: utf8(`${name}\n`) })));
}

function macFixture() {
    return writeZip([
        { name: 'photo.jpg', data: PNG, method: 0 },
        { name: '__MACOSX/', data: new Uint8Array(0), externalAttributes: mode(0o40755) },
        { name: '__MACOSX/._photo.jpg', data: utf8('resource fork\n') },
        { name: 'folder/file.txt', data: utf8('file\n') },
        { name: 'folder/._file.txt', data: utf8('apple double\n') },
        // No original beside it: shown.
        { name: 'folder/._orphan', data: utf8('no original\n') },
    ]);
}

function basicFixture() {
    const notes = text('# Notes\n\nThe quick brown fox jumps over the lazy dog.\n'.repeat(40));
    return writeZip([
        { name: 'docs/', externalAttributes: mode(0o40755) },
        { name: 'docs/readme.txt', data: text('Read me. This entry is deflated.') },
        { name: 'docs/notes/todo.md', data: notes },
        { name: 'docs/stored.txt', data: text('This entry is stored.'), method: 0 },
        { name: 'pixel.png', data: PNG, method: 0 },
        { name: 'empty/', externalAttributes: mode(0o40755) },
        // A data descriptor after the data, as streaming writers leave it.
        { name: 'streamed.txt', data: text('Written with a data descriptor.'), descriptor: true },
        { name: 'deflate64.txt', data: DEFLATE64_TEXT, method: 9, packed: deflate(DEFLATE64_TEXT) },
    ]);
}

function nestedFixture() {
    const inner = writeZip([{ name: 'inner.txt', data: text('inside') }]);
    return writeZip([
        { name: 'inner.zip', data: inner, method: 0 },
        { name: 'outer.txt', data: text('outside') },
    ]);
}

function symlinkFixture() {
    return writeZip([
        { name: 'link', data: utf8('/etc/passwd'), method: 0, ...unix(0o120777) },
        { name: 'link/evil', data: utf8('through the link\n') },
    ]);
}

function methodsFixture() {
    const junk = utf8('not really compressed');
    return writeZip([
        { name: 'bzip2.bin', method: 12, packed: junk, size: 100 },
        { name: 'lzma.bin', method: 14, packed: junk, size: 100 },
        { name: 'zstd.bin', method: 93, packed: junk, size: 100 },
        { name: 'ppmd.bin', method: 98, packed: junk, size: 100 },
        { name: 'ok.txt', data: utf8('readable\n') },
    ]);
}

function aesFixture() {
    return writeZip([
        { name: 'secret.txt', data: text('AES-256, AE-2.'), encrypt: { kind: 'aes', version: 2 } },
        {
            name: 'secret-ae1.txt',
            data: text('AES-256, AE-1.'),
            encrypt: { kind: 'aes', version: 1 },
        },
        { name: 'plain.txt', data: utf8('not encrypted\n') },
    ]);
}

function aesFlippedFixture() {
    const zip = writeZip([
        {
            name: 'tampered.txt',
            data: text('Its authentication code is wrong.'),
            encrypt: { kind: 'aes', version: 2 },
        },
    ]);
    // The last byte of the entry's data is the last byte of its 10-byte authentication code.
    const view = new DataView(zip.buffer, zip.byteOffset);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const packed = view.getUint32(18, true);
    zip[30 + nameLength + extraLength + packed - 1]! ^= 0x01;
    return zip;
}

function zipCryptoFixture() {
    return writeZip([
        { name: 'secret.txt', data: text('ZipCrypto.'), encrypt: { kind: 'zipcrypto' } },
        {
            name: 'stored-secret.txt',
            data: text('ZipCrypto, stored.'),
            method: 0,
            encrypt: { kind: 'zipcrypto' },
        },
    ]);
}

function badCrcFixture() {
    const data = text('The checksum in the headers is wrong.');
    return writeZip([{ name: 'bad-crc.txt', data, crc: (crc32(data) ^ 0xdeadbeef) >>> 0 }]);
}

function liesFixture() {
    // Declares 1 KiB, inflates to 100 MiB.
    return writeZip([
        {
            name: 'small.txt',
            size: 1024,
            method: 8,
            packed: deflatedZeros(100 * MiB),
            crc: crc32Zeros(100 * MiB),
        },
    ]);
}

function overlapFixture() {
    // zbsm's idea, plainly: one small deflated kernel that twenty central records all point at,
    // each declaring the 100 MiB it inflates to. 2 GiB declared through 100 KiB of shared data.
    const kernel = deflatedZeros(100 * MiB);
    const specs: Spec[] = [
        {
            name: 'kernel-00.bin',
            method: 8,
            packed: kernel,
            size: 100 * MiB,
            crc: crc32Zeros(100 * MiB),
        },
    ];
    for (let i = 1; i < 20; i++)
        specs.push({
            name: `kernel-${String(i).padStart(2, '0')}.bin`,
            sharesWith: 0,
            size: 100 * MiB,
            crc: crc32Zeros(100 * MiB),
        });
    return writeZip(specs);
}

function localMismatchFixture() {
    return writeZip([
        {
            name: 'shown.txt',
            localName: 'other.txt',
            data: utf8('the local header names another file\n'),
        },
        { name: 'fine.txt', data: utf8('fine\n') },
    ]);
}

function strongFixture() {
    // PKWARE strong encryption of the central directory: the ZIP64 end record is version 2 (its
    // extensible data says how the directory is encrypted) and the directory starts with an
    // archive decryption header after an archive extra data record. HushOS refuses it.
    const extensible = new Bytes();
    extensible.u16(0); // compression method of the directory
    extensible.u64(64); // compressed size
    extensible.u64(64); // original size
    extensible.u16(0x660e); // AES-128
    extensible.u16(128); // bit length
    extensible.u16(1); // flags
    extensible.u16(0x8004); // SHA-1
    extensible.u16(0);
    const archiveExtra = new Bytes();
    archiveExtra.u32(0x08064b50);
    archiveExtra.u32(16);
    archiveExtra.push(fixed(99, 16));
    return writeZip(
        [
            {
                name: 'hidden.txt',
                data: utf8('the list of contents is encrypted\n'),
                flags: 0x41 | 0x2000,
            },
        ],
        { zip64Version2: extensible.done(), beforeDirectory: archiveExtra.done() },
    );
}

// The large ones, written when a test needs them.

function zeros1GiB() {
    return writeZip([
        {
            name: 'zeros.bin',
            method: 8,
            packed: deflatedZeros(GiB),
            size: GiB,
            crc: crc32Zeros(GiB),
        },
    ]);
}

function zip64FiveGiB() {
    const size = 5 * GiB;
    return writeZip(
        [
            {
                name: 'zeros-5g.bin',
                method: 8,
                packed: deflatedZeros(size),
                size,
                crc: crc32Zeros(size),
                zip64: true,
            },
            { name: 'readme.txt', data: text('Beside five gibibytes of zeros.') },
        ],
        { zip64Directory: true },
    );
}

function entries100001() {
    const specs: Spec[] = [];
    for (let i = 0; i < 100_001; i++)
        specs.push({ name: `e/${String(i).padStart(6, '0')}`, method: 0 });
    return writeZip(specs, { zip64Directory: true });
}

function directory65MiB() {
    // 1,100 records, each with a comment of 62,000 bytes: a real central directory of 65.1 MiB.
    const comment = new Uint8Array(62_000).fill(0x20);
    const specs: Spec[] = [];
    for (let i = 0; i < 1_100; i++)
        specs.push({ name: `c/${String(i).padStart(4, '0')}`, method: 0, comment });
    return writeZip(specs);
}

// Round 1 of the review: shapes where two readers could disagree, and the caps on listing.

/*
 * Two end records: the outer one, whose comment reaches the end of the file, names a directory
 * that lists report.txt as stored; inside that comment sits a second directory and end record
 * that list the same bytes as deflated (Fable's differential.zip). HushOS reads the first, on
 * every client: the stored bytes, as they are.
 */
function differentialFixture() {
    const p1 = utf8('PHONE VIEW: the core inflates this entry under a different central record.\n');
    const block1 = concat([
        Uint8Array.of(
            0,
            p1.length & 0xff,
            p1.length >> 8,
            ~p1.length & 0xff,
            (~p1.length >> 8) & 0xff,
        ),
        p1,
    ]);
    let data = new Uint8Array(0);
    for (let r = 6; r < 400; r++) {
        const block2 = new Uint8Array(deflateRawSync(new Uint8Array(r).fill(0x20), { level: 9 }));
        if (r === 5 + block2.length) {
            data = concat([block1, block2]);
            break;
        }
    }
    if (!data.length) throw new Error('No differential block.');
    const inflated = new Uint8Array(inflateRawSync(data));
    const name = utf8('report.txt');
    const header = (method: number, crc: number) => {
        const out = new Bytes();
        out.u32(0x04034b50);
        out.u16(20);
        out.u16(0);
        out.u16(method);
        out.u16(0);
        out.u16(0x5821);
        out.u32(crc);
        out.u32(data.length);
        out.u32(data.length);
        out.u16(name.length);
        out.u16(0);
        out.push(name);
        return out.done();
    };
    const central = (method: number, crc: number) => {
        const out = new Bytes();
        out.u32(0x02014b50);
        out.u16(20);
        out.u16(20);
        out.u16(0);
        out.u16(method);
        out.u16(0);
        out.u16(0x5821);
        out.u32(crc);
        out.u32(data.length);
        out.u32(data.length);
        out.u16(name.length);
        out.u16(0);
        out.u16(0);
        out.u16(0);
        out.u16(0);
        out.u32(0);
        out.u32(0);
        out.push(name);
        return out.done();
    };
    const end = (size: number, offset: number, comment: Uint8Array) => {
        const out = new Bytes();
        out.u32(0x06054b50);
        out.u16(0);
        out.u16(0);
        out.u16(1);
        out.u16(1);
        out.u32(size);
        out.u32(offset);
        out.u16(comment.length);
        out.push(comment);
        return out.done();
    };
    const body = concat([header(0, crc32(data)), data]);
    const cdA = central(0, crc32(data));
    const cdB = central(8, crc32(inflated));
    const posB = body.length + cdA.length + 22;
    const hidden = concat([cdB, end(cdB.length, posB, new Uint8Array(0)), Uint8Array.of(0)]);
    return concat([body, cdA, end(cdA.length, body.length, hidden)]);
}

/* Two entries with one name: each read from its own record. */
function duplicateFixture() {
    return writeZip([
        { name: 'same.txt', data: utf8('first copy\n'), method: 0 },
        { name: 'same.txt', data: utf8('second copy\n'), method: 0 },
        { name: 'other.txt', data: utf8('other\n'), method: 0 },
    ]);
}

/* Extra fields that are not what they say: one overruns the field area, a stray AES field on a plain entry, a one-byte timestamp. */
function oddExtrasFixture() {
    const overrun = concat([field(0x4242, new Uint8Array(2)).subarray(0, 4), utf8('xy')]);
    // The overrunning field claims 40 bytes and has 2.
    overrun[2] = 40;
    return writeZip([
        {
            name: 'overrun.txt',
            data: utf8('alpha\n'),
            method: 0,
            extra: overrun,
            localExtra: new Uint8Array(0),
        },
        {
            name: 'aes-field.txt',
            data: utf8('beta\n'),
            method: 0,
            extra: field(0x9901, Uint8Array.of(2, 0, 0x41, 0x45, 3, 8, 0)),
            localExtra: new Uint8Array(0),
        },
        {
            name: 'stamp.txt',
            data: utf8('gamma\n'),
            method: 0,
            extra: field(0x5455, Uint8Array.of(1)),
            localExtra: new Uint8Array(0),
        },
    ]);
}

/* A name that starts with a byte order mark: kept, so this is not the __MACOSX folder. */
function bomFixture() {
    return writeZip([{ name: '﻿__MACOSX/x.txt', data: utf8('bom\n'), method: 0 }]);
}

/* Local headers that disagree with their records: the data-descriptor flag only in the local header, and a local size that differs. */
function localFlagsFixture() {
    return writeZip([
        {
            name: 'descriptor.txt',
            data: utf8('the local header says a descriptor follows\n'),
            localFlags: 0x808,
        },
        { name: 'size.txt', data: utf8('the local header says another size\n'), localSize: 7 },
        { name: 'fine.txt', data: utf8('fine\n') },
    ]);
}

/* A stored entry whose CRC is wrong: refused when read, on the web as on the phones. */
function storedBadCrcFixture() {
    const data = text('Stored, with the wrong checksum.');
    return writeZip([
        { name: 'stored-bad-crc.txt', data, method: 0, crc: (crc32(data) ^ 0x5a5a5a5a) >>> 0 },
    ]);
}

/* Paths deep enough to cost a listing: 32,768 parts (the longest name a zip holds), 256 parts (listed), 257 (listed flat). */
function deepFixture() {
    return writeZip([
        { name: `${'a/'.repeat(32_767)}z`, data: utf8('x'), method: 0 },
        { name: `${'b/'.repeat(255)}z`, data: utf8('x'), method: 0 },
        { name: `${'c/'.repeat(256)}z`, data: utf8('x'), method: 0 },
    ]);
}

/* An entry that holds less than it declares. */
function shortFixture() {
    const data = utf8('fifty bytes or so, less than the record declares\n');
    return writeZip([{ name: 'short.txt', data, size: data.length + 100 }]);
}

/*
 * A local header whose extra field, as its length declares it, pushes the entry's data past the
 * next entry's header: the directory alone can't see it (stage one), opening the entry does.
 */
function localOverrunFixture() {
    const zip = writeZip([
        { name: 'overruns.txt', data: utf8('aaaa'), method: 0 },
        { name: 'next.txt', data: utf8('next\n'), method: 0 },
    ]);
    // The first local header's extra field length: 36 bytes that are really the next entry.
    zip[28] = 36;
    return zip;
}

/* Two entries either side of 200:1: about 150:1 opens, about 300:1 is refused, on every client. */
function ratioFixture() {
    const pattern = (zeros: number, length: number) => {
        const out = new Uint8Array(length);
        let x = 2463534242;
        for (let at = 0; at < length; at += zeros + 4) {
            for (let i = 0; i < 4 && at + i < length; i++) {
                x ^= x << 13;
                x ^= x >>> 17;
                x ^= x << 5;
                out[at + i] = x & 0xff;
            }
        }
        return out;
    };
    return writeZip([
        { name: 'under.bin', data: pattern(RATIO_UNDER_ZEROS, 8 * MiB) },
        { name: 'over.bin', data: pattern(RATIO_OVER_ZEROS, 8 * MiB) },
    ]);
}
export const RATIO_UNDER_ZEROS = 1400;
export const RATIO_OVER_ZEROS = 2900;

/* An empty ZipCrypto entry beside a real one: the password is tried on the one with bytes. */
function zipCryptoEmptyFixture() {
    return writeZip([
        { name: 'empty.txt', data: new Uint8Array(0), method: 0, encrypt: { kind: 'zipcrypto' } },
        {
            name: 'secret.txt',
            data: text('ZipCrypto, beside an empty entry.'),
            encrypt: { kind: 'zipcrypto' },
        },
    ]);
}

/* A 20 MiB compressible entry: what WebKit's DecompressionStream hands back in one piece. */
function compressibleFixture() {
    const lines = Array.from(
        { length: 20 * 1024 },
        (_, i) => `line ${i % 97}: ${'the quick brown fox '.repeat(48)}`.padEnd(1023, '.') + '\n',
    );
    return writeZip([{ name: 'compressible.txt', data: utf8(lines.join('')) }]);
}

export type Fixture = { name: string; large: boolean; build: () => Uint8Array };

export const FIXTURES: Fixture[] = [
    { name: 'basic.zip', large: false, build: basicFixture },
    { name: 'names.zip', large: false, build: namesFixture },
    { name: 'cp437.zip', large: false, build: cp437Fixture },
    { name: 'mac.zip', large: false, build: macFixture },
    { name: 'nested.zip', large: false, build: nestedFixture },
    { name: 'symlink.zip', large: false, build: symlinkFixture },
    { name: 'methods.zip', large: false, build: methodsFixture },
    { name: 'aes.zip', large: false, build: aesFixture },
    { name: 'aes-flipped.zip', large: false, build: aesFlippedFixture },
    { name: 'zipcrypto.zip', large: false, build: zipCryptoFixture },
    { name: 'bad-crc.zip', large: false, build: badCrcFixture },
    { name: 'declares-1k.zip', large: false, build: liesFixture },
    { name: 'overlap.zip', large: false, build: overlapFixture },
    { name: 'local-mismatch.zip', large: false, build: localMismatchFixture },
    { name: 'strong.zip', large: false, build: strongFixture },
    { name: 'differential.zip', large: false, build: differentialFixture },
    { name: 'duplicate.zip', large: false, build: duplicateFixture },
    { name: 'odd-extras.zip', large: false, build: oddExtrasFixture },
    { name: 'bom.zip', large: false, build: bomFixture },
    { name: 'local-flags.zip', large: false, build: localFlagsFixture },
    { name: 'stored-bad-crc.zip', large: false, build: storedBadCrcFixture },
    { name: 'deep.zip', large: false, build: deepFixture },
    { name: 'short.zip', large: false, build: shortFixture },
    { name: 'local-overrun.zip', large: false, build: localOverrunFixture },
    { name: 'ratio.zip', large: false, build: ratioFixture },
    { name: 'zipcrypto-empty.zip', large: false, build: zipCryptoEmptyFixture },
    { name: 'compressible.zip', large: true, build: compressibleFixture },
    { name: 'zeros-1g.zip', large: true, build: zeros1GiB },
    { name: 'zip64-5g.zip', large: true, build: zip64FiveGiB },
    { name: 'entries-100001.zip', large: true, build: entries100001 },
    { name: 'directory-65m.zip', large: true, build: directory65MiB },
];

export const FIXTURE_DIR = import.meta.dirname;

/* Writes one fixture into `dir` (the large ones only where asked), returning its path. */
export function writeFixture(name: string, dir: string) {
    const fixture = FIXTURES.find((item) => item.name === name);
    if (!fixture) throw new Error(`No fixture ${name}.`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, fixture.build());
    return path;
}

if (import.meta.main) {
    const large = process.argv.indexOf('--large');
    if (large >= 0) {
        const dir = process.argv[large + 1];
        if (!dir) throw new Error('Where to? --large <dir>');
        for (const fixture of FIXTURES.filter((item) => item.large))
            console.log(writeFixture(fixture.name, dir));
    } else {
        for (const fixture of FIXTURES.filter((item) => !item.large))
            console.log(writeFixture(fixture.name, FIXTURE_DIR));
    }
}

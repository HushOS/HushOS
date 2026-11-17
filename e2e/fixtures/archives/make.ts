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

// Round 2 of the review: Fable's shapes (scratchpad make_r2.ts), written by a second, looser writer
// that sets every field by hand, with fixed salts so a rewrite gives the same bytes.

type Raw = {
    /* As text (UTF-8), or as the bytes themselves. */
    name: string | Uint8Array;
    packed: Uint8Array;
    size: number;
    crc: number;
    method: number;
    flags?: number;
    localFlags?: number;
    centralExtra?: Uint8Array;
    localExtra?: Uint8Array;
};

function writeRaw(specs: Raw[], comment = new Uint8Array(0)) {
    const body: Uint8Array[] = [];
    const directory: Uint8Array[] = [];
    let at = 0;
    for (const spec of specs) {
        const name = typeof spec.name === 'string' ? utf8(spec.name) : spec.name;
        const flags = spec.flags ?? 0;
        const localFlags = spec.localFlags ?? flags;
        const centralExtra = spec.centralExtra ?? new Uint8Array(0);
        const localExtra = spec.localExtra ?? centralExtra;
        // A data descriptor in the local header's flags: zeros there, the values after the data.
        const descriptor = (localFlags & 8) !== 0;
        const local = new Bytes();
        local.u32(0x04034b50);
        local.u16(20);
        local.u16(localFlags);
        local.u16(spec.method);
        local.u16(0x6000);
        local.u16(0x5821);
        local.u32(descriptor ? 0 : spec.crc);
        local.u32(descriptor ? 0 : spec.packed.length);
        local.u32(descriptor ? 0 : spec.size);
        local.u16(name.length);
        local.u16(localExtra.length);
        local.push(name);
        local.push(localExtra);
        local.push(spec.packed);
        if (descriptor) {
            local.u32(0x08074b50);
            local.u32(spec.crc);
            local.u32(spec.packed.length);
            local.u32(spec.size);
        }
        const bytes = local.done();
        const central = new Bytes();
        central.u32(0x02014b50);
        central.u16(20);
        central.u16(20);
        central.u16(flags);
        central.u16(spec.method);
        central.u16(0x6000);
        central.u16(0x5821);
        central.u32(spec.crc);
        central.u32(spec.packed.length);
        central.u32(spec.size);
        central.u16(name.length);
        central.u16(centralExtra.length);
        central.u16(0);
        central.u16(0);
        central.u16(0);
        central.u32(0);
        central.u32(at);
        central.push(name);
        central.push(centralExtra);
        directory.push(central.done());
        body.push(bytes);
        at += bytes.length;
    }
    const dir = concat(directory);
    const end = new Bytes();
    end.u32(0x06054b50);
    end.u16(0);
    end.u16(0);
    end.u16(specs.length);
    end.u16(specs.length);
    end.u32(dir.length);
    end.u32(at);
    end.u16(comment.length);
    return concat([...body, dir, end.done(), comment]);
}

// Round 3: Fable's shapes (scratchpad make_r3.ts), and two passwords in one archive.

/* An end record's signature, then 20 zeros: the shape a reader scanning for it finds. */
const signature = (value: number) => {
    const out = new Bytes();
    out.u32(value);
    out.push(new Uint8Array(20));
    return out.done();
};

/*
 * An end record planted in an entry's name. zip.js reads each entry from a one-entry archive the
 * worker writes from its record (zip-archive.ts): the planted record's comment reaches that
 * archive's end, and its directory's offset and size point at the record itself, so a reader
 * that scans for the end finds two. Both entries open, on every client.
 */
function nameEndRecordFixture() {
    const packed = FOX_PACKED();
    const prefix = utf8('planted-');
    const suffix = utf8('.txt');
    const nameLength = prefix.length + 22 + suffix.length;
    // Where the worker's one-entry archive puts its directory: header, name, data, then its gap.
    const span = 30 + nameLength + packed.length + 65_557 + 64;
    const planted = new Bytes();
    planted.u32(0x06054b50);
    planted.u16(0);
    planted.u16(0);
    planted.u16(1);
    planted.u16(1);
    planted.u32(46 + prefix.length);
    planted.u32(span);
    planted.u16(suffix.length + 20 + 22);
    return writeRaw([
        {
            name: concat([prefix, planted.done(), suffix]),
            packed,
            size: FOX.length,
            crc: crc32(FOX),
            method: 8,
        },
        { name: 'plain.txt', packed, size: FOX.length, crc: crc32(FOX), method: 8 },
    ]);
}

/* The directory's signatures elsewhere: in a local extra field, in names, in the archive's comment. */
function signaturesFixture() {
    const packed = FOX_PACKED();
    const entry = (name: string | Uint8Array, localExtra?: Uint8Array): Raw => ({
        name,
        packed,
        size: FOX.length,
        crc: crc32(FOX),
        method: 8,
        centralExtra: new Uint8Array(0),
        localExtra,
    });
    return writeRaw(
        [
            entry(
                'extra.txt',
                field(
                    0x4242,
                    concat([signature(0x06054b50), signature(0x07064b50), signature(0x06064b50)]),
                ),
            ),
            entry(
                concat([
                    utf8('locator-'),
                    signature(0x07064b50),
                    signature(0x06064b50),
                    utf8('.txt'),
                ]),
            ),
            entry(
                concat([
                    utf8('central-'),
                    signature(0x02014b50),
                    signature(0x04034b50),
                    utf8('.txt'),
                ]),
            ),
        ],
        concat([
            utf8('a comment holding '),
            signature(0x06054b50).subarray(0, 4),
            utf8(' and more'),
        ]),
    );
}

/* The second password of `twoPasswordsFixture`. */
export const SECOND_PASSWORD = 'second password';

/*
 * Two entries locked with two passwords: an unlock aimed at the second one with its own password
 * opens; the same password tried from the smallest entry, the first, is wrong.
 */
function twoPasswordsFixture() {
    const first = aesAt(FOX, 3, 601);
    const second = aesAt(concat([FOX, FOX]), 3, 602, SECOND_PASSWORD);
    const locked = (name: string, bytes: Uint8Array, size: number): Raw => ({
        name,
        packed: bytes,
        size,
        crc: 0,
        method: 99,
        flags: 1,
        centralExtra: aesFieldAt(2, 3, 0),
    });
    return writeRaw([
        locked('first.txt', first.bytes, FOX.length),
        locked('second.txt', second.bytes, FOX.length * 2),
    ]);
}

/*
 * One locked entry that declares 256 MiB of zeros in about 256 KB, past the declared ratio: an
 * unlock never inflates it to probe the password (a 16 MiB stream could declare gigabytes), and
 * reads only its password check.
 */
function lockedRatioFixture() {
    const size = 256 * MiB;
    const encrypted = aesAt(deflatedZeros(size), 3, 701);
    return writeRaw([
        {
            name: 'zeros.bin',
            packed: encrypted.bytes,
            size,
            crc: 0,
            method: 99,
            flags: 1,
            centralExtra: aesFieldAt(2, 3, 8),
        },
    ]);
}

/*
 * AES entries that are all empty: none has bytes, but each carries its keyed authentication code,
 * so the right password opens the archive and a wrong one doesn't.
 */
function aesEmptyFixture() {
    const locked = (name: string, version: 1 | 2, seed: number): Raw => ({
        name,
        packed: aesAt(new Uint8Array(0), 3, seed).bytes,
        size: 0,
        crc: 0,
        method: 99,
        flags: 1,
        centralExtra: aesFieldAt(version, 3, 0),
    });
    return writeRaw([locked('empty-ae2.txt', 2, 801), locked('empty-ae1.txt', 1, 802)]);
}

/*
 * One ZipCrypto entry an unlock can't prove: 2 MiB of zeros in about 2 KB, past the declared
 * ratio, so a password is tried on its one check byte alone. UNPROVEN_PASSWORD is a wrong
 * password that byte passes (1 in 256 do): the unlock holds it, and the download that then
 * reads damage lets it go and asks again (`password-unproven`).
 */
const UNPROVEN_DATA = () => new Uint8Array(2 * MiB);
function unprovenFixture() {
    return writeZip([
        { name: 'zeros.bin', data: UNPROVEN_DATA(), method: 8, encrypt: { kind: 'zipcrypto' } },
    ]);
}

/* The first of "wrong 0", "wrong 1", … whose decrypted check byte is `unprovenFixture`'s. */
export const UNPROVEN_PASSWORD = (() => {
    const check = (crc32(UNPROVEN_DATA()) >>> 24) & 0xff;
    const header = zipCryptoEncrypt(new Uint8Array(0), PASSWORD, check, fixed(11, 12));
    for (let n = 0; ; n++) {
        const candidate = `wrong ${n}`;
        const keys = [0x12345678, 0x23456789, 0x34567890];
        const crcByte = (crc: number, byte: number) =>
            (TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
        const update = (byte: number) => {
            keys[0] = crcByte(keys[0]!, byte);
            keys[1] = (Math.imul((keys[1]! + (keys[0]! & 0xff)) >>> 0, 134775813) + 1) >>> 0;
            keys[2] = crcByte(keys[2]!, keys[1]! >>> 24);
        };
        for (const byte of utf8(candidate)) update(byte);
        let last = 0;
        for (const byte of header) {
            const temp = (keys[2]! | 2) >>> 0;
            last = byte ^ ((Math.imul(temp, temp ^ 1) >>> 8) & 0xff);
            update(last);
        }
        if (last === check) return candidate;
    }
})();

/* WinZip AES at any strength, the salt fixed by `seed`. */
function aesAt(data: Uint8Array, strength: 1 | 2 | 3, seed: number, password = PASSWORD) {
    const keyLength = [16, 24, 32][strength - 1]!;
    const salt = fixed(seed, [8, 12, 16][strength - 1]!);
    const derived = pbkdf2Sync(password, salt, 1000, keyLength * 2 + 2, 'sha1');
    const cipher = createCipheriv(
        `aes-${keyLength * 8}-ecb`,
        derived.subarray(0, keyLength),
        null,
    ).setAutoPadding(false);
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
    const mac = createHmac('sha1', derived.subarray(keyLength, keyLength * 2))
        .update(out)
        .digest()
        .subarray(0, 10);
    return {
        bytes: concat([salt, derived.subarray(keyLength * 2), out, mac]),
        dataAt: salt.length + 2,
    };
}

function aesFieldAt(version: number, strength: number, method: number) {
    return field(
        0x9901,
        Uint8Array.of(version, 0, 0x41, 0x45, strength, method & 0xff, method >> 8),
    );
}

const FOX = utf8('The quick brown fox jumps over the lazy dog. '.repeat(40) + '\n');
const FOX_PACKED = () => new Uint8Array(deflateRawSync(FOX, { level: 9 }));

/* Bytes after a deflate stream's end, inside the entry's declared size: refused on every client. */
function trailingFixture() {
    return writeRaw([
        {
            name: 'trailing.txt',
            packed: concat([FOX_PACKED(), utf8('JUNK AFTER THE END')]),
            size: FOX.length,
            crc: crc32(FOX),
            method: 8,
        },
    ]);
}

/* A deflate stream cut before its final block. */
function truncatedFixture() {
    const p = utf8('cut before the end of the stream\n');
    const block = Uint8Array.of(
        0,
        p.length & 0xff,
        p.length >> 8,
        ~p.length & 0xff,
        (~p.length >> 8) & 0xff,
    );
    return writeRaw([
        {
            name: 'truncated.txt',
            packed: concat([block, p]),
            size: p.length,
            crc: crc32(p),
            method: 8,
        },
    ]);
}

/* The UTF-8 flag only in the local header, and only in the central record: both refused. */
function utf8FlagFixture() {
    const packed = FOX_PACKED();
    return writeRaw([
        {
            name: 'local-only.txt',
            packed,
            size: FOX.length,
            crc: crc32(FOX),
            method: 8,
            flags: 0,
            localFlags: 0x800,
        },
        {
            name: 'central-only.txt',
            packed,
            size: FOX.length,
            crc: crc32(FOX),
            method: 8,
            flags: 0x800,
            localFlags: 0,
        },
        { name: 'both.txt', packed, size: FOX.length, crc: crc32(FOX), method: 8, flags: 0x800 },
    ]);
}

/* 12 MiB of zeros, then 1 MiB of noise: about 12:1 in all, 1,000:1 at the start. Opens: only the declared ratio counts. */
function frontLoadedFixture() {
    const data = new Uint8Array(13 * MiB);
    data.set(fixed(4242, MiB), 12 * MiB);
    return writeRaw([
        {
            name: 'front-loaded.bin',
            packed: new Uint8Array(deflateRawSync(data, { level: 9 })),
            size: data.length,
            crc: crc32(data),
            method: 8,
        },
    ]);
}

/* Stored data that ends in an end record whose comment reaches the end of a one-entry archive: opens as the stored bytes it is. */
function ambiguousFixture() {
    const name = 'ambiguous.bin';
    const tail = 46 + name.length + 22;
    const body = utf8('ordinary bytes before a planted end record ');
    const span = 30 + name.length + body.length + 22;
    const fake = new Bytes();
    fake.u32(0x06054b50);
    fake.u16(0);
    fake.u16(0);
    fake.u16(1);
    fake.u16(1);
    fake.u32(46 + name.length);
    fake.u32(span);
    fake.u16(tail);
    const data = concat([body, fake.done()]);
    return writeRaw([{ name, packed: data, size: data.length, crc: crc32(data), method: 0 }]);
}

/* ZipCrypto with a data descriptor's check byte (from the time) and stored; AES at every strength, AE-1 and AE-2, stored and deflated. */
function ciphersFixture() {
    const packed = FOX_PACKED();
    const specs: Raw[] = [
        {
            name: 'zc-descriptor.txt',
            packed: zipCryptoEncrypt(packed, PASSWORD, 0x60, fixed(301, 12)),
            size: FOX.length,
            crc: crc32(FOX),
            method: 8,
            flags: 9,
            localFlags: 9,
        },
        {
            name: 'zc-stored.txt',
            packed: zipCryptoEncrypt(FOX, PASSWORD, crc32(FOX) >>> 24, fixed(302, 12)),
            size: FOX.length,
            crc: crc32(FOX),
            method: 0,
            flags: 1,
        },
    ];
    let seed = 400;
    for (const strength of [1, 2, 3] as const)
        for (const version of [1, 2])
            for (const method of [0, 8]) {
                const encrypted = aesAt(method ? packed : FOX, strength, seed++);
                specs.push({
                    name: `aes${strength}-ae${version}-m${method}.txt`,
                    packed: encrypted.bytes,
                    size: FOX.length,
                    crc: version === 1 ? crc32(FOX) : 0,
                    method: 99,
                    flags: 1,
                    centralExtra: aesFieldAt(version, strength, method),
                });
            }
    return writeRaw(specs);
}

/* AES gone wrong: a flipped byte (deflated and stored), AE-1 with a wrong CRC, another password, no AES field in the local header. */
function aesTamperedFixture() {
    const flippedDeflated = aesAt(FOX_PACKED(), 3, 501);
    flippedDeflated.bytes[flippedDeflated.dataAt + 5]! ^= 1;
    const flippedStored = aesAt(FOX, 3, 502);
    flippedStored.bytes[flippedStored.dataAt + 5]! ^= 1;
    const ok = aesAt(FOX, 3, 503);
    const entry = (name: string, packed: Uint8Array, extra: Partial<Raw> = {}): Raw => ({
        name,
        packed,
        size: FOX.length,
        crc: 0,
        method: 99,
        flags: 1,
        centralExtra: aesFieldAt(2, 3, 0),
        ...extra,
    });
    return writeRaw([
        // An unlock tries the two tampered ones first (smallest, then first listed) and must go past
        // them to ok.txt, the third and the last it may try.
        entry('flipped-deflated.txt', flippedDeflated.bytes, { centralExtra: aesFieldAt(2, 3, 8) }),
        entry('flipped-stored.txt', flippedStored.bytes),
        entry('ok.txt', ok.bytes),
        entry('ae1-bad-crc.txt', aesAt(FOX, 3, 504).bytes, {
            crc: 0x12345678,
            centralExtra: aesFieldAt(1, 3, 0),
        }),
        entry('other-password.txt', aesAt(FOX, 3, 505, 'another password').bytes),
        entry('local-no-aes-field.txt', ok.bytes, { localExtra: new Uint8Array(0) }),
    ]);
}

/* Sizes that disagree with the data: stored longer and shorter, an empty deflated entry, deflated one byte more and one less. */
function sizesFixture() {
    const packed = FOX_PACKED();
    return writeRaw([
        {
            name: 'stored-longer.txt',
            packed: FOX,
            size: FOX.length - 10,
            crc: crc32(FOX.subarray(0, FOX.length - 10)),
            method: 0,
        },
        {
            name: 'stored-shorter.txt',
            packed: FOX,
            size: FOX.length + 10,
            crc: crc32(FOX),
            method: 0,
        },
        { name: 'empty-deflated.txt', packed: Uint8Array.of(3, 0), size: 0, crc: 0, method: 8 },
        { name: 'one-more.txt', packed, size: FOX.length + 1, crc: crc32(FOX), method: 8 },
        {
            name: 'one-less.txt',
            packed,
            size: FOX.length - 1,
            crc: crc32(FOX.subarray(0, FOX.length - 1)),
            method: 8,
        },
    ]);
}

/*
 * 50,000 entries of 42 parts, each under a folder of its own (`<n>/a/a/…/f`): 2,050,000 folders
 * in a 6.6 MiB directory, past the 2,000,000 a listing makes, so it is refused on every client.
 */
function folders2MFixture() {
    const specs: Spec[] = [];
    for (let i = 0; i < 50_000; i++)
        specs.push({ name: `${i.toString(16)}/${'a/'.repeat(40)}f`, data: utf8('x'), method: 0 });
    return writeZip(specs);
}

/* 1,000 entries of 256 parts, 256,000 in all: every one listed in its folder, none flat. */
function wideFixture() {
    const specs: Spec[] = [];
    for (let i = 0; i < 1_000; i++)
        specs.push({
            name: `${Array.from({ length: 255 }, (_, d) => `p${d}`).join('/')}/f${i}`,
            data: utf8('x'),
            method: 0,
        });
    return writeZip(specs);
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
    { name: 'trailing.zip', large: false, build: trailingFixture },
    { name: 'truncated.zip', large: false, build: truncatedFixture },
    { name: 'utf8-flag.zip', large: false, build: utf8FlagFixture },
    { name: 'ambiguous.zip', large: false, build: ambiguousFixture },
    { name: 'ciphers.zip', large: false, build: ciphersFixture },
    { name: 'aes-tampered.zip', large: false, build: aesTamperedFixture },
    { name: 'sizes.zip', large: false, build: sizesFixture },
    { name: 'name-eocd.zip', large: false, build: nameEndRecordFixture },
    { name: 'signatures.zip', large: false, build: signaturesFixture },
    { name: 'two-passwords.zip', large: false, build: twoPasswordsFixture },
    { name: 'locked-ratio.zip', large: false, build: lockedRatioFixture },
    { name: 'aes-empty.zip', large: false, build: aesEmptyFixture },
    { name: 'unproven.zip', large: false, build: unprovenFixture },
    { name: 'front-loaded.zip', large: true, build: frontLoadedFixture },
    { name: 'wide.zip', large: true, build: wideFixture },
    { name: 'folders-2m.zip', large: true, build: folders2MFixture },
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

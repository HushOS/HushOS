// @vitest-environment node
import { createDeflateRaw, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { field, unicodePath, writeZip } from '../../../../../e2e/fixtures/archives/make';
import {
    asksFirst,
    checkLocalHeader,
    checkOverlap,
    crc32,
    decodeName,
    extraFields,
    findDirectory,
    InflateCounter,
    listEntries,
    readDirectory,
    ZIP_LIMITS,
    ZipError,
    type ZipEntry,
} from './zip-format';

const MiB = 1024 * 1024;
const utf8 = (text: string) => new TextEncoder().encode(text);

function reader(bytes: Uint8Array) {
    const reads: [number, number][] = [];
    return {
        reads,
        read: async (offset: number, length: number) => {
            reads.push([offset, length]);
            return bytes.subarray(offset, offset + length);
        },
    };
}

async function list(bytes: Uint8Array) {
    const { read } = reader(bytes);
    const directory = await findDirectory(bytes.length, read);
    return readDirectory(await read(directory.offset, directory.size), directory);
}

async function refusal(promise: Promise<unknown> | (() => unknown)) {
    try {
        await (typeof promise === 'function' ? promise() : promise);
    } catch (error) {
        if (error instanceof ZipError) return error.code;
        throw error;
    }
    return 'accepted';
}

/* An end record (and a ZIP64 one when asked) that declares what a test needs, behind `before` bytes. */
function endRecord(options: {
    count: number;
    size: number;
    offset: number;
    disk?: number;
    comment?: number;
    zip64?: boolean;
}) {
    const parts: number[] = [];
    const u16 = (n: number) => parts.push(n & 0xff, (n >>> 8) & 0xff);
    const u32 = (n: number) => {
        for (let i = 0; i < 4; i++) parts.push((n >>> (8 * i)) & 0xff);
    };
    const u64 = (n: number) => {
        const big = BigInt(n);
        for (let i = 0n; i < 8n; i++) parts.push(Number((big >> (8n * i)) & 0xffn));
    };
    const recordAt = options.offset + options.size;
    if (options.zip64) {
        u32(0x06064b50);
        u64(44);
        u16(45);
        u16(45);
        u32(0);
        u32(0);
        u64(options.count);
        u64(options.count);
        u64(options.size);
        u64(options.offset);
        u32(0x07064b50);
        u32(0);
        u64(recordAt);
        u32(1);
    }
    u32(0x06054b50);
    u16(options.disk ?? 0);
    u16(options.disk ?? 0);
    u16(options.zip64 ? 0xffff : options.count);
    u16(options.zip64 ? 0xffff : options.count);
    u32(options.zip64 ? 0xffffffff : options.size);
    u32(options.zip64 ? 0xffffffff : options.offset);
    u16(options.comment ?? 0);
    for (let i = 0; i < (options.comment ?? 0); i++) parts.push(0x20);
    return Uint8Array.from(parts);
}

/* A file whose last bytes are `tail` and whose size says the directory sits right before it, never read. */
function virtual(size: number, tail: Uint8Array) {
    const reads: [number, number][] = [];
    return {
        reads,
        size,
        read: async (offset: number, length: number) => {
            reads.push([offset, length]);
            const out = new Uint8Array(length);
            const tailStart = size - tail.length;
            for (let i = 0; i < length; i++) {
                const at = offset + i - tailStart;
                if (at >= 0 && at < tail.length) out[i] = tail[at]!;
            }
            return out;
        },
    };
}

describe('finding the directory', () => {
    it('refuses more than 100,000 entries before reading the directory', async () => {
        for (const [count, outcome] of [
            [100_000, 'accepted'],
            [100_001, 'too-many-entries'],
        ] as const) {
            const size = count * 46;
            const tail = endRecord({ count, size, offset: 4096, zip64: true });
            const file = virtual(4096 + size + tail.length, tail);
            expect(await refusal(findDirectory(file.size, file.read))).toBe(outcome);
            // Only the tail and the ZIP64 records were read, never the 4.6 MB directory.
            expect(file.reads.every(([, length]) => length <= 65_557)).toBe(true);
        }
    });

    it('refuses a directory over 64 MiB, and takes one of exactly 64 MiB', async () => {
        for (const [size, outcome] of [
            [ZIP_LIMITS.directoryBytes, 'accepted'],
            [ZIP_LIMITS.directoryBytes + 1, 'directory-too-large'],
        ] as const) {
            const tail = endRecord({ count: 1000, size, offset: 100 });
            const file = virtual(100 + size + tail.length, tail);
            expect(await refusal(findDirectory(file.size, file.read))).toBe(outcome);
            expect(file.reads.every(([, length]) => length <= 65_557)).toBe(true);
        }
    });

    it('needs the end record to reach the end of the file, and the directory to end where it starts', async () => {
        const zip = writeZip([{ name: 'a.txt', data: utf8('a') }]);
        expect(await refusal(list(zip))).toBe('accepted');
        // A byte after the end record: no record's comment reaches the end.
        expect(await refusal(list(Uint8Array.from([...zip, 0])))).toBe('damaged');
        // Prepended bytes move everything: the recorded offsets no longer meet.
        expect(await refusal(list(Uint8Array.from([0, ...zip])))).toBe('damaged');
    });

    it('refuses archives split across disks', async () => {
        const tail = endRecord({ count: 1, size: 46, offset: 0, disk: 1 });
        const file = virtual(46 + tail.length, tail);
        expect(await refusal(findDirectory(file.size, file.read))).toBe('split');
    });
});

const entry = (offset: number, packed: number, name = 'n', index = 0): ZipEntry => ({
    index,
    raw: utf8(name),
    path: name,
    directory: false,
    flags: 0,
    method: 0,
    crc: 0,
    packed,
    size: packed,
    offset,
    bound: 0,
    dos: 0,
    mtime: null,
    lock: 'none',
    aes: null,
    link: false,
});

describe('overlapping entries', () => {
    it('takes spans that meet end to start, and refuses one a byte past', async () => {
        // 30-byte header, 1-byte name, 9 bytes of data: 40 bytes each.
        const two = (a: number, b: number) => () =>
            checkOverlap([entry(0, a), entry(40, b, 'n', 1)], 80);
        expect(await refusal(two(9, 9))).toBe('accepted');
        expect(await refusal(two(10, 9))).toBe('overlap');
        expect(await refusal(two(9, 10))).toBe('overlap');
    });

    it('refuses two records naming one local header, whatever their order', async () => {
        expect(await refusal(() => checkOverlap([entry(0, 9), entry(0, 9, 'm', 1)], 80))).toBe(
            'overlap',
        );
        expect(
            await refusal(() =>
                checkOverlap([entry(40, 9), entry(0, 9, 'n', 1), entry(40, 9, 'n', 2)], 80),
            ),
        ).toBe('overlap');
    });

    it('checks the whole span once the local header is read, extra field and descriptor included', async () => {
        const zip = writeZip([
            {
                name: 'a',
                data: utf8('aaaa'),
                method: 0,
                localExtra: field(0xcafe, new Uint8Array(8)),
            },
            { name: 'b', data: utf8('b'), method: 0 },
        ]);
        const [a] = await list(zip);
        expect(await refusal(() => checkLocalHeader(a!, zip.subarray(a!.offset)))).toBe('accepted');
        // The same entry told its neighbour starts 11 bytes sooner: its extra field now overruns.
        expect(
            await refusal(() =>
                checkLocalHeader({ ...a!, bound: a!.bound - 11 }, zip.subarray(a!.offset)),
            ),
        ).toBe('overlap');
    });
});

describe('local headers', () => {
    it('must name the entry as the directory does', async () => {
        const zip = writeZip([{ name: 'shown.txt', localName: 'other.txt', data: utf8('x') }]);
        const [shown] = await list(zip);
        expect(await refusal(() => checkLocalHeader(shown!, zip.subarray(0)))).toBe('local');
    });

    it('must declare the same CRC and sizes, unless a data descriptor follows with zeros', async () => {
        const zip = writeZip([{ name: 'a.txt', data: utf8('hello') }]);
        const [a] = await list(zip);
        expect(await refusal(() => checkLocalHeader({ ...a!, size: a!.size + 1 }, zip))).toBe(
            'local',
        );
        expect(await refusal(() => checkLocalHeader({ ...a!, crc: a!.crc ^ 1 }, zip))).toBe(
            'local',
        );
        const streamed = writeZip([{ name: 'a.txt', data: utf8('hello'), descriptor: true }]);
        const [s] = await list(streamed);
        expect(await refusal(() => checkLocalHeader(s!, streamed))).toBe('accepted');
    });
});

describe('names', () => {
    const cp437Name = Uint8Array.from([0x63, 0x61, 0x66, 0x82, 0x9b, 0xff]);

    it('reads UTF-8 when the flag says so, whatever the bytes', () => {
        expect(decodeName(utf8('día'), 0x800, new Map())).toBe('día');
        // Not UTF-8 at all, but flagged: replacement characters, never CP437.
        expect(decodeName(cp437Name, 0x800, new Map())).toBe('caf���');
    });

    it('takes the Unicode path field only when its CRC is the stored name’s', () => {
        const fields = extraFields(unicodePath(cp437Name, 'Ünïcødé.txt'));
        expect(decodeName(cp437Name, 0, fields)).toBe('Ünïcødé.txt');
        const stale = extraFields(unicodePath(cp437Name, 'wrong.txt', crc32(cp437Name) ^ 1));
        expect(decodeName(cp437Name, 0, stale)).toBe('café¢ ');
    });

    it('reads strict UTF-8 without the flag, and CP437 when the bytes are not UTF-8', () => {
        expect(decodeName(utf8('naïve.txt'), 0, new Map())).toBe('naïve.txt');
        expect(decodeName(cp437Name, 0, new Map())).toBe('café¢ ');
        // A UTF-8 sequence cut short is not UTF-8.
        expect(decodeName(Uint8Array.from([0x61, 0xc3]), 0, new Map())).toBe('a├');
    });
});

describe('the list', () => {
    it('hides Mac resource entries, and an AppleDouble file only beside its original', async () => {
        const zip = writeZip([
            { name: 'a.jpg', data: utf8('a') },
            { name: '__MACOSX/._a.jpg', data: utf8('r') },
            { name: '._a.jpg', data: utf8('r') },
            { name: '._lonely', data: utf8('r') },
            { name: 'd/._x', data: utf8('r') },
            { name: 'd/x/y.txt', data: utf8('y') },
        ]);
        const listed = listEntries(await list(zip));
        expect(listed.filter((item) => item.hidden).map((item) => item.path)).toEqual([
            '__MACOSX/._a.jpg',
            '._a.jpg',
            // `d/x` exists only as a folder implied by d/x/y.txt, and still counts as the original.
            'd/._x',
        ]);
    });

    it('marks archives inside the archive, links and stored entries', async () => {
        const zip = writeZip([
            { name: 'in.zip', data: utf8('zip'), method: 0 },
            { name: 'site.tar.gz', data: utf8('tgz') },
            { name: 'doc.docx', data: utf8('office is a zip, but not an archive to open') },
            {
                name: 'l',
                data: utf8('/etc/passwd'),
                method: 0,
                versionMadeBy: (3 << 8) | 20,
                externalAttributes: (0o120777 << 16) >>> 0,
            },
        ]);
        const listed = listEntries(await list(zip));
        expect(listed.map((item) => [item.path, item.nested, item.link, item.stored])).toEqual([
            ['in.zip', true, false, true],
            ['site.tar.gz', true, false, false],
            ['doc.docx', false, false, false],
            ['l', false, true, false],
        ]);
    });
});

/* Runs a real raw-deflate stream through the counter, as the worker does: what it read, what came out. */
async function inflateThrough(compressed: Uint8Array, declared: number, ratio: boolean) {
    const counter = new InflateCounter(declared, ratio);
    const stream = new DecompressionStream('deflate-raw');
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    // Fed 64 KiB at a time, each write waiting for the inflater to take it, as range reads arrive.
    void (async () => {
        for (let at = 0; at < compressed.length; at += 64 * 1024) {
            const piece = compressed.subarray(at, at + 64 * 1024);
            counter.read(piece.length);
            await writer.write(piece as Uint8Array<ArrayBuffer>);
        }
        await writer.close();
    })().catch(() => {});
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            counter.wrote(value.length);
        }
        counter.finish();
        return { counter, outcome: 'ok' };
    } catch (error) {
        await reader.cancel().catch(() => {});
        await writer.abort().catch(() => {});
        return { counter, outcome: error instanceof ZipError ? error.code : String(error) };
    }
}

async function deflateStream(bytes: Uint8Array) {
    const chunks: Buffer[] = [];
    const deflate = createDeflateRaw({ level: 9 });
    deflate.on('data', (chunk: Buffer) => chunks.push(chunk));
    const end = new Promise((resolve) => deflate.on('end', resolve));
    deflate.end(bytes);
    await end;
    return new Uint8Array(Buffer.concat(chunks));
}

describe('the inflate counter on real streams', () => {
    it('refuses zeros past 200:1 once a MiB has come out, and long before the end', async () => {
        const zeros = await deflateStream(new Uint8Array(256 * MiB));
        const { outcome, counter } = await inflateThrough(zeros, 256 * MiB, true);
        expect(outcome).toBe('ratio');
        expect(counter.produced).toBeGreaterThan(MiB);
        expect(counter.produced).toBeLessThan(64 * MiB);
    });

    it('lets ordinary text through, and the same zeros when the ratio is off (a download)', async () => {
        const words = utf8(
            Array.from({ length: 200_000 }, (_, i) => `word${(i * 7919) % 104729}`).join(' '),
        );
        expect((await inflateThrough(deflateRawSync(words), words.length, true)).outcome).toBe(
            'ok',
        );
        const zeros = await deflateStream(new Uint8Array(32 * MiB));
        expect((await inflateThrough(zeros, 32 * MiB, false)).outcome).toBe('ok');
    });

    it('stops at the byte past the declared size, and fails a stream that comes up short', async () => {
        // Noise, so it barely compresses: the ratio never comes into it.
        let x = 2463534242;
        const data = new Uint8Array(3 * MiB).map(() => {
            x ^= x << 13;
            x ^= x >>> 17;
            x ^= x << 5;
            return x & 0xff;
        });
        const packed = deflateRawSync(data);
        expect((await inflateThrough(packed, data.length, true)).outcome).toBe('ok');
        const over = await inflateThrough(packed, data.length - 1, false);
        expect(over.outcome).toBe('size');
        expect(over.counter.produced).toBeLessThanOrEqual(data.length);
        expect((await inflateThrough(packed, data.length + 1, false)).outcome).toBe('short');
    });
});

describe('downloads that ask first', () => {
    it('asks above 4 GiB at more than 200:1, and not otherwise', () => {
        const GiB = 1024 * MiB;
        expect(asksFirst({ size: 5 * GiB, packed: 5 * MiB })).toBe(true);
        expect(asksFirst({ size: 4 * GiB, packed: MiB })).toBe(false);
        expect(asksFirst({ size: 5 * GiB, packed: Math.ceil((5 * GiB) / 200) })).toBe(false);
    });
});

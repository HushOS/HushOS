import {
    configure,
    ERR_ENCRYPTED,
    ERR_INVALID_AUTHENTICATION_CODE,
    ERR_INVALID_CRC32,
    ERR_INVALID_PASSWORD,
    ERR_INVALID_UNCOMPRESSED_SIZE,
    ERR_UNSUPPORTED_COMPRESSION,
    ERR_UNSUPPORTED_ENCRYPTION,
    Reader,
    ZipReader,
    type FileEntry,
} from '@zip.js/zip.js/lib/zip-core-native.js';
import {
    checkLocalHeader,
    findDirectory,
    hiddenCount,
    InflateCounter,
    listEntries,
    LOCAL_HEADER_READ,
    readDirectory,
    supportOf,
    ZipError,
    type Listed,
    type Read,
    type ZipEntry,
} from './zip-format';

/*
 * One open zip: its listing from zip-format.ts, and its entries' data through zip.js, which
 * runs inside the archive's tools worker with its own workers off (it is in one already) and
 * the native DecompressionStream for Deflate, its JavaScript inflater for Deflate64. zip.js
 * parses the directory a second time, once, when the first entry is opened; every entry it
 * hands back is checked against ours (offset, sizes, method, name bytes), so the two readers
 * can never be reading different files. A password the person typed is held here, and only
 * here, for as long as the archive is open.
 */

/*
 * Small pieces: zip.js inflates what it reads a piece at a time, and WebKit's DecompressionStream
 * hands back everything one write makes as one chunk (64 MiB measured for 64 KiB of zeros). At
 * 16 KiB a piece, one write makes at most about 16 MiB before the counter sees it.
 */
export const ZIP_JS_CHUNK_BYTES = 16 * 1024;
configure({ useWebWorkers: false, chunkSize: ZIP_JS_CHUNK_BYTES });

export type Source = { size: number; read: Read };

/*
 * One entry as an archive of its own, for zip.js: the entry's local header and data, read from
 * the archive by range, then a central directory record and end record written here from our
 * listing (our offsets, method, CRC and sizes, the AES field when it is AES). zip.js never sees
 * the archive's own directory, so it can't read the entry under a different record from the one
 * listed, and an entry it would have parsed differently (a duplicate name, an odd extra field)
 * is read as listed.
 */
class EntryReader extends Reader<Source> {
    #tail: Uint8Array;
    #span: number;
    constructor(
        private source: Source,
        private entry: ZipEntry,
        dataStart: number,
        private counter: InflateCounter,
    ) {
        super(source);
        this.#span = dataStart - entry.offset + entry.packed;
        this.#tail = directoryFor(entry, this.#span);
        this.size = this.#span + this.#tail.length;
        this.dataFrom = dataStart - entry.offset;
    }
    readonly dataFrom: number;

    override async init() {
        this.size = this.#span + this.#tail.length;
    }

    override async readUint8Array(index: number, length: number) {
        const end = Math.min(this.size, index + length);
        const out = new Uint8Array(Math.max(0, end - index));
        if (index < this.#span) {
            const stop = Math.min(end, this.#span);
            const bytes = await this.source.read(this.entry.offset + index, stop - index);
            out.set(bytes, 0);
            // What the inflater reads of the data: the ratio counter's input.
            const overlap =
                Math.min(stop, this.dataFrom + this.entry.packed) - Math.max(index, this.dataFrom);
            // Counted by how far into the data the reads have reached, so a range read twice counts once.
            if (overlap > 0)
                this.counter.reached(
                    Math.min(stop, this.dataFrom + this.entry.packed) - this.dataFrom,
                );
        }
        if (end > this.#span) {
            const from = Math.max(index, this.#span);
            out.set(this.#tail.subarray(from - this.#span, end - this.#span), from - index);
        }
        return out;
    }
}

/* The central directory record and end records of a one-entry archive whose local header is at 0. */
function directoryFor(entry: ZipEntry, span: number) {
    const parts: number[] = [];
    const u16 = (n: number) => parts.push(n & 0xff, (n >>> 8) & 0xff);
    const u32 = (n: number) => {
        for (let i = 0; i < 4; i++) parts.push(Math.floor(n / 2 ** (8 * i)) & 0xff);
    };
    const u64 = (n: number) => {
        u32(n % 2 ** 32);
        u32(Math.floor(n / 2 ** 32));
    };
    const wide = entry.size >= 0xffffffff || entry.packed >= 0xffffffff;
    const extra: number[] = [];
    if (wide) {
        extra.push(0x01, 0x00, 16, 0);
        for (const value of [entry.size, entry.packed])
            for (let i = 0; i < 8; i++) extra.push(Math.floor(value / 2 ** (8 * i)) & 0xff);
    }
    if (entry.lock === 'aes' && entry.aes)
        extra.push(
            0x01,
            0x99,
            7,
            0,
            entry.aes.version & 0xff,
            0,
            0x41,
            0x45,
            entry.aes.strength,
            entry.aes.method & 0xff,
            entry.aes.method >> 8,
        );
    u32(0x02014b50);
    u16((3 << 8) | 45);
    u16(wide ? 45 : 20);
    u16(entry.flags);
    u16(entry.method);
    u16(entry.dos & 0xffff);
    u16(entry.dos >>> 16);
    u32(entry.crc);
    u32(wide ? 0xffffffff : entry.packed);
    u32(wide ? 0xffffffff : entry.size);
    u16(entry.raw.length);
    u16(extra.length);
    u16(0);
    u16(0);
    u16(0);
    u32(0);
    u32(0);
    // A loop, not a spread: a 64 KiB name is more arguments than a worker's stack takes.
    for (const byte of entry.raw) parts.push(byte);
    for (const byte of extra) parts.push(byte);
    const directorySize = parts.length;
    const big = span >= 0xffffffff;
    if (big) {
        u32(0x06064b50);
        u64(44);
        u16(45);
        u16(45);
        u32(0);
        u32(0);
        u64(1);
        u64(1);
        u64(directorySize);
        u64(span);
        u32(0x07064b50);
        u32(0);
        u64(span + directorySize);
        u32(1);
    }
    u32(0x06054b50);
    u16(0);
    u16(0);
    u16(big ? 0xffff : 1);
    u16(big ? 0xffff : 1);
    u32(big ? 0xffffffff : directorySize);
    u32(big ? 0xffffffff : span);
    u16(0);
    return Uint8Array.from(parts);
}

/* zip.js's errors, by message, as refusal codes; anything else is damage. */
function refusalOf(error: unknown): ZipError {
    if (error instanceof ZipError) return error;
    const message = error instanceof Error ? error.message : '';
    // A counter's refusal can come back wrapped as a stream's reason.
    const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : null;
    if (cause instanceof ZipError) return cause;
    const codes: Record<string, ZipError['code']> = {
        [ERR_INVALID_PASSWORD]: 'wrong-password',
        [ERR_ENCRYPTED]: 'password',
        [ERR_INVALID_AUTHENTICATION_CODE]: 'auth',
        [ERR_INVALID_CRC32]: 'crc',
        [ERR_INVALID_UNCOMPRESSED_SIZE]: 'size',
        [ERR_UNSUPPORTED_COMPRESSION]: 'method',
        [ERR_UNSUPPORTED_ENCRYPTION]: 'encryption',
    };
    return new ZipError(codes[message] ?? 'damaged');
}

/* The most an unlock decrypts in full to be sure of a password: more than the two-byte check AES and ZipCrypto give. */
const UNLOCK_CHECK_BYTES = 16 * 1024 * 1024;

export class ZipArchive {
    #source: Source;
    #password: string | null = null;
    #closed = false;
    #nested: Set<number>;

    private constructor(
        source: Source,
        readonly entries: ZipEntry[],
        readonly listed: Listed[],
    ) {
        this.#source = source;
        this.#nested = new Set(listed.filter((item) => item.nested).map((item) => item.index));
    }

    /* Reads the directory, with every cap and refusal of section 3, and lists it. */
    static async open(source: Source) {
        const directory = await findDirectory(source.size, source.read);
        const bytes = await source.read(directory.offset, directory.size);
        const entries = readDirectory(bytes, directory);
        return new ZipArchive(source, entries, listEntries(entries));
    }

    get hidden() {
        return hiddenCount(this.listed);
    }

    get unlocked() {
        return this.#password !== null;
    }

    /* Forgets the password; every later read fails. */
    close() {
        this.#closed = true;
        this.#password = null;
    }

    #entry(index: number) {
        if (this.#closed) throw new ZipError('damaged');
        const entry = this.entries[index];
        if (!entry) throw new ZipError('damaged');
        if (entry.directory) throw new ZipError('directory');
        if (entry.link) throw new ZipError('link');
        const support = supportOf(entry);
        if (support !== 'ok') throw new ZipError(support);
        return entry;
    }

    /* The local header read and checked against the directory: where the entry's data starts. */
    async dataStart(entry: ZipEntry) {
        const header = await this.#source.read(entry.offset, LOCAL_HEADER_READ(entry));
        return checkLocalHeader(entry, header);
    }

    /*
     * The entry's bytes through `write`, each piece counted: never past its declared size,
     * and with `ratio`, never past 200 times what was read once 1 MiB has come out. The CRC or
     * the AES authentication code is checked at the end; a caller holding the bytes shows none
     * of them until this resolves. With `checkOnly`, only the password check at the start.
     */
    async #inflate(
        entry: ZipEntry,
        options: {
            ratio: boolean;
            password: string | null;
            signal?: AbortSignal;
            write: (chunk: Uint8Array) => void | Promise<void>;
            checkOnly?: boolean;
        },
    ) {
        const start = await this.dataStart(entry);
        if (entry.lock !== 'none' && options.password === null) throw new ZipError('password');
        const counter = new InflateCounter(entry.size, options.ratio);
        let found: FileEntry;
        try {
            const entries = await new ZipReader(
                new EntryReader(this.#source, entry, start, counter),
                {
                    strictness: 'balanced',
                    filenameValidation: 'tolerant',
                } as ConstructorParameters<typeof ZipReader>[1],
            ).getEntries();
            if (entries.length !== 1 || !('getData' in entries[0]!)) throw new ZipError('damaged');
            found = entries[0] as FileEntry;
        } catch (error) {
            throw error instanceof ZipError ? error : new ZipError('damaged');
        }
        const closed = () => this.#closed;
        const writable = new WritableStream<Uint8Array>({
            async write(chunk) {
                if (closed()) throw new ZipError('damaged');
                counter.wrote(chunk.length);
                await options.write(chunk);
            },
        });
        try {
            await found.getData(writable, {
                password: options.password ?? undefined,
                checkSignature: true,
                checkCrc32: true,
                checkAuthenticationCode: true,
                checkPasswordOnly: options.checkOnly,
                signal: options.signal,
                useWebWorkers: false,
                // zip.js's own inflater, on every browser: WebKit's DecompressionStream hands back a
                // write's whole output at once, and its gzip path reports a short entry as a bad CRC.
                useCompressionStream: false,
            } as Parameters<FileEntry['getData']>[1]);
            if (!options.checkOnly) counter.finish();
        } catch (error) {
            const refusal = refusalOf(error);
            // zip.js says the size was wrong without saying which way; the counter knows.
            if (refusal.code === 'size' && counter.produced < entry.size)
                throw new ZipError('short');
            throw refusal;
        }
    }

    /*
     * For the viewer: the entry inflated (or, stored, read) whole, at most `limit` bytes declared,
     * under the ratio, checked to its end (the CRC included for a stored one). A stored entry
     * larger than the limit is read by range instead, unchecked, from `span`.
     */
    async preview(index: number, limit: number, signal?: AbortSignal) {
        const entry = this.#entry(index);
        if (this.#nested.has(index)) throw new ZipError('nested');
        if (entry.size > limit) throw new ZipError('too-large');
        const out = new Uint8Array(entry.size);
        let at = 0;
        await this.#inflate(entry, {
            ratio: true,
            password: this.#password,
            signal,
            write: (chunk) => {
                out.set(chunk, at);
                at += chunk.length;
            },
        });
        return out;
    }

    /*
     * The rules a preview meets, without its size limit, the bytes thrown away as they come:
     * what the tests hold the web and the core to (e2e/fixtures/archives/expected.json).
     */
    async check(index: number, password: string | null = this.#password) {
        const entry = this.#entry(index);
        if (this.#nested.has(index)) throw new ZipError('nested');
        await this.#inflate(entry, { ratio: true, password, write: () => {} });
    }

    /* Where a stored, unencrypted entry's bytes are in the archive, checked against its local header. */
    async span(index: number) {
        const entry = this.#entry(index);
        if (this.#nested.has(index)) throw new ZipError('nested');
        if (entry.method !== 0 || entry.lock !== 'none' || entry.packed !== entry.size)
            throw new ZipError('damaged');
        return { offset: await this.dataStart(entry), size: entry.size };
    }

    /* For a download: every piece as it comes, held to the declared size (no ratio: a large one asked first). */
    async download(
        index: number,
        write: (chunk: Uint8Array) => void | Promise<void>,
        signal?: AbortSignal,
        password: string | null = this.#password,
    ) {
        const entry = this.#entry(index);
        await this.#inflate(entry, { ratio: false, password, signal, write });
    }

    /*
     * Tries `password`, on the entry `index` first when given (an entry whose own password was
     * asked for), then on the locked entries with bytes, smallest first: in full when at most
     * 16 MiB (its CRC or authentication code then proves the password), otherwise to its password
     * check. An empty entry proves nothing (ZipCrypto's one check byte passes 1 in 256 wrong
     * passwords), so it is never the probe. A wrong password ends it; an entry that fails for
     * another reason (damage, a bomb) says nothing of the password, and the next is tried. Kept
     * only if it opens one.
     */
    async unlock(password: string, index?: number, signal?: AbortSignal) {
        const candidates = this.entries
            .filter(
                (entry) =>
                    entry.lock !== 'none' &&
                    entry.size > 0 &&
                    !entry.directory &&
                    !entry.link &&
                    supportOf(entry) === 'ok',
            )
            .sort((a, b) => a.packed - b.packed || a.index - b.index);
        const first = candidates.findIndex((entry) => entry.index === index);
        if (first > 0) candidates.unshift(...candidates.splice(first, 1));
        for (const entry of candidates) {
            if (this.#closed) return false;
            try {
                await this.#inflate(entry, {
                    ratio: true,
                    password,
                    signal,
                    write: () => {},
                    checkOnly: entry.packed > UNLOCK_CHECK_BYTES,
                });
            } catch (error) {
                const code = error instanceof ZipError ? error.code : 'damaged';
                if (code === 'wrong-password' || code === 'auth' || code === 'crc') return false;
                continue;
            }
            if (this.#closed) return false;
            this.#password = password;
            return true;
        }
        return false;
    }
}

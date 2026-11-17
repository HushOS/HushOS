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
    declaresTooMuch,
    crc32,
    supportOf,
    ZipError,
    type Folders,
    type Listed,
    type Read,
    type ZipEntry,
} from './zip-format';

/*
 * One open zip: its listing from zip-format.ts, and its entries' data through zip.js, which runs
 * inside the archive's tools worker with its own workers off (it is in one already) and its own
 * JavaScript inflater on every browser. zip.js never reads the archive's directory: each entry is
 * handed to it as an archive of its own, whose directory is written here from our listing record,
 * so the two can't read different files. A password the person typed is held here, and only here,
 * for as long as the archive is open.
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
/*
 * Zeros between the entry and the directory written for it: more than the 64 KiB + 22 bytes zip.js
 * scans from the end for an end record, so the scan never reaches the entry's data, and an end
 * record planted there (whose comment would reach the end) is never seen at all.
 */
const GAP = 65_557 + 64;

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
        this.#tail = directoryFor(entry, this.#span + GAP);
        this.size = this.#span + GAP + this.#tail.length;
        this.dataFrom = dataStart - entry.offset;
    }
    readonly dataFrom: number;

    override async init() {
        this.size = this.#span + GAP + this.#tail.length;
    }

    override async readUint8Array(index: number, length: number) {
        const end = Math.min(this.size, index + length);
        const out = new Uint8Array(Math.max(0, end - index));
        if (index < this.#span) {
            const stop = Math.min(end, this.#span);
            out.set(await this.source.read(this.entry.offset + index, stop - index), 0);
            {
                // What the inflater reads of the data: the ratio counter's input, by how far it reached.
                const reach = Math.min(stop, this.dataFrom + this.entry.packed) - this.dataFrom;
                if (reach > 0 && stop > this.dataFrom) this.counter.reached(reach);
            }
        }
        // The gap reads as the zeros `out` starts as; then the directory and end record.
        const tailStart = this.#span + GAP;
        if (end > tailStart) {
            const from = Math.max(index, tailStart);
            out.set(this.#tail.subarray(from - tailStart, end - tailStart), from - index);
        }
        return out;
    }
}

/* What zip.js is told an entry inflates to (2^52): never reached, never past a safe integer. */
const TOLD_SIZE = 2 ** 52;

/* The central directory record and end records of a one-entry archive whose local header is at 0 and whose directory starts at `span`. */
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
    // The size zip.js is told is far past any real one, so its own size check never stops a stream
    // before the counter (which holds the entry to its declared size, at the byte past it) sees
    // it; it then always ends saying the size was wrong, once its CRC or authentication code has
    // passed, and the counter says whether it was short.
    const told = { ...entry, size: TOLD_SIZE };
    const wide = true;
    const extra: number[] = [];
    if (wide) {
        extra.push(0x01, 0x00, 16, 0);
        for (const value of [told.size, entry.packed])
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
    u32(wide ? 0xffffffff : told.size);
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

/*
 * The most an unlock inflates of an entry, by what it declares, to be sure of a password: more
 * than the two-byte check AES and ZipCrypto give. An entry past it, or past the declared ratio,
 * is never inflated to probe: a 16 MiB stream of zeros can declare gigabytes.
 */
const UNLOCK_CHECK_BYTES = 16 * 1024 * 1024;
const probes = (entry: ZipEntry) => entry.size <= UNLOCK_CHECK_BYTES && !declaresTooMuch(entry);
/*
 * Whether an entry read whole proves a password: an empty ZipCrypto entry has only its one check
 * byte (it passes 1 wrong password in 256); an empty AES entry still carries its keyed code.
 */
const proves = (entry: ZipEntry) => entry.size > 0 || entry.lock === 'aes';
/* How far one try of a password goes: at most three entries and 32 MiB read, however many are locked. */
export const UNLOCK_ENTRIES_MAX = 3;
export const UNLOCK_READ_MAX = 32 * 1024 * 1024;

export class ZipArchive {
    #source: Source;
    #password: string | null = null;
    /* Whether an entry decoded whole proved the password, or only its verifier passed it (the core's Held). */
    #proven = false;
    /*
     * The password let go of on each entry it read as damaged: typed again and damaged again
     * there, it is kept and the damage is said, rather than asked for without end.
     */
    #failed = new Map<number, string>();
    #closed = false;
    #nested: Set<number>;
    /* The list's folders until the worker sends them on: nothing here reads them after. */
    #folders: Folders | null;

    private constructor(
        source: Source,
        readonly entries: ZipEntry[],
        { listed, folders }: { listed: Listed[]; folders: Folders },
    ) {
        this.#source = source;
        this.listed = listed;
        this.#folders = folders;
        this.#nested = new Set(listed.filter((item) => item.nested).map((item) => item.index));
    }

    readonly listed: Listed[];

    /* The list's folders, handed over once (an empty set after). */
    takeFolders(): Folders {
        const folders = this.#folders ?? { parents: new Uint32Array(1), names: '' };
        this.#folders = null;
        return folders;
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
        this.#failed.clear();
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
    async dataStart(entry: ZipEntry, source: Source = this.#source) {
        const header = await source.read(entry.offset, LOCAL_HEADER_READ(entry));
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
            /* Another reader of the same archive (a download's own). */
            source?: Source;
        },
    ) {
        const source = options.source ?? this.#source;
        if (source.size !== this.#source.size) throw new ZipError('damaged');
        const start = await this.dataStart(entry, source);
        if (entry.lock !== 'none' && options.password === null) throw new ZipError('password');
        // Stored and plain, the bytes are the entry: more or fewer than declared is known at once.
        if (entry.method === 0 && entry.lock === 'none' && entry.packed !== entry.size)
            throw new ZipError(entry.packed > entry.size ? 'size' : 'short');
        const counter = new InflateCounter(entry.size, options.ratio);
        let found: FileEntry;
        try {
            const entries = await new ZipReader(new EntryReader(source, entry, start, counter), {
                // The one-entry archive is ours, written from a record our parser checked: zip.js
                // judges none of it. Balanced refuses an end record it finds twice, and a name
                // may carry one (e2e/fixtures/archives, name-eocd.zip).
                strictness: 'tolerant',
                filenameValidation: 'tolerant',
            } as ConstructorParameters<typeof ZipReader>[1]).getEntries();
            if (entries.length !== 1 || !('getData' in entries[0]!)) throw new ZipError('damaged');
            found = entries[0] as FileEntry;
        } catch (error) {
            throw error instanceof ZipError ? error : new ZipError('damaged');
        }
        const closed = () => this.#closed;
        /*
         * The CRC is ours too, over what reaches the counter: zip.js would check it at the end of
         * its stream, before the last piece reaches here, and an entry one byte over would read
         * as a bad CRC rather than as too large (the core says "size"). AE-2 carries none.
         */
        const checkCrc = entry.lock !== 'aes' || entry.aes?.version === 1;
        let crc = 0;
        const writable = new WritableStream<Uint8Array>({
            async write(chunk) {
                if (closed()) throw new ZipError('damaged');
                counter.wrote(chunk.length);
                if (checkCrc) crc = crc32(chunk, crc);
                await options.write(chunk);
            },
        });
        // At the end, as the core: the authentication code (zip.js, already), the CRC, then short.
        const finish = () => {
            if (options.checkOnly) return;
            if (checkCrc && crc !== entry.crc) throw new ZipError('crc');
            counter.finish();
        };
        try {
            await found.getData(writable, {
                password: options.password ?? undefined,
                checkSignature: false,
                checkCrc32: false,
                checkAuthenticationCode: true,
                checkPasswordOnly: options.checkOnly,
                // Our parser has checked the local header against the listing; the size zip.js is told is ours to lie about.
                checkLocalDirectory: false,
                checkLocalFilename: false,
                signal: options.signal,
                useWebWorkers: false,
                // zip.js's own inflater, on every browser: WebKit's DecompressionStream hands back a
                // write's whole output at once, and its gzip path reports a short entry as a bad CRC.
                useCompressionStream: false,
            } as Parameters<FileEntry['getData']>[1]);
            // zip.js can't end without its size complaint (see TOLD_SIZE); finishing here is a stream it cut short.
            finish();
        } catch (error) {
            const refusal = refusalOf(error);
            // Told a size no stream reaches, zip.js ends every stream that passed its checks this way:
            // done, and the counter says whether it came up short.
            // (Our own refusal, the counter's, can come back wrapped as the stream's reason: never this.)
            const ours =
                error instanceof ZipError ||
                (error as { cause?: unknown } | null)?.cause instanceof ZipError;
            if (refusal.code === 'size' && !ours && counter.produced <= entry.size) return finish();
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
        if (declaresTooMuch(entry)) throw new ZipError('ratio');
        const out = new Uint8Array(entry.size);
        let at = 0;
        const used = this.#password;
        await this.#unproven(
            entry,
            used,
            () => signal?.aborted === true,
            this.#inflate(entry, {
                ratio: false,
                password: used,
                signal,
                write: (chunk) => {
                    out.set(chunk, at);
                    at += chunk.length;
                },
            }),
        );
        return out;
    }

    /*
     * A locked entry that read as damaged (its stream, size, CRC or AES code) under the held
     * password, which only its verifier passed (ZipCrypto's one byte passes 1 wrong password in
     * 256): the password is let go of and asked for again (`password-unproven`), rather than every
     * locked entry reading as damaged. The same password damaged again on the same entry is kept,
     * and the damage said: that entry can't prove it. A stop (the page's, a close, the sink's
     * failure) is no damage, and never touches the password. As the core does (Zip::unproven).
     */
    async #unproven(
        entry: ZipEntry,
        used: string | null,
        stopped: () => boolean,
        reading: Promise<void>,
    ) {
        try {
            await reading;
        } catch (error) {
            if (stopped() || this.#closed) throw error;
            const damaged =
                error instanceof ZipError &&
                ['damaged', 'size', 'short', 'crc', 'auth'].includes(error.code);
            if (
                damaged &&
                used !== null &&
                entry.lock !== 'none' &&
                !this.#proven &&
                used === this.#password &&
                this.#failed.get(entry.index) !== used
            ) {
                this.#password = null;
                this.#failed.set(entry.index, used);
                throw new ZipError('password-unproven');
            }
            throw error;
        }
    }

    /*
     * The rules a preview meets, without its size limit, the bytes thrown away as they come:
     * what the tests hold the web and the core to (e2e/fixtures/archives/expected.json).
     */
    async check(index: number, password: string | null = this.#password) {
        const entry = this.#entry(index);
        if (this.#nested.has(index)) throw new ZipError('nested');
        if (declaresTooMuch(entry)) throw new ZipError('ratio');
        await this.#inflate(entry, { ratio: false, password, write: () => {} });
    }

    /* Where a stored, unencrypted entry's bytes are in the archive, checked against its local header. */
    async span(index: number) {
        const entry = this.#entry(index);
        if (this.#nested.has(index)) throw new ZipError('nested');
        if (entry.method !== 0 || entry.lock !== 'none' || entry.packed !== entry.size)
            throw new ZipError('damaged');
        return { offset: await this.dataStart(entry), size: entry.size };
    }

    /*
     * For a download: every piece as it comes, held to the declared size (no ratio: a large one
     * asked first). `source`, when given, is the download's own reader of the archive (the page
     * serves each download over a port of its own, counted on its own).
     */
    async download(
        index: number,
        write: (chunk: Uint8Array) => void | Promise<void>,
        signal?: AbortSignal,
        password: string | null = this.#password,
        source?: Source,
    ) {
        const entry = this.#entry(index);
        // A write that failed is the download's own end (its sink), not the entry's damage. Only
        // a locked entry's password can be let go of, so only its writes are watched.
        let sinkFailed = false;
        const writing =
            entry.lock === 'none'
                ? write
                : async (chunk: Uint8Array) => {
                      try {
                          await write(chunk);
                      } catch (error) {
                          sinkFailed = true;
                          throw error;
                      }
                  };
        await this.#unproven(
            entry,
            password,
            () => sinkFailed || signal?.aborted === true,
            this.#inflate(entry, { ratio: false, password, signal, write: writing, source }),
        );
    }

    /*
     * Tries `password`, on the entry `index` first when given (the entry the password was asked
     * for), then on the locked entries with bytes: first those it may inflate in full (declaring
     * at most 16 MiB, within the declared ratio), smallest first, whose CRC or authentication code
     * then proves the password; then the rest, to their password check alone. So when no entry
     * qualifies, the password verifier alone decides (AES's two bytes; ZipCrypto's one check
     * byte, which passes 1 wrong password in 256: a download then fails its CRC). An empty
     * ZipCrypto entry proves nothing (its one check byte is all there is), so it comes last, to
     * that check alone, unless it is the entry asked for; an empty AES entry's
     * authentication code does prove it. A wrong password ends it; an entry that fails for
     * another reason (damage, tampering: a bad authentication code or CRC) says nothing certain
     * of the password, and the next is tried, at most three entries and 32 MiB read in all; past
     * that a try reads only an entry's password check. Kept only if an entry opens with it;
     * the password already held, accepted again, stays as proven as it was.
     */
    async unlock(password: string, index?: number, signal?: AbortSignal) {
        const candidates = this.entries
            .filter(
                (entry) =>
                    entry.lock !== 'none' &&
                    !entry.directory &&
                    !entry.link &&
                    supportOf(entry) === 'ok',
            )
            .sort(
                (a, b) =>
                    Number(proves(b)) - Number(proves(a)) ||
                    Number(probes(b)) - Number(probes(a)) ||
                    a.packed - b.packed ||
                    a.index - b.index,
            );
        const first = candidates.findIndex((entry) => entry.index === index);
        if (first > 0) candidates.unshift(...candidates.splice(first, 1));
        let read = 0;
        for (const entry of candidates.slice(0, UNLOCK_ENTRIES_MAX)) {
            if (this.#closed) return false;
            const checkOnly =
                !proves(entry) || !probes(entry) || read + entry.packed > UNLOCK_READ_MAX;
            read += checkOnly ? 0 : entry.packed;
            try {
                await this.#inflate(entry, {
                    ratio: false,
                    password,
                    signal,
                    write: () => {},
                    checkOnly,
                });
            } catch (error) {
                const code = error instanceof ZipError ? error.code : 'damaged';
                if (code === 'wrong-password') return false;
                continue;
            }
            if (this.#closed) return false;
            this.#proven = (password === this.#password && this.#proven) || !checkOnly;
            this.#password = password;
            return true;
        }
        return false;
    }
}

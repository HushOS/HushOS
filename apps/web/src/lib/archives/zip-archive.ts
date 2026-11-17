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
    type Entry,
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

configure({ useWebWorkers: false });

export type Source = { size: number; read: Read };

/* Bytes read inside an entry's data, while it is being inflated: the ratio counter's input. */
type Tally = { start: number; end: number; counter: InflateCounter };

class SourceReader extends Reader<Source> {
    constructor(
        private source: Source,
        private tallies: Set<Tally>,
    ) {
        super(source);
        this.size = source.size;
    }

    override async init() {
        this.size = this.source.size;
    }

    override async readUint8Array(index: number, length: number) {
        const bytes = await this.source.read(index, length);
        const end = index + bytes.length;
        for (const tally of this.tallies) {
            const overlap = Math.min(end, tally.end) - Math.max(index, tally.start);
            if (overlap > 0) tally.counter.read(overlap);
        }
        return bytes;
    }
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
    #tallies = new Set<Tally>();
    #engine: Promise<Entry[]> | null = null;
    #password: string | null = null;
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

    /* Forgets the password, and zip.js's entries with it. */
    close() {
        this.#password = null;
        this.#engine = null;
        this.#tallies.clear();
    }

    #entry(index: number) {
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

    /* zip.js's view of the entry, which must be ours. */
    async #engineEntry(entry: ZipEntry) {
        this.#engine ??= new ZipReader(new SourceReader(this.#source, this.#tallies), {
            strictness: 'balanced',
            filenameValidation: 'tolerant',
        } as ConstructorParameters<typeof ZipReader>[1])
            .getEntries()
            .catch((error: unknown) => {
                this.#engine = null;
                throw error;
            });
        let found: Entry | undefined;
        try {
            found = (await this.#engine)[entry.index];
        } catch {
            throw new ZipError('damaged');
        }
        if (
            !found ||
            found.offset !== entry.offset ||
            found.compressedSize !== entry.packed ||
            found.uncompressedSize !== entry.size ||
            found.encrypted !== (entry.lock !== 'none') ||
            (entry.lock !== 'aes' && found.compressionMethod !== entry.method) ||
            found.rawFilename.length !== entry.raw.length ||
            found.rawFilename.some((byte, i) => byte !== entry.raw[i]) ||
            !('getData' in found)
        )
            throw new ZipError('damaged');
        return found as FileEntry;
    }

    /*
     * The entry's bytes through `write`, each piece counted: never past its declared size,
     * and with `ratio`, never past 200 times what was read once 1 MiB has come out. The CRC or
     * the AES authentication code is checked at the end; a caller holding the bytes shows none
     * of them until this resolves.
     */
    async #inflate(
        entry: ZipEntry,
        options: {
            ratio: boolean;
            password: string | null;
            signal?: AbortSignal;
            write: (chunk: Uint8Array) => void | Promise<void>;
        },
    ) {
        const start = await this.dataStart(entry);
        const found = await this.#engineEntry(entry);
        if (entry.lock !== 'none' && options.password === null) throw new ZipError('password');
        const counter = new InflateCounter(entry.size, options.ratio);
        const tally: Tally = { start, end: start + entry.packed, counter };
        this.#tallies.add(tally);
        const writable = new WritableStream<Uint8Array>({
            async write(chunk) {
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
                signal: options.signal,
                useWebWorkers: false,
            } as Parameters<FileEntry['getData']>[1]);
            counter.finish();
        } catch (error) {
            throw refusalOf(error);
        } finally {
            this.#tallies.delete(tally);
        }
    }

    /*
     * For the viewer: the entry inflated whole, at most `limit` bytes declared, under the ratio,
     * checked to its end. An entry stored without compression or encryption is not read here:
     * the page reads it by range at any size, from `span`.
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
     * Tries `password` on the smallest encrypted entry that can be read: in full when it is at
     * most 16 MiB (its CRC or authentication code then proves the password), otherwise to its
     * password check. Kept only if it opens.
     */
    async unlock(password: string, signal?: AbortSignal) {
        const locked = this.entries
            .filter(
                (entry) =>
                    entry.lock !== 'none' &&
                    !entry.directory &&
                    !entry.link &&
                    supportOf(entry) === 'ok',
            )
            .sort((a, b) => a.packed - b.packed)[0];
        if (!locked) return false;
        try {
            if (locked.packed <= UNLOCK_CHECK_BYTES)
                await this.#inflate(locked, { ratio: true, password, signal, write: () => {} });
            else {
                await this.dataStart(locked);
                const found = await this.#engineEntry(locked);
                await found.getData(new WritableStream(), {
                    password,
                    checkPasswordOnly: true,
                    useWebWorkers: false,
                    signal,
                } as Parameters<FileEntry['getData']>[1]);
            }
        } catch (error) {
            const refusal = refusalOf(error);
            if (
                refusal.code === 'wrong-password' ||
                refusal.code === 'auth' ||
                refusal.code === 'crc'
            )
                return false;
            // Any other refusal (damage, a bomb) says nothing of the password: it is not kept.
            if (refusal.code === 'damaged' || refusal.code === 'size' || refusal.code === 'ratio')
                return false;
            throw refusal;
        }
        this.#password = password;
        return true;
    }
}

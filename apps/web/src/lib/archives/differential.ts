import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { ZipArchive } from './zip-archive';
import { entryRefusalWords } from './words';
import { ZipError } from './zip-format';

/*
 * The web's archive reader against the core's, on the same bytes: what each lists (every field
 * the apps read, each entry's recorded method and CRC, the folders), what previewing and
 * downloading each entry meets and the SHA-256 of what it hands back, and what the shared password
 * unlocks and the content of each locked entry under it, previewed and downloaded. The core's side is the `archive` verdict
 * of crates/hushos-core/fuzz (targets.rs), served by its `verdicts` example; the cargo-fuzz target
 * `archive` fuzzes that verdict alone, with every invariant asserted.
 *
 *     bun apps/web/src/lib/archives/differential.ts [--time <seconds>] [--seed <n>] [--invert]
 *
 * Inputs: every committed fixture of e2e/fixtures/archives, the cargo-fuzz corpus
 * (crates/hushos-core/fuzz/corpus/archive, when there is one), then edits of the fixtures (bytes
 * flipped, fields set to edge values, cut short, spliced) until the time is up. `--invert` is the
 * runner's own check: every byte the web hands back is inverted, and the run must fail.
 *
 * One thing is compared by what a person sees rather than by its code: an entry's refusal, by its
 * words (entryRefusalWords). The integrity codes (`damaged`, `size`, `short`, `crc`, `auth`)
 * share one sentence on every client, because they can't be aligned: on the same damaged bytes the
 * core's decoders (zlib-rs, the deflate64 crate) and zip.js's notice the damage at different
 * points, in both directions (one hands back more before it stops, or accepts a Deflate64 stream
 * the other calls invalid), and whether an AES entry's code is checked before its stream breaks
 * follows zip.js's stream timing. Making the core copy that timing was tried and only moved the
 * differences. Everything else must match exactly: whether an entry opens at all, the bytes it
 * opens to, every listed field, the listing's refusals, the password's outcomes, and every other
 * refusal.
 *
 * A divergence, a core panic or a web error outside the refusals is written to
 * crates/hushos-core/fuzz/artifacts/archive-diff/<hash>.zip and counted. Exits 1 if any.
 */

const root = join(import.meta.dirname, '../../../../..');
const fixtures = join(root, 'e2e/fixtures/archives');
const corpus = join(root, 'crates/hushos-core/fuzz/corpus/archive');
const artifacts = join(root, 'crates/hushos-core/fuzz/artifacts/archive-diff');
const binary = join(root, 'crates/hushos-core/fuzz/target/release/examples/verdicts');
const PASSWORD = 'correct horse battery';
/* A password past ASCII (a 4-byte character in it), tried after: its UTF-8 bytes key both ciphers. */
const OTHER_PASSWORD = 'café 🔑';
// The core's archive verdict: at most 32 entries previewed, each within 1 MiB, and downloaded up to 4 MiB.
const PREVIEWS = 32;
const PREVIEW_LIMIT = 1 << 20;
const DOWNLOAD_MAX = 4 << 20;

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
    const at = args.indexOf(name);
    return at >= 0 ? Number(args[at + 1]) : fallback;
};
const seconds = option('--time', 60);
let seed = option('--seed', Date.now() % 2 ** 31) >>> 0;
// A self-check: every byte the web hands back is inverted, and the run must find it.
const invert = args.includes('--invert');

/* What the web hands back, made wrong on purpose with --invert: the runner must then fail. */
const handBack = (bytes: Uint8Array) => (invert ? bytes.map((byte) => byte ^ 0xff) : bytes);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(handBack(bytes)).digest('hex');

/* The web's verdict: the same JSON as the core's `archive` verdict. */
async function web(bytes: Uint8Array) {
    const code = (error: unknown) =>
        error instanceof ZipError
            ? error.code
            : `failed: ${error instanceof Error ? error.message : typeof error}`;
    let archive: ZipArchive;
    try {
        archive = await ZipArchive.open({
            size: bytes.length,
            read: async (offset, length) => bytes.slice(offset, offset + length),
        });
    } catch (error) {
        return { ok: true, out: { listing: code(error) } };
    }
    const { parents, names } = archive.takeFolders();
    const split = names.split('/');
    split.pop();
    const at = (folder: number) => {
        const parts: string[] = [];
        for (let node = folder; node !== 0; node = parents[node]!) parts.unshift(split[node - 1]!);
        return parts.join('/');
    };
    const preview = async (index: number) => {
        try {
            return { code: 'ok', sha256: sha256(await archive.preview(index, PREVIEW_LIMIT)) };
        } catch (error) {
            return { code: code(error) };
        }
    };
    const download = async (index: number, size: number) => {
        const hash = createHash('sha256');
        let count = 0;
        try {
            await archive.download(index, (chunk) => {
                hash.update(handBack(chunk));
                count += chunk.length;
            });
            if (count !== size) return { code: `failed: ${count} bytes of ${size}` };
            return { code: 'ok', sha256: hash.digest('hex') };
        } catch (error) {
            if (count > size) return { code: `failed: ${count} bytes of ${size}` };
            return { code: code(error) };
        }
    };
    const entries = [];
    for (const [n, item] of archive.listed.entries()) {
        const record = archive.entries[item.index]!;
        const out: Record<string, unknown> = {
            index: item.index,
            path: item.path,
            at: at(item.folder),
            name: item.name,
            directory: item.directory,
            hidden: item.hidden,
            lock: item.lock,
            support: item.support,
            size: item.size,
            packed: item.packed,
            method: record.lock === 'aes' ? (record.aes?.method ?? 0xffff) : record.method,
            crc: record.crc,
            stored: item.stored,
            link: item.link,
            nested: item.nested,
            dos: item.dos,
            mtime: item.mtime,
            saveName: item.saveName,
        };
        if (n < PREVIEWS && !item.directory) {
            out.preview = await preview(item.index);
            if (item.size <= DOWNLOAD_MAX) out.download = await download(item.index, item.size);
        }
        entries.push(out);
    }
    let unlock: unknown;
    try {
        unlock = await archive.unlock(PASSWORD);
    } catch (error) {
        unlock = code(error);
    }
    // Each locked entry previewed, then downloaded (to 4 MiB), under the password: where a
    // password only its verifier passed is let go of, and asked for again.
    const unlocked = [];
    if (unlock === true)
        for (const item of archive.listed.slice(0, PREVIEWS))
            if (item.lock !== 'none' && !item.directory) {
                const after: Record<string, unknown> = { preview: await preview(item.index) };
                if (item.size <= DOWNLOAD_MAX)
                    after.download = await download(item.index, item.size);
                unlocked.push(after);
            }
    // Then the password past ASCII, and each locked entry previewed under it.
    let unlockOther: unknown;
    try {
        unlockOther = await archive.unlock(OTHER_PASSWORD);
    } catch (error) {
        unlockOther = code(error);
    }
    const unlockedOther = [];
    if (unlockOther === true)
        for (const item of archive.listed.slice(0, PREVIEWS))
            if (item.lock !== 'none' && !item.directory)
                unlockedOther.push(await preview(item.index));
    return {
        ok: true,
        out: {
            listing: 'ok',
            hidden: archive.hidden,
            entries,
            unlock,
            unlocked,
            unlockOther,
            unlockedOther,
        },
    };
}

/* The core's verdict, from one `verdicts` process for the whole run. */
if (!existsSync(binary))
    throw new Error(
        'Build the core verdicts first: cargo build --release --manifest-path crates/hushos-core/fuzz/Cargo.toml --example verdicts',
    );
const core = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting: { resolve: (reply: unknown) => void; reject: (error: Error) => void }[] = [];
createInterface({ input: core.stdout }).on('line', (line) =>
    waiting.shift()?.resolve(JSON.parse(line)),
);
/*
 * The core gone mid-run (it exited, crashed past its panic guard, or a pipe broke): every input
 * waiting on it fails, so compare saves the one that did it, and the run ends non-zero.
 */
let coreGone: Error | null = null;
function lose(error: Error) {
    coreGone ??= error;
    for (const waiter of waiting.splice(0)) waiter.reject(coreGone);
}
core.on('exit', (code, signal) => lose(new Error(`the core exited (${signal ?? code}) mid-run`)));
core.on('error', lose);
core.stdin.on('error', lose);
core.stdout.on('error', lose);
const rust = (data: Uint8Array) =>
    new Promise<unknown>((resolve, reject) => {
        if (coreGone) return reject(coreGone);
        waiting.push({ resolve, reject });
        core.stdin.write(
            `${JSON.stringify({ target: 'archive', data: Buffer.from(data).toString('base64url') })}\n`,
        );
    });

/* A small seeded generator, so a run can be repeated with its --seed. */
function random() {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
}
const below = (n: number) => Math.floor(random() * n);
const EDGES = [0, 1, 0x7f, 0x80, 0xff, 0xfffe, 0xffff, 0x10000, 0x7fffffff, 0xffffffff];

/* One edit of a fixture: bytes flipped, a field set to an edge value, cut short, or spliced. */
function edit(seeds: Uint8Array[]) {
    const out = new Uint8Array(seeds[below(seeds.length)]!);
    if (out.length === 0) return out;
    const view = new DataView(out.buffer);
    for (let edits = 1 + below(4); edits > 0; edits--) {
        const at = below(out.length);
        switch (below(6)) {
            case 0:
                out[at] = below(256);
                break;
            case 1:
                out[at]! ^= 1 << below(8);
                break;
            case 2:
                if (at + 2 <= out.length)
                    view.setUint16(at, EDGES[below(EDGES.length)]! & 0xffff, true);
                break;
            case 3:
                if (at + 4 <= out.length)
                    view.setUint32(at, EDGES[below(EDGES.length)]! >>> 0, true);
                break;
            case 4:
                return out.subarray(0, at);
            case 5: {
                const other = seeds[below(seeds.length)]!;
                const from = below(other.length);
                const length = Math.min(below(256), other.length - from, out.length - at);
                out.set(other.subarray(from, from + length), at);
                break;
            }
        }
    }
    return out;
}

const read = (dir: string) =>
    existsSync(dir)
        ? readdirSync(dir)
              .filter((name) => !name.startsWith('.'))
              .map((name) => new Uint8Array(readFileSync(join(dir, name))))
        : [];
const seeds = readdirSync(fixtures)
    .filter((name) => name.endsWith('.zip'))
    .map((name) => new Uint8Array(readFileSync(join(fixtures, name))));
const replayed = read(corpus);

/* A verdict as a person reads it: each entry's outcome by its words. */
const judged = (verdict: unknown) =>
    JSON.parse(JSON.stringify(verdict), (key, value: unknown) =>
        key === 'code' && typeof value === 'string' ? (entryRefusalWords[value] ?? value) : value,
    ) as unknown;

let compared = 0;
let found = 0;
async function compare(bytes: Uint8Array) {
    let ours: unknown;
    let theirs: unknown;
    try {
        [ours, theirs] = await Promise.all([web(bytes), rust(bytes)]);
    } catch (error) {
        // The core went while this input was with it: the input is kept, and the run fails now.
        mkdirSync(artifacts, { recursive: true });
        const name = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
        writeFileSync(join(artifacts, `${name}.zip`), bytes);
        console.log(
            `core lost on ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exit(1);
    }
    compared++;
    const theirsPanicked = typeof theirs === 'object' && theirs !== null && 'panic' in theirs;
    const oursFailed = JSON.stringify(ours).includes('"failed: ');
    if (!theirsPanicked && !oursFailed && isDeepStrictEqual(judged(ours), judged(theirs))) return;
    found++;
    mkdirSync(artifacts, { recursive: true });
    const name = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
    writeFileSync(join(artifacts, `${name}.zip`), bytes);
    writeFileSync(
        join(artifacts, `${name}.json`),
        JSON.stringify({ web: ours, core: theirs }, null, 1),
    );
    console.log(
        `divergence ${name}: ${theirsPanicked ? 'core panic' : oursFailed ? 'web error' : 'outcomes differ'}`,
    );
}

const started = Date.now();
console.log(
    `seed ${seed}: ${seeds.length} fixtures, ${replayed.length} corpus inputs, then edits for ${seconds} s`,
);
for (const bytes of [...seeds, ...replayed]) await compare(bytes);
while (Date.now() - started < seconds * 1000) await compare(edit(seeds));
core.stdin.end();
console.log(`${compared} inputs compared, ${found} divergences`);
process.exit(found ? 1 : 0);

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { ZipArchive } from './zip-archive';
import { ZipError } from './zip-format';

/*
 * The web's archive reader against the core's, on the same bytes: what each lists (every entry's
 * path, folder, name and what it is, the folders included), what previewing each entry meets, and
 * what the shared password unlocks. The core's side is the `archive` verdict of
 * crates/hushos-core/fuzz (targets.rs), served by its `verdicts` example; the cargo-fuzz target
 * `archive` fuzzes that verdict alone, with every invariant asserted.
 *
 *     bun apps/web/src/lib/archives/differential.ts [--time <seconds>] [--seed <n>]
 *
 * Inputs: every committed fixture of e2e/fixtures/archives, the cargo-fuzz corpus
 * (crates/hushos-core/fuzz/corpus/archive, when there is one), then edits of the fixtures (bytes
 * flipped, fields set to edge values, cut short, spliced) until the time is up.
 *
 * Refusals of damaged data are compared as one: `damaged`, `size`, `short`, `crc` and `auth`. Which
 * check notices a damaged stream first depends on the inflater (zlib-rs and the deflate64 crate
 * hand back what they decoded before they notice; zip.js's inflaters fail the whole piece; an AES
 * entry's code may be checked before or after its stream breaks), and the first runs found only
 * such pairs. Everything else must match exactly: whether an entry opens at all, the listing's
 * refusals, every path, folder and name, the password's outcomes, and the ratio, method,
 * encryption, nested and too-large refusals.
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
// The core's archive verdict: at most 32 entries previewed, each within 1 MiB.
const PREVIEWS = 32;
const PREVIEW_LIMIT = 1 << 20;

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
    const at = args.indexOf(name);
    return at >= 0 ? Number(args[at + 1]) : fallback;
};
const seconds = option('--time', 60);
let seed = option('--seed', Date.now() % 2 ** 31) >>> 0;

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
            await archive.preview(index, PREVIEW_LIMIT);
            return 'ok';
        } catch (error) {
            return code(error);
        }
    };
    const entries = [];
    for (const [n, item] of archive.listed.entries()) {
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
            saveName: item.saveName,
        };
        if (n < PREVIEWS && !item.directory) out.preview = await preview(item.index);
        entries.push(out);
    }
    let unlock: unknown;
    try {
        unlock = await archive.unlock(PASSWORD);
    } catch (error) {
        unlock = code(error);
    }
    const unlocked = [];
    if (unlock === true)
        for (const item of archive.listed.slice(0, PREVIEWS))
            if (item.lock !== 'none' && !item.directory) unlocked.push(await preview(item.index));
    return {
        ok: true,
        out: { listing: 'ok', hidden: archive.hidden, entries, unlock, unlocked },
    };
}

/* The core's verdict, from one `verdicts` process for the whole run. */
if (!existsSync(binary))
    throw new Error(
        'Build the core verdicts first: cargo build --release --manifest-path crates/hushos-core/fuzz/Cargo.toml --example verdicts',
    );
const core = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting: ((reply: unknown) => void)[] = [];
createInterface({ input: core.stdout }).on('line', (line) => waiting.shift()?.(JSON.parse(line)));
const rust = (data: Uint8Array) =>
    new Promise<unknown>((resolve) => {
        waiting.push(resolve);
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

const DAMAGE = new Set(['damaged', 'size', 'short', 'crc', 'auth']);
const judged = (verdict: unknown) =>
    JSON.parse(JSON.stringify(verdict), (key, value: unknown) =>
        (key === 'preview' || /^\d+$/.test(key)) && typeof value === 'string' && DAMAGE.has(value)
            ? 'damage'
            : value,
    ) as unknown;

let compared = 0;
let found = 0;
async function compare(bytes: Uint8Array) {
    const [ours, theirs] = await Promise.all([web(bytes), rust(bytes)]);
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

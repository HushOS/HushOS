import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inputs } from './arbitraries';
import { repository } from './fixtures';
import { acceptDocument, rosterDocument } from './jazzer';
import { documents } from './seeds';
import { TARGETS, verdict, type Target } from './verdicts';

/*
 * The same input to both twins gives the same verdict: accepted with the same
 * output (statement bytes, parsed fields, opened keys, the full acceptance
 * verdict), or refused by both. Refusal reasons are not compared: the core's
 * errors (Input, Sealed) and the web's CryptoError messages were never meant
 * to match word for word. The Rust side is
 * crates/hushos-core/fuzz/examples/verdicts.rs, one process serving every
 * request over stdin; `bun run fuzz:diff` builds it first.
 *
 * Inputs: every target's seed documents, fast-check edits of them
 * (arbitraries.ts), and whatever the fuzzers' corpora hold
 * (crates/hushos-core/fuzz/corpus, packages/crypto/fuzz/corpus), so a run
 * after fuzzing replays what each fuzzer found in the other twin. A
 * divergence is written to packages/crypto/fuzz/artifacts/diff-<target>-<hash>.
 */

const root = repository();
const binary = join(root, 'crates/hushos-core/fuzz/target/release/examples/verdicts');
const RUNS = Number(process.env.FUZZ_DIFF_RUNS ?? 150);
const CORPUS_LIMIT = Number(process.env.FUZZ_DIFF_CORPUS ?? 300);
/*
 * The least share of generated edits both twins must compare (neither skips
 * it as misshapen): below it the property passes on inputs nobody judged. The
 * edits keep each field's type most of the time (arbitraries.ts), so every
 * target clears half; the open targets never skip.
 */
const COMPARED_FLOOR = 0.5;
/* Acceptance verifies whole histories on both sides, and noble's ML-DSA is slow: fewer runs. */
const SLOW: Partial<Record<Target, number>> = { accept: 0.2, identity: 0.5, succession: 0.5 };

type Reply = Record<string, unknown>;
let core: ChildProcessWithoutNullStreams;
const waiting: { resolve: (reply: Reply) => void; reject: (error: Error) => void }[] = [];
let gone: Error | undefined;

beforeAll(() => {
    if (!existsSync(binary))
        throw new Error(
            'Build the core verdicts first: cargo build --release --manifest-path crates/hushos-core/fuzz/Cargo.toml --example verdicts (bun run fuzz:diff does).',
        );
    core = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    createInterface({ input: core.stdout }).on('line', (line) =>
        waiting.shift()?.resolve(JSON.parse(line) as Reply),
    );
    // A core that dies (an abort, a kill) fails every request still waiting, and every one after.
    const fail = (why: string) => {
        gone = new Error(`The core's verdicts process ${why}.`);
        for (const pending of waiting.splice(0)) pending.reject(gone);
    };
    core.on('exit', (code, signal) => fail(`exited (${signal ?? code})`));
    core.on('error', (error) => fail(`failed: ${error.message}`));
});

afterAll(() => core?.kill());

function rust(target: string, data: Uint8Array) {
    return new Promise<Reply>((resolve, reject) => {
        if (gone) return reject(gone);
        waiting.push({ resolve, reject });
        core.stdin.write(
            `${JSON.stringify({ target, data: Buffer.from(data).toString('base64url') })}\n`,
        );
    });
}

/* JSON's view of a verdict: what both twins can say, without undefined fields. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

function keep(target: Target, data: Uint8Array) {
    const dir = join(root, 'packages/crypto/fuzz/artifacts');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `diff-${target}-${createHash('sha1').update(data).digest('hex')}`);
    writeFileSync(file, data);
    return file;
}

/* Both verdicts on one input; a mismatch (or a finding in either twin) throws. */
async function same(target: Target, data: Uint8Array) {
    const theirs = await rust(target, data);
    if ('panic' in theirs || 'error' in theirs)
        throw new Error(`core ${target}: ${JSON.stringify(theirs)}`);
    let ours: unknown;
    try {
        ours = plain(await verdict(target, data));
    } catch (error) {
        throw new Error(`web ${target}: ${String(error)}`, { cause: error });
    }
    if ('skip' in theirs && (ours as Reply).skip) return 'skipped';
    if (!isDeepStrictEqual(ours, theirs))
        throw new Error(
            `${target} diverges:\n  web:  ${JSON.stringify(ours).slice(0, 600)}\n  core: ${JSON.stringify(theirs).slice(0, 600)}`,
        );
    return 'compared';
}

/* `same`, keeping the input on disk when it fails. */
async function kept(target: Target, data: Uint8Array) {
    try {
        return await same(target, data);
    } catch (error) {
        throw new Error(`${(error as Error).message}\n  input: ${keep(target, data)}`, {
            cause: error,
        });
    }
}

/*
 * A fuzzer corpus's files for `target`, newest first (what the last run found
 * comes first under the cap), as documents: structured bytes become the
 * history or roster they build, by the engine that made them.
 */
async function corpus(target: Target) {
    const out: Uint8Array[] = [];
    for (const [dir, engine] of [
        ['crates/hushos-core/fuzz/corpus', 'rust'],
        ['packages/crypto/fuzz/corpus', 'js'],
    ] as const) {
        const path = join(root, dir, target);
        if (!existsSync(path)) continue;
        const files = readdirSync(path)
            .map((name) => ({ name, at: statSync(join(path, name)).mtimeMs }))
            .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
            .slice(0, CORPUS_LIMIT);
        for (const { name } of files) {
            const bytes = new Uint8Array(readFileSync(join(path, name)));
            if (target !== 'accept' && target !== 'roster_build') out.push(bytes);
            else if (engine === 'js')
                out.push(
                    (target === 'accept' ? acceptDocument : rosterDocument)(Buffer.from(bytes)),
                );
            else {
                // The core's structured bytes, turned into the history or roster they stand for.
                const reply = await rust(
                    target === 'accept' ? 'accept-history' : 'roster-document',
                    bytes,
                );
                if (reply.input) out.push(new TextEncoder().encode(JSON.stringify(reply.input)));
            }
        }
    }
    return out;
}

describe('the TypeScript and Rust twins agree', () => {
    for (const target of TARGETS) {
        describe(target, () => {
            it('on the seed documents, every one of them compared', async () => {
                for (const data of documents(target))
                    expect(await kept(target, data), 'a seed both twins skip').toBe('compared');
            }, 300_000);

            it('on edits of them, comparing at least half', async () => {
                const tally = { compared: 0, skipped: 0 };
                const result = await fc.check(
                    fc.asyncProperty(inputs(target), async ({ data }) => {
                        tally[await same(target, data)]++;
                    }),
                    { numRuns: Math.max(10, Math.round(RUNS * (SLOW[target] ?? 1))) },
                );
                // Only the shrunk counterexample is kept, not every input tried while shrinking.
                if (result.failed && result.counterexample)
                    await kept(target, result.counterexample[0].data);
                expect(result.failed, fc.defaultReportMessage(result) ?? '').toBe(false);
                const share = tally.compared / (tally.compared + tally.skipped);
                expect(
                    share,
                    `${target}: ${tally.compared} compared, ${tally.skipped} skipped`,
                ).toBeGreaterThanOrEqual(COMPARED_FLOOR);
            }, 600_000);

            it('on what the fuzzers found', async () => {
                for (const data of await corpus(target)) await kept(target, data);
            }, 600_000);
        });
    }
});

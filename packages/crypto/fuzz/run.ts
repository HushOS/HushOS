import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { freemem, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { repository } from './fixtures';
import { writeSeeds } from './seeds';
import { TARGETS, type Target } from './verdicts';

/*
 * Runs the fuzzers, one process at a time:
 *
 *     bun run fuzz [rust|js|all] [target|all] [--time <seconds>] [--merge]
 *
 * Rust targets run under cargo-fuzz (the nightly pinned in
 * crates/hushos-core/fuzz/rust-toolchain.toml, `-jobs=1 -workers=1`,
 * CARGO_BUILD_JOBS=8); the TypeScript ones under Jazzer.js on Node, from an
 * esbuild bundle of jazzer.ts (under Bun, Jazzer.js starts but its
 * instrumentation never loads, so it would fuzz blind). Every run is capped
 * by -max_total_time (120 s locally, more only with CI set) and
 * -rss_limit_mb=2048, and waits for the machine to have memory to spare.
 * Seeds come from the shared fixtures (seeds.ts); crashes land in
 * crates/hushos-core/fuzz/artifacts/<target> and packages/crypto/fuzz/artifacts/<target>.
 * With --merge it fuzzes nothing and minimises the corpora instead
 * (`-merge=1`: the fewest inputs with the same coverage), as CI does before
 * it caches them.
 */

const root = repository();
const args = process.argv.slice(2);
const option = (name: string) => {
    const at = args.indexOf(name);
    return at >= 0 ? args.splice(at, 2)[1] : undefined;
};
const merge = args.includes('--merge');
if (merge) args.splice(args.indexOf('--merge'), 1);
const seconds = Number(option('--time') ?? 60);
const cap = process.env.CI ? 3600 : 120;
if (!Number.isInteger(seconds) || seconds < 1 || seconds > cap)
    throw new Error(`--time is 1 to ${cap} seconds${process.env.CI ? '' : ' locally'}.`);
const [engine = 'all', which = 'all'] = args;
if (!['rust', 'js', 'all'].includes(engine)) throw new Error('The engine is rust, js or all.');
if (which !== 'all' && !TARGETS.includes(which as Target))
    throw new Error(`The target is one of ${TARGETS.join(', ')} or all.`);
const targets = which === 'all' ? [...TARGETS] : [which as Target];

/* The largest input each target reads: open targets take whole envelopes, JSON targets whole links. */
const MAX_LEN: Record<Target, number> = {
    canonical: 16384,
    roster: 16384,
    group_succession: 16384,
    roster_build: 4096,
    statements: 16384,
    identity: 32768,
    succession: 65536,
    share_open: 8192,
    key_seal_open: 8192,
    area_grant_open: 8192,
    key_seal_context: 8192,
    pins: 8192,
    accept: 4096,
};

/* Waits (up to two minutes) until at least a fifth of memory is free: a heavy run beside another once took the machine down. */
function waitForMemory() {
    // A CI runner runs one job at a time; the rule is for a workstation shared with other work.
    if (process.env.CI) return;
    for (let tries = 0; tries < 24; tries++) {
        const free =
            platform() === 'darwin'
                ? Number(
                      /free percentage: (\d+)%/.exec(
                          spawnSync('memory_pressure', { encoding: 'utf8' }).stdout ?? '',
                      )?.[1] ?? 100,
                  )
                : (freemem() / totalmem()) * 100;
        if (free >= 20) return;
        console.log(`Only ${Math.round(free)}% of memory is free; waiting.`);
        spawnSync('sleep', ['5']);
    }
    throw new Error('Memory stayed short for two minutes; not starting another fuzzer.');
}

function run(command: string, argv: string[], cwd: string, env: Record<string, string> = {}) {
    waitForMemory();
    console.log(`\n$ ${command} ${argv.join(' ')}`);
    return spawnSync(command, argv, {
        cwd,
        stdio: 'inherit',
        env: { ...process.env, ...env },
    }).status;
}

const libFuzzer = (target: Target, artifacts: string) => [
    `-max_total_time=${seconds}`,
    '-rss_limit_mb=2048',
    `-max_len=${MAX_LEN[target]}`,
    '-timeout=30',
    '-print_final_stats=1',
    `-artifact_prefix=${artifacts}/`,
];

function rust(target: Target) {
    const fuzz = join(root, 'crates/hushos-core/fuzz');
    const artifacts = join(fuzz, 'artifacts', target);
    mkdirSync(artifacts, { recursive: true });
    const status = run(
        'cargo',
        merge
            ? [
                  'fuzz',
                  'cmin',
                  '--fuzz-dir',
                  '.',
                  target,
                  join(fuzz, 'corpus', target),
                  '--',
                  '-rss_limit_mb=2048',
                  `-max_len=${MAX_LEN[target]}`,
              ]
            : [
                  'fuzz',
                  'run',
                  '--fuzz-dir',
                  '.',
                  target,
                  join(fuzz, 'corpus', target),
                  '--',
                  '-jobs=1',
                  '-workers=1',
                  ...libFuzzer(target, artifacts),
              ],
        fuzz,
        { CARGO_BUILD_JOBS: '8' },
    );
    // With -jobs, libFuzzer also writes the run's output (already shown) to fuzz-0.log.
    rmSync(join(fuzz, 'fuzz-0.log'), { force: true });
    return status;
}

let bundled: string | undefined;
async function bundle() {
    if (bundled) return bundled;
    const outfile = join(root, 'packages/crypto/fuzz/.build/jazzer.cjs');
    await build({
        entryPoints: [join(root, 'packages/crypto/fuzz/jazzer.ts')],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        // Libraries stay outside the bundle, so Jazzer.js instruments HushOS's code only.
        packages: 'external',
        sourcemap: 'inline',
        logLevel: 'warning',
    });
    return (bundled = outfile);
}

async function js(target: Target) {
    const crypto = join(root, 'packages/crypto');
    const artifacts = join(crypto, 'fuzz/artifacts', target);
    const corpus = join(crypto, 'fuzz/corpus', target);
    mkdirSync(artifacts, { recursive: true });
    const jazzer = (dirs: string[], flags: string[]) =>
        run(
            'node',
            [
                join(crypto, 'node_modules/@jazzer.js/core/dist/cli.js'),
                bundled!,
                ...dirs,
                '-f',
                target,
                '--disable_bug_detectors=.*',
                '--timeout=30000',
                '--',
                ...flags,
            ],
            crypto,
        );
    await bundle();
    if (!merge) return jazzer([corpus], libFuzzer(target, artifacts));
    // -merge=1 copies into the first directory the fewest inputs that keep the others' coverage.
    const smaller = `${corpus}.merged`;
    rmSync(smaller, { recursive: true, force: true });
    mkdirSync(smaller);
    const status = jazzer(
        [smaller, corpus],
        ['-merge=1', '-rss_limit_mb=2048', `-max_len=${MAX_LEN[target]}`],
    );
    if (status === 0) {
        rmSync(corpus, { recursive: true });
        renameSync(smaller, corpus);
    }
    return status;
}

const failed: string[] = [];
for (const target of targets) {
    // Seeds are named by their hash: writing them again adds what changed in the fixtures, nothing twice.
    if (!merge) writeSeeds(target);
    if (engine !== 'js' && rust(target) !== 0) failed.push(`rust ${target}`);
    if (engine !== 'rust' && (await js(target)) !== 0) failed.push(`js ${target}`);
}
/* Every file under the artifact directories: crash inputs by target, and diverging inputs. */
const found = ['crates/hushos-core/fuzz/artifacts', 'packages/crypto/fuzz/artifacts'].flatMap(
    (dir) =>
        existsSync(join(root, dir))
            ? readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
                  .filter((entry) => entry.isFile())
                  .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
            : [],
);
if (found.length) console.log(`\nCrash inputs:\n${found.join('\n')}`);
if (failed.length) {
    console.error(
        `\nFound something: ${failed.join(', ')}. See CONTRIBUTING.md (Fuzzing) to triage.`,
    );
    process.exit(1);
}

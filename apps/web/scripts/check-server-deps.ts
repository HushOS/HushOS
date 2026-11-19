/*
 * Run after every `vite build` (the web app's `build` script): fails if a library the server
 * must load from its own files was bundled into the server's chunks, or was left out of the output.
 *
 * `@simplewebauthn/server` reaches `@peculiar/x509`, which reaches `tsyringe`, which refuses to
 * load unless `reflect-metadata` ran first. In their own files that order holds. Bundled, it
 * did not: the bundler put tsyringe's module body ahead of the call that runs the polyfill, the
 * shared server chunk threw as it loaded, and every API request answered 500 (the build that
 * first shipped passkeys). So the library stays out of the bundle (`ssr.external` in
 * vite.config.ts) and is copied beside it with everything it needs (`traceDeps` in
 * nitro.config.ts), where the runtime loads each file in the order it was written.
 *
 * The AWS SDK (`@aws-sdk/client-s3` and its presigner in packages/drive, `@aws-sdk/client-sesv2`
 * in packages/emails) failed the same way with nothing of its own changed. Bundled, its CommonJS
 * modules became wrappers spread over two server chunks that import each other; a change to
 * client-only code moved where the chunks split, and one chunk called `require_schema` (Smithy's
 * schema module) at its top level before the other had defined it. Every request answered 500,
 * in CI's built server only. It is kept out and traced the same way.
 *
 * For each library, three checks, each of which those builds would have failed:
 * - no server chunk outside node_modules carries the library's own words;
 * - the library and the packages its load order is about are in the output's node_modules;
 * - it loads from a copy of the output's node_modules alone, in a temporary directory outside this
 *   checkout with Bun's auto-install off, so nothing it needs can come from a node_modules above
 *   the output (as `@aws-sdk/core` once did) or be fetched; a symlink in the output that leads out
 *   of it fails too.
 *
 * And one that keeps the arrangement honest. Each library is a dependency of the package whose
 * code calls it and whose tests run against it, and, where the build needs it to find the copy,
 * of this app. Pinned apart, the tests would verify one version and the server run another. The
 * pins, and the copy in the output, must be the same version.
 */
import {
    cpSync,
    existsSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const server = join(import.meta.dir, '..', '.output', 'server');
const traced = join(server, 'node_modules');
const packages = join(import.meta.dir, '..', '..', '..', 'packages');

type KeptOut = {
    /* The library, as the failure names it. */
    name: string;
    /* Words only its code carries: in a server chunk, it was bundled. */
    bundled: string[];
    /* What must be in the output's node_modules. */
    needed: string[];
    /* Each package the server loads, the workspace package whose code calls it, and an export it must have. */
    loads: { from: string; user: string; export: string }[];
};

const KEPT_OUT: KeptOut[] = [
    {
        name: 'The WebAuthn server library',
        // What tsyringe says when it loads without the polyfill.
        bundled: ['tsyringe requires a reflect polyfill'],
        needed: ['@simplewebauthn/server', 'tsyringe', 'reflect-metadata'],
        loads: [
            {
                from: '@simplewebauthn/server',
                user: 'auth',
                export: 'verifyAuthenticationResponse',
            },
        ],
    },
    {
        name: 'The AWS SDK',
        // Smithy's schema class, and the S3 signer's words for a missing SigV4a signer.
        bundled: [
            'NormalizedSchema',
            "Please ensure you've properly imported @aws-sdk/signature-v4-crt",
        ],
        needed: [
            '@aws-sdk/client-s3',
            '@aws-sdk/client-sesv2',
            '@aws-sdk/s3-request-presigner',
            '@smithy/core',
        ],
        loads: [
            { from: '@aws-sdk/client-s3', user: 'drive', export: 'S3Client' },
            { from: '@aws-sdk/s3-request-presigner', user: 'drive', export: 'getSignedUrl' },
            { from: '@aws-sdk/client-sesv2', user: 'emails', export: 'SESv2Client' },
        ],
    },
];

function* chunks(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (path !== traced) yield* chunks(path);
        } else if (/\.(mjs|js|cjs)$/.test(entry.name)) yield path;
    }
}

const pinned = (manifest: string, name: string) =>
    existsSync(manifest)
        ? (JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> })
              .dependencies?.[name]
        : undefined;

/* Whether `path` is `root` or inside it, on any platform. */
const inside = (root: string, path: string) => {
    const rel = relative(root, path);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/* Symlinks in the output that lead out of it: they would resolve here and on no server. */
function* escapingLinks(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
            if (!inside(traced, resolve(dir, readlinkSync(path)))) yield relative(server, path);
        } else if (entry.isDirectory()) yield* escapingLinks(path);
    }
}

const PROBE_PREFIX = 'hushos-server-deps-';

/*
 * Each export loaded the way a deployed server loads it: from a copy of the output's node_modules
 * in a temporary directory of its own, by a separate Bun with auto-install off and no NODE_PATH, so
 * a dependency the output lacks is missing there too. One line per export that didn't load.
 */
function probe(loads: { from: string; export: string }[]): string[] {
    const dir = mkdtempSync(join(tmpdir(), PROBE_PREFIX));
    try {
        cpSync(traced, join(dir, 'node_modules'), { recursive: true, verbatimSymlinks: true });
        writeFileSync(
            join(dir, 'probe.mjs'),
            `const problems = [];
for (const { from, export: name } of ${JSON.stringify(loads)}) {
    try {
        const loaded = await import(from);
        if (typeof loaded[name] !== 'function') problems.push(\`\${from} loaded without \${name}\`);
    } catch (error) {
        problems.push(\`\${from} does not load from the output alone: \${String(error)}\`);
    }
}
console.log(JSON.stringify(problems));
`,
        );
        const { NODE_PATH: _, ...env } = process.env;
        const run = Bun.spawnSync([process.execPath, '--no-install', 'probe.mjs'], {
            cwd: dir,
            env,
            stdout: 'pipe',
            stderr: 'pipe',
        });
        const last = run.stdout.toString().trim().split('\n').at(-1) ?? '';
        try {
            return JSON.parse(last) as string[];
        } catch {
            return [`the load probe failed: ${run.stderr.toString().trim() || last}`];
        }
    } finally {
        // Only the directory made above: directly in the temporary folder, with this script's prefix.
        if (dirname(dir) === tmpdir() && basename(dir).startsWith(PROBE_PREFIX))
            rmSync(dir, { recursive: true, force: true });
    }
}

let files: { path: string; text: string }[];
try {
    files = [...chunks(server)].map((path) => ({ path, text: readFileSync(path, 'utf8') }));
} catch (error) {
    console.error(`No server output to check at ${server}.`, error);
    process.exit(1);
}

let failed = false;
const links = [...escapingLinks(traced)];
if (links.length) {
    failed = true;
    console.error("The output's node_modules has links that lead out of it:");
    for (const link of links) console.error(`  ${link}`);
}
for (const library of KEPT_OUT) {
    const problems: string[] = [];
    for (const { path, text } of files)
        if (library.bundled.some((words) => text.includes(words)))
            problems.push(`${relative(server, path)} bundles it: keep it external`);
    for (const name of library.needed)
        if (!existsSync(join(traced, name, 'package.json')))
            problems.push(
                `${name} is not in the output's node_modules: the server could not load it`,
            );
    for (const { from, user } of library.loads) {
        const used = pinned(join(packages, user, 'package.json'), from);
        const here = pinned(join(import.meta.dir, '..', 'package.json'), from);
        if (!used) problems.push(`packages/${user} doesn't pin ${from}`);
        if (!here) problems.push(`apps/web doesn't pin ${from}: the build can't find it to copy`);
        else if (used && here !== used)
            problems.push(
                `${from} is pinned to ${here} in apps/web and ${used} in packages/${user}: pin both to one exact version`,
            );
        const copied = join(traced, from, 'package.json');
        if (used && existsSync(copied)) {
            const { version } = JSON.parse(readFileSync(copied, 'utf8')) as { version?: string };
            if (version !== used)
                problems.push(
                    `the output carries ${from} ${version ?? '?'}, and packages/${user} pins ${used}`,
                );
        }
    }
    if (problems.length === 0) problems.push(...probe(library.loads));
    if (problems.length) {
        failed = true;
        console.error(`${library.name} is not where the built server can load it:`);
        for (const line of problems) console.error(`  ${line}`);
    } else console.log(`${library.name} is external to the bundle, traced, and loads.`);
}
if (failed) process.exit(1);

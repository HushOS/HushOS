/*
 * Run after every `vite build` (the web app's `build` script): fails if any shipped worker
 * (the module workers Vite emits, pdf.js's worker and the decoders it loads, the service
 * workers) or any chunk one of them imports would need `unsafe-eval` in the Content Security
 * Policy (docs/file-tools-design.md, "Content Security Policy"). See worker-code.ts for what
 * counts and the one inert exception.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { scanWorkers, workerUrls } from './worker-code';

const root = join(import.meta.dir, '..', '.output', 'public');
const assets = join(root, 'assets');
if (!existsSync(assets)) {
    console.error(`No build output to check at ${root}.`);
    process.exit(1);
}

/*
 * Workers the app is known to ship. Each must be found, so a renamed or newly bundled
 * worker can't leave the check passing over nothing.
 */
const KNOWN = [
    /\/auth\.worker-/,
    /\/json\.worker-/,
    /\/thumbnail\.worker-/,
    /\/pdf\.worker\.min-/,
    /^\/download-sw\.js$/,
    /^\/push-sw\.js$/,
];

/*
 * Imports whose target is computed, reviewed: pdf.js loading its decoders' JavaScript
 * fallbacks from its wasm folder (scanned below as entries of their own), and the thumbnail
 * worker loading pdf.js's worker, which is an entry already. Any other fails the check.
 */
const REVIEWED = [/^`\$\{WasmImage\.#\w+\}\$\{this\._noWasmFilename\}`$/, /^this\.workerSrc$/];

const scripts = (dir: string) => readdirSync(dir).filter((name) => /\.m?js$/.test(name));
function* tree(dir: string): Generator<string> {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) yield* tree(path);
        else if (/\.m?js$/.test(name)) yield path;
    }
}

const entries = new Set<string>();
// Workers by name (Vite keeps the source's name: json.worker, thumbnail.worker, pdf.worker.min, x.tool-worker).
for (const name of scripts(assets)) if (name.includes('worker')) entries.add(`/assets/${name}`);
// And by use: every URL a chunk starts a worker from, whatever it is called.
for (const name of scripts(assets))
    for (const url of workerUrls(readFileSync(join(assets, name), 'utf8')))
        entries.add(new URL(url, 'https://app/assets/').pathname);
// Service workers sit at the root of the public directory.
for (const name of scripts(root)) entries.add(`/${name}`);
// pdf.js's own folder: the decoders its worker imports by a computed path.
for (const name of readdirSync(assets))
    if (name.startsWith('pdfjs-') && statSync(join(assets, name)).isDirectory())
        for (const path of tree(join(assets, name))) entries.add(`/${relative(root, path)}`);

const absent = KNOWN.filter((pattern) => ![...entries].some((entry) => pattern.test(entry)));
if (absent.length) {
    console.error('A worker the app ships was not found, so it would not be checked:');
    for (const pattern of absent) console.error(`  ${pattern}`);
    process.exit(1);
}

const read = (path: string) => {
    const file = join(root, path);
    return file.startsWith(root) && existsSync(file) ? readFileSync(file, 'utf8') : null;
};
const { scanned, findings, missing } = scanWorkers([...entries], read);

if (missing.length) {
    console.error('A worker imports a file the build did not emit:');
    for (const path of missing) console.error(`  ${path}`);
    process.exit(1);
}
const failing = findings.filter(
    (finding) =>
        finding.kind === 'code' || !REVIEWED.some((pattern) => pattern.test(finding.excerpt)),
);
if (failing.length) {
    console.error(
        "Worker code that would need the policy's 'unsafe-eval', or that this check cannot follow:",
    );
    for (const finding of failing)
        console.error(
            `  ${finding.file}: ${finding.what}  …${finding.excerpt.replace(/\s+/g, ' ')}…`,
        );
    process.exit(1);
}
console.log(`No eval or Function in ${scanned.length} worker files (${entries.size} entries).`);

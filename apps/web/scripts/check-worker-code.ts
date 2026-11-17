/*
 * Run after every `vite build` (the web app's `build` script): fails if any shipped worker
 * (the module workers Vite emits, pdf.js's worker, the service workers) or any chunk one of
 * them imports calls `eval` or `Function`, which would need `unsafe-eval` in the Content
 * Security Policy (docs/file-tools-design.md, "Content Security Policy"). See worker-code.ts
 * for what counts and the one inert exception.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scanWorkers, workerUrls } from './worker-code';

const root = join(import.meta.dir, '..', '.output', 'public');
const assets = join(root, 'assets');
if (!existsSync(assets)) {
    console.error(`No build output to check at ${root}.`);
    process.exit(1);
}

const scripts = (dir: string) => readdirSync(dir).filter((name) => /\.m?js$/.test(name));
const entries = new Set<string>();
// Workers by name (Vite keeps the source's name: json.worker, thumbnail.worker, pdf.worker.min).
for (const name of scripts(assets)) if (name.includes('worker')) entries.add(`/assets/${name}`);
// And by use: every URL a chunk starts a worker from, whatever it is called.
for (const name of scripts(assets))
    for (const url of workerUrls(readFileSync(join(assets, name), 'utf8')))
        entries.add(new URL(url, 'https://app/assets/').pathname);
// Service workers sit at the root of the public directory.
for (const name of scripts(root)) entries.add(`/${name}`);

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
if (findings.length) {
    console.error("Worker code that would need the policy's 'unsafe-eval':");
    for (const finding of findings)
        console.error(
            `  ${finding.file}: ${finding.what}  …${finding.excerpt.replace(/\s+/g, ' ')}…`,
        );
    process.exit(1);
}
console.log(`No eval or Function in ${scanned.length} worker files (${entries.size} entries).`);

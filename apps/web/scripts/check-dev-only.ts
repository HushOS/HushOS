/*
 * Run after every `vite build` (the web app's `build` script): fails if the development
 * playground (src/dev, mounted by router.tsx behind import.meta.env.DEV) or DialKit
 * reached the output, client or server. The playground must never ship, to hushos.com or
 * to anyone who builds their own image.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const output = join(import.meta.dir, '..', '.output');
/*
 * Strings minifying keeps. `hushos-dev-playground` is the shell's attribute in JavaScript and
 * its marker utility in CSS, which Tailwind makes only if its production scan reaches src/dev.
 */
const MARKERS = [
    'hushos-dev-playground',
    'dialkit',
    '/dev/components',
    '/dev/layers',
    'data-measure-area',
    'data-force~=',
];
const TEXT = new Set(['.js', '.mjs', '.cjs', '.css', '.html', '.json', '.map', '.txt', '.xml']);

function* files(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) yield* files(path);
        else if (TEXT.has(extname(entry.name))) yield path;
    }
}

const found: string[] = [];
try {
    for (const file of files(output)) {
        const text = readFileSync(file, 'utf8');
        for (const marker of MARKERS)
            if (text.includes(marker)) found.push(`${relative(output, file)}: ${marker}`);
    }
} catch (error) {
    console.error(`No build output to check at ${output}.`, error);
    process.exit(1);
}

if (found.length) {
    console.error('The development playground reached the production build:');
    for (const line of found) console.error(`  ${line}`);
    process.exit(1);
}
console.log('No development playground in the build output.');

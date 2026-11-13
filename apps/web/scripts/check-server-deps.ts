/*
 * Run after every `vite build` (the web app's `build` script): fails if the WebAuthn server
 * library was bundled into the server's own chunks, or was left out of the output.
 *
 * `@simplewebauthn/server` reaches `@peculiar/x509`, which reaches `tsyringe`, which refuses to
 * load unless `reflect-metadata` ran first. In their own files that order holds. Bundled, it
 * did not: the bundler put tsyringe's module body ahead of the call that runs the polyfill, the
 * shared server chunk threw as it loaded, and every API request answered 500 (the build that
 * first shipped passkeys). So the library stays out of the bundle (`ssr.external` in
 * vite.config.ts) and is copied beside it with everything it needs (`traceDeps` in
 * nitro.config.ts), where the runtime loads each file in the order it was written.
 *
 * Three checks, each of which that build would have failed:
 * - no server chunk outside node_modules carries tsyringe's own words;
 * - the library and the two packages the order is about are in the output's node_modules;
 * - the library loads from there, as the server will load it.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const server = join(import.meta.dir, '..', '.output', 'server');
const traced = join(server, 'node_modules');
/* What tsyringe says when it loads without the polyfill: in a server chunk, it was bundled. */
const BUNDLED = 'tsyringe requires a reflect polyfill';
const NEEDED = ['@simplewebauthn/server', 'tsyringe', 'reflect-metadata'];

function* chunks(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (path !== traced) yield* chunks(path);
        } else if (/\.(mjs|js|cjs)$/.test(entry.name)) yield path;
    }
}

const problems: string[] = [];
try {
    for (const file of chunks(server))
        if (readFileSync(file, 'utf8').includes(BUNDLED))
            problems.push(
                `${relative(server, file)} bundles tsyringe: keep @simplewebauthn/server external`,
            );
} catch (error) {
    console.error(`No server output to check at ${server}.`, error);
    process.exit(1);
}
for (const name of NEEDED)
    if (!existsSync(join(traced, name, 'package.json')))
        problems.push(`${name} is not in the output's node_modules: the server could not load it`);
if (problems.length === 0) {
    try {
        const library = (await import(
            join(traced, '@simplewebauthn/server/esm/index.js')
        )) as Record<string, unknown>;
        if (typeof library.verifyAuthenticationResponse !== 'function')
            problems.push('@simplewebauthn/server loaded without verifyAuthenticationResponse');
    } catch (error) {
        problems.push(`@simplewebauthn/server does not load from the output: ${String(error)}`);
    }
}

if (problems.length) {
    console.error('The WebAuthn server library is not where the built server can load it:');
    for (const line of problems) console.error(`  ${line}`);
    process.exit(1);
}
console.log('The WebAuthn server library is external to the bundle, traced, and loads.');

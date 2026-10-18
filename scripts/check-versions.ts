/*
 * HushOS has one product version, the root package.json's. The release pull request
 * (release-please, release-please-config.json) writes it into every copy below; this fails
 * when one of them disagrees, so a hand edit or a copy release-please missed is caught before
 * an app ships naming another version: the store build scripts stop on it, and CI shows it as
 * a warning (never a failure, so it cannot hold up a deploy). Workspace packages are private
 * and keep a fixed placeholder: they are never published, so a version there would mislead.
 *
 *   bun run check:versions
 */
import { Glob } from 'bun';

const PLACEHOLDER = '0.0.0';
const root = new URL('..', import.meta.url).pathname;
const read = (path: string) => Bun.file(root + path).text();
const json = async (path: string) => JSON.parse(await read(path)) as Record<string, unknown>;

const version = (await json('package.json')).version;
const problems: string[] = [];
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version))
    problems.push(`package.json: "version" must be major.minor.patch, found ${String(version)}`);

/* The value one pattern captures in a file, or a problem when it is missing. */
async function captured(path: string, pattern: RegExp) {
    const match = pattern.exec(await read(path));
    if (!match?.[1]) problems.push(`${path}: no version found (${pattern})`);
    return match?.[1];
}

/*
 * The manifest is the last version released. 0.0.0 means none yet: release-please then
 * proposes initial-version (1.0.0) instead of bumping what package.json says.
 */
const released = (await json('.release-please-manifest.json'))['.'];
if (released !== '0.0.0' && released !== version)
    problems.push(
        `.release-please-manifest.json: ${String(released)}, but package.json says ${String(version)}`,
    );

const copies: [string, Promise<string | undefined>][] = [
    [
        'apps/ios/project.yml (MARKETING_VERSION)',
        captured(
            'apps/ios/project.yml',
            /^\s*MARKETING_VERSION: '([^']*)' # x-release-please-version$/m,
        ),
    ],
    [
        'apps/android/app/build.gradle.kts (versionName)',
        captured(
            'apps/android/app/build.gradle.kts',
            /^\s*versionName = "([^"]*)" \/\/ x-release-please-version$/m,
        ),
    ],
    [
        'crates/hushos-core/Cargo.toml',
        captured('crates/hushos-core/Cargo.toml', /^\[package\][^[]*?^version = "([^"]*)"/m),
    ],
    ['Cargo.lock', captured('Cargo.lock', /^name = "hushos-core"\nversion = "([^"]*)"/m)],
    [
        'crates/hushos-core/fuzz/Cargo.lock',
        captured(
            'crates/hushos-core/fuzz/Cargo.lock',
            /^name = "hushos-core"\nversion = "([^"]*)"/m,
        ),
    ],
];
for (const [where, value] of copies) {
    const found = await value;
    if (found !== undefined && found !== version)
        problems.push(`${where}: ${found}, but package.json says ${String(version)}`);
}

for (const pattern of ['apps/*/package.json', 'packages/*/package.json']) {
    for await (const path of new Glob(pattern).scan(root)) {
        const pkg = await json(path);
        if (pkg.private !== true) problems.push(`${path}: must be "private": true`);
        if (pkg.version !== PLACEHOLDER)
            problems.push(
                `${path}: "version" must stay ${PLACEHOLDER}, found ${String(pkg.version)}`,
            );
    }
}

if (problems.length > 0) {
    console.error(`Versions disagree:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    process.exit(1);
}
console.log(`HushOS ${String(version)}: every copy agrees.`);

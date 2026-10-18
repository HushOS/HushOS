import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/*
 * F1 (docs/groups-design.md 2.4, "With no marks at all"): a device with no
 * mark accepts a family's member list only with the join code the person
 * compared with the admin's screen, or over keys its own seed made, and
 * exactly two places may say so. The join flow passes `joining` (with that
 * code) to groupAccept, and only lib/groups/join.ts may, once the person said
 * "They match"; the creator's first acceptance passes `creating`, and only the
 * outbox's creation entry may, through lib/groups/sync.ts. The worker refuses
 * `creating` once any mark exists, but on a fresh device nothing else stands
 * between a server's made-up group key and the person's trust: so any other
 * module naming either is a defect.
 *
 * Comments are left out: what is scanned is code that names the field (as a
 * key, a shorthand property, a quoted name or an assignment), and, beside it,
 * which modules name the groupAccept operation at all.
 *
 * The worker turns `joining` and `creating` into the core's `firstKeysChecked`
 * (packages/crypto/src/session-groups.ts), so the same rule is checked where
 * the flag itself is set: in the crypto package and in Drive, the shipped
 * modules that could call acceptance, every site that gives it anything but
 * `false` must be one of the sites listed below, each with why it may.
 */

const ROOT = join(import.meta.dirname, '..', '..');
const REPO = join(ROOT, '..', '..', '..');
/* Each field, where it is scanned, and the only modules that may name it there. */
const ALLOWED: Record<string, { under: string; only: string[] }> = {
    // Anywhere in the app: nothing but the join flow ever hands over a compared join code.
    joining: { under: '', only: ['lib/groups/join.ts'] },
    // The UI says "creating" of folders; within the families layer only the creation path may.
    creating: { under: 'lib/groups/', only: ['lib/groups/outbox.ts', 'lib/groups/sync.ts'] },
    // And acceptance itself is called from the sync and the join flow, nowhere else.
    groupAccept: { under: '', only: ['lib/groups/join.ts', 'lib/groups/sync.ts'] },
    // The app never sets the core's flag itself: it says `joining` or `creating`, and the worker decides.
    firstKeysChecked: { under: '', only: [] },
};

/* The shipped code that could hand acceptance the flag: the crypto core, its worker, and Drive. */
const PACKAGES = ['packages/crypto/src', 'packages/drive/src'];

/*
 * Every site in PACKAGES that gives `firstKeysChecked` a value other than
 * `false`, as `module › enclosing function: value`. A new one fails the scan
 * until it is listed here with its reason.
 */
const FIRST_KEYS_SITES = [
    // Continues a chain this device (or the server) already accepted: the first keys are that
    // chain's own, vouched for when it was first accepted (checkNextRoster, checkNextSuccession).
    'packages/crypto/src/group-trust.ts › extend: true',
    // The server's acceptance of its own stored history, anchored on the version 1 keys stored at
    // creation, behind the capability only the server entry holds; its StoredChain opens and
    // vouches for nothing on a device (I14).
    'packages/crypto/src/group-trust.ts › acceptStored: true',
    // Creation, inside the worker, over the group key it just made: the staged chain the
    // creating call seals and grants against (design 3.1).
    'packages/crypto/src/session-groups.ts › create: true',
    // The worker's acceptance run (acceptRun, which accept and a join's joinRun call): a join
    // carrying the compared join code where nothing marks the family, and the creating device's
    // committed creation over served first keys equal to the seed it still holds; then the
    // variable is passed on.
    'packages/crypto/src/session-groups.ts › acceptRun: true',
    'packages/crypto/src/session-groups.ts › acceptRun: true',
    'packages/crypto/src/session-groups.ts › acceptRun: (shorthand)',
    // The join's admission (preview, check, and the join's own re-check): verifies over the served
    // first keys only to work out the code the person compares, and commits, keeps and marks nothing.
    'packages/crypto/src/session-groups.ts › admission: !marks',
].sort();

function modules(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return modules(path);
        return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
}

/* A package's shipped modules: tests and test kits (`*-testkit.ts`) left out. */
const shipped = (dir: string) =>
    modules(join(REPO, dir))
        .filter((path) => !path.endsWith('-testkit.ts'))
        .map((path) => relative(REPO, path))
        .sort();

/* The source without comments, so prose may say "joining a family". */
function code(source: string) {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

/*
 * Code that hands the field to anything: `field:`, `{ field }`, `field,`,
 * `'field'`, `.field =`. The operation is a call naming it first: `('groupAccept',`.
 */
function names(source: string, field: string) {
    if (field === 'groupAccept') return /\(\s*['"`]groupAccept['"`]\s*,/.test(code(source));
    return [
        new RegExp(`\\b${field}\\s*:`),
        new RegExp(`[{,]\\s*${field}\\s*[,}]`),
        new RegExp(`['"\`]${field}['"\`]`),
        new RegExp(`\\.${field}\\s*=`),
        new RegExp(`\\[\\s*['"\`]${field}`),
    ].some((pattern) => pattern.test(code(source)));
}

/*
 * Where `source` gives `firstKeysChecked` a value: as a key, an assignment, a
 * shorthand property, or by its quoted name. `false`, and the field's type
 * (`boolean`), give nothing. Each site is named by the function around it.
 */
function firstKeysSites(source: string, module: string) {
    const text = code(source);
    const found: { at: number; value: string }[] = [];
    const take = (pattern: RegExp, value: (match: RegExpExecArray) => string) => {
        for (const match of text.matchAll(pattern))
            found.push({ at: match.index, value: value(match) });
    };
    take(/\bfirstKeysChecked\s*\??:\s*([^,;}\n]+)/g, (match) => match[1]!.trim());
    take(/\bfirstKeysChecked\s*=(?![=>])\s*([^,;)\n]+)/g, (match) => match[1]!.trim());
    take(/[{,]\s*firstKeysChecked\s*(?=[,}])/g, () => '(shorthand)');
    take(/['"`]firstKeysChecked['"`]/g, () => '(by name)');
    return found
        .filter(({ value }) => value !== 'false' && value !== 'boolean')
        .map(({ at, value }) => {
            const around = [...text.slice(0, at).matchAll(/\bfunction\s+([\w$]+)/g)].at(-1);
            return `${module} › ${around?.[1] ?? '(module)'}: ${value}`;
        });
}

describe('who may vouch for a family’s first keys', () => {
    test.each(Object.entries(ALLOWED))('only its own modules name `%s`', (field, allowed) => {
        const offenders = modules(ROOT)
            .map((path) => relative(ROOT, path))
            .filter((path) => path.startsWith(allowed.under))
            .filter((path) => names(readFileSync(join(ROOT, path), 'utf8'), field))
            .sort();
        expect(offenders).toEqual(allowed.only);
    });

    test('only the listed sites in the crypto core and Drive set `firstKeysChecked`', () => {
        const sites = PACKAGES.flatMap(shipped).flatMap((path) =>
            firstKeysSites(readFileSync(join(REPO, path), 'utf8'), path),
        );
        expect(sites.sort()).toEqual(FIRST_KEYS_SITES);
    });

    test('no shipped module of the crypto core or Drive imports a test kit', () => {
        // A test kit's ready-made acceptance input (READER) carries `firstKeysChecked: true`:
        // spread into a shipped call it would set the flag where the scan above cannot see it.
        const importers = PACKAGES.flatMap(shipped).filter((path) =>
            /from\s+['"][^'"]*testkit['"]/.test(code(readFileSync(join(REPO, path), 'utf8'))),
        );
        expect(importers).toEqual([]);
    });

    test('the first keys scan sees every way to set the flag, and names the function', () => {
        const sites = (source: string) => firstKeysSites(source, 'm.ts');
        expect(sites(`async function a() { return accept({ firstKeysChecked: true }); }`)).toEqual([
            'm.ts › a: true',
        ]);
        expect(
            sites(`function b(x) { let firstKeysChecked = false; firstKeysChecked = x; }`),
        ).toEqual(['m.ts › b: x']);
        expect(sites(`function c(input) { input.firstKeysChecked = !marks; }`)).toEqual([
            'm.ts › c: !marks',
        ]);
        expect(sites(`function d() { return accept({ served, firstKeysChecked }); }`)).toEqual([
            'm.ts › d: (shorthand)',
        ]);
        expect(sites(`function e(input) { input['firstKeysChecked'] = true; }`)).toEqual([
            'm.ts › e: (by name)',
        ]);
        expect(
            sites(
                `type I = { firstKeysChecked: boolean };\n// firstKeysChecked: true\nfunction f() { return { firstKeysChecked: false }; }`,
            ),
        ).toEqual([]);
    });

    test('the scan sees every form a call could take', () => {
        expect(names(`rpc('groupAccept', { served, joining: { joinMark } })`, 'joining')).toBe(
            true,
        );
        expect(names(`const input = { served, joining };`, 'joining')).toBe(true);
        expect(names(`input['joining'] = mark;`, 'joining')).toBe(true);
        expect(names(`input.joining = mark;`, 'joining')).toBe(true);
        expect(names(`/* joining: a family */ // joining: too\nconst x = 1;`, 'joining')).toBe(
            false,
        );
        expect(names(`await ctx.rpc(\n 'groupAccept', input)`, 'groupAccept')).toBe(true);
        expect(names(`type A = CryptoResults['groupAccept'];`, 'groupAccept')).toBe(false);
    });
});

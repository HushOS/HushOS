import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/*
 * F1 (docs/groups-design.md 2.4, "With no marks at all";
 * docs/optional-verification.md 3.3): a device with no mark accepts a
 * family's member list only on the join path (with the join code the person
 * compared with the admin's screen, or on first use, where nothing marks the
 * family and its head lets this account in), or over keys its own seed made,
 * and exactly two places may say so. The join flow passes `joining` (with
 * the joins record the worker sealed) to groupAccept, and only
 * lib/groups/join.ts may; the creator's first acceptance passes `creating`,
 * and only the outbox's creation entry may, through lib/groups/sync.ts. The
 * worker refuses `creating` once any mark exists, and first use once any
 * mark exists, but on a fresh device nothing else stands between a server's
 * made-up group key and the person's trust: so any other module naming
 * either is a defect.
 *
 * Comments are left out: what is scanned is code that names the field (as a
 * key, a shorthand property, a quoted name or an assignment), and, beside it,
 * which modules name the groupAccept operation at all.
 *
 * The worker turns `joining` and `creating` into the core's `anchor`
 * (packages/crypto/src/session-groups.ts; it was `firstKeysChecked`), so the
 * same rule is checked where the anchor itself is set: in the crypto package
 * and in Drive, the shipped modules that could call acceptance, every site
 * that gives it anything but `null` must be one of the sites listed below,
 * each with why it may. The scan still refuses `firstKeysChecked` anywhere.
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
    // The families layer never sets the core's anchor itself: it says `joining` or `creating`, and
    // the worker decides. (Elsewhere in the app an anchor is a link's.)
    anchor: { under: 'lib/groups/', only: [] },
    firstKeysChecked: { under: '', only: [] },
};

/* The shipped code that could hand acceptance the flag: the crypto core, its worker, and Drive. */
const PACKAGES = ['packages/crypto/src', 'packages/drive/src'];

/*
 * Every site in PACKAGES that gives `anchor` a value other than `null`, as
 * `module › enclosing function: value`. A new one fails the scan until it is
 * listed here with its reason. (Continuing a chain, extend, passes `null`:
 * the cache is the mark.)
 */
const ANCHOR_SITES = [
    // The server's acceptance of its own stored history, anchored on the version 1 keys stored at
    // creation, behind the capability only the server entry holds; its StoredChain opens and
    // vouches for nothing on a device (I14). No device anchor is `stored`.
    "packages/crypto/src/group-trust.ts › acceptStored: 'stored'",
    // Creation, inside the worker, over the group key it just made: the staged chain the
    // creating call seals and grants against (design 3.1).
    "packages/crypto/src/session-groups.ts › create: 'created'",
    // The worker's acceptance run (acceptRun, which accept, a join's joinRun and a first use's
    // firstUseRun call): a join carrying the compared join code where nothing marks the family
    // (a first use's commit passes none: its record's pin is a mark), and the creating device's
    // committed creation over served first keys equal to the seed it still holds; then the
    // variable is passed on.
    "packages/crypto/src/session-groups.ts › acceptRun: 'join'",
    "packages/crypto/src/session-groups.ts › acceptRun: 'created'",
    'packages/crypto/src/session-groups.ts › acceptRun: (shorthand)',
    // The join's admission (preview, check, first use, and each join's own re-check): verifies
    // over the served first keys on first use only to work out the code the person compares or
    // the roster a first use's record keeps, and commits, keeps and marks nothing.
    "packages/crypto/src/session-groups.ts › admission: marks ? null : 'first-use'",
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
 * Where `source` gives `anchor` a value: as a key, an assignment, a
 * shorthand property, or by its quoted name. `null`, and the field's type
 * (`GroupAnchor…`), give nothing. Each site is named by the function around
 * it. The old flag, `firstKeysChecked`, is a site wherever it appears.
 */
function firstKeysSites(source: string, module: string) {
    const text = code(source);
    const found: { at: number; value: string }[] = [];
    const take = (pattern: RegExp, value: (match: RegExpExecArray) => string) => {
        for (const match of text.matchAll(pattern))
            found.push({ at: match.index, value: value(match) });
    };
    take(/\banchor\s*\??:\s*([^,;}\n]+)/g, (match) => match[1]!.trim());
    take(/\banchor\s*=(?![=>])\s*([^,;)\n]+)/g, (match) => match[1]!.trim());
    take(/[{,]\s*anchor\s*(?=[,}])/g, () => '(shorthand)');
    take(/['"`]anchor['"`]/g, () => '(by name)');
    take(/\bfirstKeysChecked\b/g, () => 'firstKeysChecked');
    return found
        .filter(({ value }) => value !== 'null' && !value.startsWith('GroupAnchor'))
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

    test('only the listed sites in the crypto core and Drive set `anchor`', () => {
        const sites = PACKAGES.flatMap(shipped).flatMap((path) =>
            firstKeysSites(readFileSync(join(REPO, path), 'utf8'), path),
        );
        expect(sites.sort()).toEqual(ANCHOR_SITES);
    });

    test('no shipped module of the crypto core or Drive imports a test kit', () => {
        // A test kit's ready-made acceptance input (READER) carries `anchor: 'created'`:
        // spread into a shipped call it would set the flag where the scan above cannot see it.
        const importers = PACKAGES.flatMap(shipped).filter((path) =>
            /from\s+['"][^'"]*testkit['"]/.test(code(readFileSync(join(REPO, path), 'utf8'))),
        );
        expect(importers).toEqual([]);
    });

    test('the anchor scan sees every way to set the anchor, and names the function', () => {
        const sites = (source: string) => firstKeysSites(source, 'm.ts');
        expect(sites(`async function a() { return accept({ anchor: 'first-use' }); }`)).toEqual([
            "m.ts › a: 'first-use'",
        ]);
        expect(sites(`function b(x) { let anchor = null; anchor = x; }`)).toEqual(['m.ts › b: x']);
        expect(sites(`function c(input) { input.anchor = marks ? null : 'join'; }`)).toEqual([
            "m.ts › c: marks ? null : 'join'",
        ]);
        expect(sites(`function d() { return accept({ served, anchor }); }`)).toEqual([
            'm.ts › d: (shorthand)',
        ]);
        expect(sites(`function e(input) { input['anchor'] = 'created'; }`)).toEqual([
            'm.ts › e: (by name)',
        ]);
        // The old flag is a site wherever it appears, whatever it is given.
        expect(sites(`function g() { return accept({ firstKeysChecked: false }); }`)).toEqual([
            'm.ts › g: firstKeysChecked',
        ]);
        expect(
            sites(
                `type I = { anchor: GroupAnchor | null };\n// anchor: 'created'\nfunction f() { let anchor: GroupAnchor | null = null; return { anchor: null }; }`,
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

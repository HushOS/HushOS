import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/*
 * F1 (docs/groups-design.md 2.4, "With no marks at all"): a device with no
 * mark accepts a family's member list only over first keys the person just
 * checked, and exactly two places may say so. The join flow passes `joining`
 * to groupAccept, and only lib/groups/join.ts may; the creator's first
 * acceptance passes `creating`, and only the outbox's creation entry may,
 * through lib/groups/sync.ts. The worker refuses either once any mark exists,
 * but on a fresh device nothing else stands between a server's made-up group
 * key and the person's trust: so any other module naming either is a defect.
 *
 * Comments are left out: what is scanned is code that names the field (as a
 * key, a shorthand property, a quoted name or an assignment), and, beside it,
 * which modules name the groupAccept operation at all.
 */

const ROOT = join(import.meta.dirname, '..', '..');
/* Each field, where it is scanned, and the only modules that may name it there. */
const ALLOWED: Record<string, { under: string; only: string[] }> = {
    // Anywhere in the app: nothing but the join flow ever says the words were just checked.
    joining: { under: '', only: ['lib/groups/join.ts'] },
    // The UI says "creating" of folders; within the families layer only the creation path may.
    creating: { under: 'lib/groups/', only: ['lib/groups/outbox.ts', 'lib/groups/sync.ts'] },
    // And acceptance itself is called from the sync and the join flow, nowhere else.
    groupAccept: { under: '', only: ['lib/groups/join.ts', 'lib/groups/sync.ts'] },
};

function modules(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return modules(path);
        return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
    });
}

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

describe('who may vouch for a family’s first keys', () => {
    test.each(Object.entries(ALLOWED))('only its own modules name `%s`', (field, allowed) => {
        const offenders = modules(ROOT)
            .map((path) => relative(ROOT, path))
            .filter((path) => path.startsWith(allowed.under))
            .filter((path) => names(readFileSync(join(ROOT, path), 'utf8'), field))
            .sort();
        expect(offenders).toEqual(allowed.only);
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

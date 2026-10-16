import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/*
 * ParsedRoster and ParsedSuccession say a statement's fields came out of the
 * crypto core's parse, not out of a request body. TypeScript lets any object
 * be cast to them, so the brand holds only if casts are confined: to
 * @hushos/groups, which mints them after acceptance, and to this package's
 * tests. A cast anywhere else is a route filling the signer or the changed
 * entries from what a client sent.
 */

const root = new URL('../../../', import.meta.url);
const CAST =
    /\bas\s+(?:\w+\.)*Parsed(?:Roster|Succession)\b|<\s*(?:\w+\.)*Parsed(?:Roster|Succession)\s*>/;
const allowed = (path: string) =>
    path.startsWith('packages/groups/') || /^packages\/db\/src\/[^/]+\.test\.ts$/.test(path);

/* Every TypeScript source under packages/ and apps/web/, skipping dependencies and build output. */
function sources() {
    const files: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(new URL(dir, root), { withFileTypes: true })) {
            const path = `${dir}/${entry.name}`;
            if (entry.isDirectory()) {
                if (
                    !/^(node_modules|dist|\.output|\.turbo|build|generated|rendered)$/.test(
                        entry.name,
                    )
                )
                    walk(path);
            } else if (/\.(ts|tsx)$/.test(entry.name)) files.push(path);
        }
    };
    walk('packages');
    walk('apps/web');
    return files;
}

describe('the parsed-statement brands', () => {
    test('are cast only in @hushos/groups and the database tests', () => {
        const offenders = sources().filter(
            (path) => !allowed(path) && CAST.test(readFileSync(new URL(path, root), 'utf8')),
        );
        expect(offenders).toEqual([]);
    });

    test('the check sees a cast, in either spelling', () => {
        expect(CAST.test('const r = body as ParsedRoster;')).toBe(true);
        expect(CAST.test('const s = <groupsRepository.ParsedSuccession>body;')).toBe(true);
        expect(CAST.test('const r: ParsedRoster = parse(bytes);')).toBe(false);
        expect(allowed('packages/groups/src/server.ts')).toBe(true);
        expect(allowed('apps/web/src/lib/api.server.ts')).toBe(false);
        expect(allowed('packages/db/src/groups.ts')).toBe(false);
    });
});

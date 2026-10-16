import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, test } from 'vitest';

/*
 * Server-only packages reach the browser build only through a module the
 * browser loads. Every module here that is not a server module (`*.server.ts`
 * or `*.server.tsx`, which import '@/lib/server-only') or a test must leave
 * them alone: the server's group acceptance (whose chains no client may
 * trust) and the server's OPAQUE setup.
 */
const SERVER_ONLY = ['@hushos/crypto/group-trust/server', '@hushos/crypto/server'];
const ROOT = join(import.meta.dirname, '..');

function modules(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) return modules(path);
        return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });
}

describe('server-only imports', () => {
    test('no browser module imports a server-only package', () => {
        const offenders = modules(ROOT)
            .filter((path) => !/\.server\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
            .filter((path) => {
                const source = readFileSync(path, 'utf8');
                return SERVER_ONLY.some(
                    (name) => source.includes(`'${name}'`) || source.includes(`"${name}"`),
                );
            })
            .map((path) => relative(ROOT, path));
        expect(offenders).toEqual([]);
    });
});

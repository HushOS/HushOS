import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

/*
 * pele joins the post-unlock preload as one fixed unit: its core and twelve diagram types, all in the
 * diagram worker's one file (docs/editing-design.md, "Diagrams"). Fails if a type outside the twelve
 * gets bundled, or if the set is split into fetches per type (a dynamic import, pele/lazy), which
 * would say what kind of diagram a file holds.
 */
const TWELVE = [
    'class',
    'er',
    'flowchart',
    'gantt',
    'gitGraph',
    'journey',
    'mindmap',
    'pie',
    'quadrantChart',
    'sequence',
    'state',
    'timeline',
];

const src = join(__dirname, '../../..');
const read = (path: string) => readFileSync(join(src, path), 'utf8');

function sources(dir: string): string[] {
    return readdirSync(join(src, dir), { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

describe('pele in the bundle', () => {
    test('the renderer registers exactly the twelve types, imported statically', () => {
        const renderer = read('lib/viewers/markdown/mermaid-render.ts');
        const types = [...renderer.matchAll(/from 'pele\/diagrams\/([\w-]+)'/g)].map(
            (match) => match[1],
        );
        expect([...types].sort((a, b) => a!.localeCompare(b!))).toEqual(TWELVE);
        expect(renderer).not.toMatch(/import\(/);
    });

    test('only the diagram worker reaches pele, and nothing loads it in parts', () => {
        const worker = read('lib/viewers/markdown/mermaid.worker.ts');
        expect(worker).toMatch(/from '@\/lib\/viewers\/markdown\/mermaid-render'/);
        expect(worker).not.toMatch(/import\(/);
        for (const path of sources('.')) {
            const text = read(path);
            // pele/lazy and pele's whole build both fetch or carry every type.
            expect(text, path).not.toMatch(/['"]pele(\/lazy)?['"]/);
            if (path !== join('lib', 'viewers', 'markdown', 'mermaid-render.ts'))
                expect(text, path).not.toMatch(/['"]pele\/(core|diagrams\/[\w-]+)['"]/);
            if (
                path !== join('lib', 'viewers', 'markdown', 'mermaid.worker.ts') &&
                !path.endsWith('.test.ts')
            )
                expect(text, path).not.toMatch(
                    /^import (?!type )[^']*'@\/lib\/viewers\/markdown\/mermaid-render'/m,
                );
        }
    });
});

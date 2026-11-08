import { describe, expect, test } from 'vitest';
import { rotationParts } from './rotation-parts';

/*
 * A rotation page past the server's body cap is refused whole with 413, every time, so the
 * rotation never finishes. Parts must each fit, keep every node once and in order (parents
 * come first in the work), and never cut a node.
 */
const WS = '0b6d4a3e-2c1f-4d5e-8a9b-1c2d3e4f5a6b';
const node = (id: number, size: number) => ({ id: String(id), pad: 'x'.repeat(size) });
const body = (nodes: unknown[]) =>
    new TextEncoder().encode(JSON.stringify({ workspaceId: WS, nodes })).length;

describe('rotationParts', () => {
    test('every part fits, and the parts are the batch in order', () => {
        const sizes = [900, 10, 450, 3000, 1, 1999, 700, 700, 700, 2500, 5];
        const nodes = sizes.map((size, i) => node(i, size));
        const parts = rotationParts(WS, nodes, 2048);
        expect(parts.flat()).toEqual(nodes);
        for (const part of parts) {
            expect(part.length).toBeGreaterThan(0);
            if (part.length > 1) expect(body(part)).toBeLessThanOrEqual(2048);
        }
        // Greedy: no part could have taken the next part's first node.
        for (let i = 0; i + 1 < parts.length; i++)
            expect(body([...parts[i]!, parts[i + 1]![0]])).toBeGreaterThan(2048);
    });

    test('a body exactly at the limit is one request; one byte over is two', () => {
        const nodes = [node(1, 100), node(2, 100)];
        const exact = body(nodes);
        expect(rotationParts(WS, nodes, exact)).toEqual([nodes]);
        expect(rotationParts(WS, nodes, exact - 1)).toEqual([[nodes[0]], [nodes[1]]]);
    });

    test('a node heavier than the limit goes alone, and its neighbours still share', () => {
        const nodes = [node(1, 10), node(2, 10), node(3, 5000), node(4, 10), node(5, 10)];
        expect(rotationParts(WS, nodes, 1024)).toEqual([
            [nodes[0], nodes[1]],
            [nodes[2]],
            [nodes[3], nodes[4]],
        ]);
    });

    test('bytes are counted, not characters', () => {
        // 300 two-byte characters: 300 characters, 600 bytes.
        const wide = { id: '1', pad: 'é'.repeat(300) };
        const nodes = [wide, wide];
        const limit = body(nodes) - 1;
        expect(JSON.stringify({ workspaceId: WS, nodes }).length).toBeLessThan(limit);
        expect(rotationParts(WS, nodes, limit)).toHaveLength(2);
    });

    test('a typical page is one request at the default limit, an empty one none', () => {
        const page = Array.from({ length: 200 }, (_, i) => node(i, 2000));
        expect(rotationParts(WS, page)).toEqual([page]);
        expect(rotationParts(WS, [])).toEqual([]);
    });
});

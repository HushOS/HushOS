import { ROTATION_REQUEST_BYTES } from './protocol';

const utf8 = new TextEncoder();
const bytes = (value: unknown) => utf8.encode(JSON.stringify(value)).length;

/*
 * A rotation batch cut into requests, in order, each body (`{"workspaceId":…,"nodes":[…]}`) at
 * most `limit` bytes. A node is never cut: one heavier than the limit is a request of its own.
 */
export function rotationParts<T>(
    workspaceId: string,
    nodes: readonly T[],
    limit = ROTATION_REQUEST_BYTES,
): T[][] {
    const empty = bytes({ workspaceId, nodes: [] });
    const parts: T[][] = [];
    let part: T[] = [];
    let size = empty;
    for (const node of nodes) {
        const weight = bytes(node);
        // A node after the first in a part costs its separating comma too.
        if (part.length && size + 1 + weight > limit) {
            parts.push(part);
            part = [];
            size = empty;
        }
        size += (part.length ? 1 : 0) + weight;
        part.push(node);
    }
    if (part.length) parts.push(part);
    return parts;
}

import type { NodeView } from './api';
import type { DriveNode } from './client';
import type { TagRegistry } from './tags';

/*
 * The catalogue: every opened node of a workspace in memory, indexed by parent
 * and by tag, with the names the worker opened. It is what answers "everything
 * tagged Home", "files named lease" and "this folder's children" without a
 * request. It lives only as long as the keys do: a lock empties it, and the
 * next unlock rebuilds it from the mirror on disk.
 */

export type CatalogueQuery = { query: string; limit?: number };
export type CatalogueHit = { node: DriveNode; score: number; path: string[] };

/*
 * Search is over words, not strings: a name, a tag, a folder on the path and a
 * file's extension each become lowercase tokens, and a query word matches a
 * token whole, as a prefix, or one typo away once it is long enough to mean
 * something. Every query word must land somewhere; where it lands sets the weight.
 */
export function tokenize(text: string) {
    return text
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean);
}
function extensionOf(name: string) {
    const dot = name.lastIndexOf('.');
    return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}
/* Damerau-Levenshtein, capped at 1: an insertion, deletion, substitution or swapped pair. */
function withinOneEdit(a: string, b: string) {
    if (a === b) return true;
    const la = a.length,
        lb = b.length;
    if (Math.abs(la - lb) > 1) return false;
    let i = 0;
    while (i < la && i < lb && a[i] === b[i]) i++;
    if (la === lb) {
        if (a[i + 1] === b[i] && a[i] === b[i + 1]) return a.slice(i + 2) === b.slice(i + 2);
        return a.slice(i + 1) === b.slice(i + 1);
    }
    return la > lb ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}
function scoreWord(word: string, tokens: string[], weight: number) {
    let best = 0;
    for (const token of tokens) {
        if (token === word) return weight * 3;
        if (token.startsWith(word)) best = Math.max(best, weight * 2);
        else if (word.length >= 4 && withinOneEdit(word, token)) best = Math.max(best, weight);
        else if (word.length >= 4 && withinOneEdit(word, token.slice(0, word.length)))
            best = Math.max(best, weight * 0.5);
    }
    return best;
}

export class Catalogue {
    private readonly nodes = new Map<string, DriveNode>();
    private readonly children = new Map<string, Set<string>>();
    /* From the registry, not the nodes: which nodes carry each tag, and each tag's name. */
    private readonly byTagId = new Map<string, Set<string>>();
    private readonly tagsByNode = new Map<string, string[]>();
    private readonly tagNames = new Map<string, string>();

    get size() {
        return this.nodes.size;
    }

    get(id: string) {
        return this.nodes.get(id) ?? null;
    }

    has(id: string) {
        return this.nodes.has(id);
    }

    upsert(node: DriveNode) {
        this.remove(node.id);
        this.nodes.set(node.id, node);
        if (node.parentId) {
            const siblings = this.children.get(node.parentId) ?? new Set<string>();
            siblings.add(node.id);
            this.children.set(node.parentId, siblings);
        }
    }

    /* The registry's word on tags replaces whatever was known. */
    setTags(registry: TagRegistry) {
        this.byTagId.clear();
        this.tagsByNode.clear();
        this.tagNames.clear();
        for (const tag of registry.tags) {
            this.tagNames.set(tag.id, tag.name);
            const ids = registry.items[tag.id] ?? [];
            this.byTagId.set(tag.id, new Set(ids));
            for (const id of ids) {
                const list = this.tagsByNode.get(id) ?? [];
                list.push(tag.id);
                this.tagsByNode.set(id, list);
            }
        }
    }

    tagsOf(nodeId: string) {
        return this.tagsByNode.get(nodeId) ?? [];
    }

    remove(id: string) {
        const previous = this.nodes.get(id);
        if (!previous) return;
        this.nodes.delete(id);
        if (previous.parentId) {
            const siblings = this.children.get(previous.parentId);
            siblings?.delete(id);
            if (siblings?.size === 0) this.children.delete(previous.parentId);
        }
    }

    /* Everything, keys and tags alike: what a lock calls for. */
    clear() {
        this.clearNodes();
        this.byTagId.clear();
        this.tagsByNode.clear();
        this.tagNames.clear();
    }

    /* The rows alone: a rebuild refiles them, and the registry's word on tags still stands. */
    clearNodes() {
        this.nodes.clear();
        this.children.clear();
    }

    /* A folder's live children, or null when the folder itself is not here. */
    listing(folderId: string) {
        const folder = this.nodes.get(folderId);
        if (!folder) return null;
        const ids = this.children.get(folderId) ?? new Set<string>();
        const children: DriveNode[] = [];
        for (const id of ids) {
            const child = this.nodes.get(id);
            if (child && !child.trashedAt) children.push(child);
        }
        return { folder, ancestors: this.ancestors(folderId), children };
    }

    /* Root first, the folder's parent last; stops at whatever is not here. */
    ancestors(id: string) {
        const chain: DriveNode[] = [];
        let current = this.nodes.get(id);
        while (current?.parentId) {
            const parent = this.nodes.get(current.parentId);
            if (!parent) break;
            chain.unshift(parent);
            current = parent;
        }
        return chain;
    }

    /* Live nodes carrying every one of `tagIds`. */
    byTags(tagIds: string[]) {
        if (tagIds.length === 0) return [];
        const sets = tagIds.map((id) => this.byTagId.get(id) ?? new Set<string>());
        sets.sort((a, b) => a.size - b.size);
        const out: DriveNode[] = [];
        for (const id of sets[0]!) {
            if (!sets.every((set) => set.has(id))) continue;
            const node = this.nodes.get(id);
            if (node && !node.trashedAt) out.push(node);
        }
        return out;
    }

    /* How many live nodes carry each tag, for the sidebar. */
    tagCounts() {
        const counts = new Map<string, number>();
        for (const [tagId, ids] of this.byTagId) {
            let count = 0;
            for (const id of ids) if (!this.nodes.get(id)?.trashedAt) count++;
            if (count) counts.set(tagId, count);
        }
        return counts;
    }

    /* Every live node every query word lands on, best first; folders above files at a tie, then by name. */
    search({ query, limit = 50 }: CatalogueQuery): CatalogueHit[] {
        const words = tokenize(query);
        if (!words.length) return [];
        const hits: CatalogueHit[] = [];
        for (const node of this.nodes.values()) {
            if (node.trashedAt || !node.parentId) continue;
            const name = tokenize(node.name);
            const extension = extensionOf(node.name);
            const tags = this.tagsOf(node.id).flatMap((id) =>
                tokenize(this.tagNames.get(id) ?? ''),
            );
            const chain = this.ancestors(node.id);
            const path = chain.flatMap((ancestor) =>
                ancestor.parentId ? tokenize(ancestor.name) : [],
            );
            let score = 0;
            for (const word of words) {
                const found = Math.max(
                    scoreWord(word, name, 4),
                    extension === word ? 8 : 0,
                    scoreWord(word, tags, 2),
                    scoreWord(word, path, 1),
                );
                if (!found) {
                    score = 0;
                    break;
                }
                score += found;
            }
            if (score) hits.push({ node, score, path: chain.map((ancestor) => ancestor.name) });
        }
        hits.sort(
            (a, b) =>
                b.score - a.score ||
                (a.node.kind === b.node.kind ? 0 : a.node.kind === 'folder' ? -1 : 1) ||
                a.node.name.localeCompare(b.node.name),
        );
        return hits.slice(0, limit);
    }
}

/*
 * Orders mirror rows so every parent comes before its children, which is what
 * the worker needs to open keys. Rows whose parent is missing are returned
 * apart: a mirror with orphans is one that missed a page and should be rebuilt.
 */
export function parentsFirst(rows: NodeView[]) {
    const byParent = new Map<string | null, NodeView[]>();
    for (const row of rows) {
        const list = byParent.get(row.parentId) ?? [];
        list.push(row);
        byParent.set(row.parentId, list);
    }
    const ordered: NodeView[] = [];
    const queue = [...(byParent.get(null) ?? [])];
    byParent.delete(null);
    while (queue.length) {
        const row = queue.shift()!;
        ordered.push(row);
        const children = byParent.get(row.id);
        if (children) {
            queue.push(...children);
            byParent.delete(row.id);
        }
    }
    const orphans = [...byParent.values()].flat();
    return { ordered, orphans };
}

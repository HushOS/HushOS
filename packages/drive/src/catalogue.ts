import type { NodeView } from './api';
import type { DriveNode } from './client';
import { ROOT_LABEL } from './protocol';
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

/*
 * Recent shows a folder once, not again for what it holds, as a window over what changed lately:
 * nodes are taken newest first by their own time, and one with a kept folder above it (at any
 * depth) is folded into that folder instead of kept. A folder kept later takes in what was kept
 * below it, so the topmost recent folder stands in for everything under it. The walk stops once
 * `limit` rows are kept, so a folder older than that window hides nothing: a file changed today
 * inside it shows on its own. `parentOf` walks up through folders not among `nodes`; one it
 * doesn't know ends the walk. Each row carries the newest change it stands for as `recentAt`,
 * which Recent sorts by and shows.
 */
export function collapseRecent(
    nodes: Iterable<DriveNode>,
    limit: number,
    parentOf: (id: string) => string | null | undefined = () => null,
): RecentNode[] {
    const held = new Map<string, DriveNode>();
    for (const node of nodes) held.set(node.id, node);
    const parent = (id: string) => held.get(id)?.parentId ?? parentOf(id);
    // Newest first; things changed in the same moment by name, then id, so the order never shuffles.
    const newer = (a: { node: DriveNode; at: number }, b: { node: DriveNode; at: number }) =>
        b.at - a.at ||
        a.node.name.localeCompare(b.node.name) ||
        (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0);
    // Kept rows by id, with the newest change each stands for, as it was written.
    const kept = new Map<string, { node: DriveNode; at: number; iso: string }>();
    // The kept folder above an id, if any: on any line of folders at most one is kept.
    const keptAbove = (id: string) => {
        const walked = new Set<string>();
        for (let current = parent(id); current && !walked.has(current); current = parent(current)) {
            walked.add(current);
            const row = kept.get(current);
            if (row) return row;
        }
        return undefined;
    };
    const order = [...held.values()]
        .map((node) => ({ node, at: Date.parse(node.updatedAt) || 0 }))
        .sort(newer);
    for (const { node, at } of order) {
        if (kept.size >= limit) break;
        const above = keptAbove(node.id);
        if (above) {
            if (at > above.at) Object.assign(above, { at, iso: node.updatedAt });
            continue;
        }
        const row = { node, at, iso: node.updatedAt };
        kept.set(node.id, row);
        if (node.kind === 'folder')
            for (const [id, below] of kept)
                if (id !== node.id && keptAbove(id) === row) {
                    kept.delete(id);
                    if (below.at > row.at) Object.assign(row, { at: below.at, iso: below.iso });
                }
    }
    return [...kept.values()].sort(newer).map((row) => ({ ...row.node, recentAt: row.iso }));
}

/* A row of Recent: the node, and when Recent says it changed (`collapseRecent`). */
export type RecentNode = DriveNode & { recentAt: string };

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

    /* Every node held, in no particular order. */
    values() {
        return [...this.nodes.values()];
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

    /* True when the node was here. */
    remove(id: string) {
        const previous = this.nodes.get(id);
        if (!previous) return false;
        this.nodes.delete(id);
        if (previous.parentId) {
            const siblings = this.children.get(previous.parentId);
            siblings?.delete(id);
            if (siblings?.size === 0) this.children.delete(previous.parentId);
        }
        return true;
    }

    /*
     * A purged node and everything below it. The server tombstones what was inside a purged
     * folder only when its background fan-out reaches it, minutes later, and until then
     * those rows would hang here without a parent: unreachable, yet live by their own word.
     * Returns how many nodes it removed.
     */
    removeTree(id: string) {
        const ids = [id];
        for (let index = 0; index < ids.length; index++)
            for (const child of this.children.get(ids[index]!) ?? []) ids.push(child);
        let removed = 0;
        for (const each of ids) {
            if (this.remove(each)) removed++;
            this.children.delete(each);
        }
        return removed;
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

    /* Live nodes carrying every one of `tagIds`; none inside a trashed folder. */
    byTags(tagIds: string[]) {
        if (tagIds.length === 0) return [];
        const sets = tagIds.map((id) => this.byTagId.get(id) ?? new Set<string>());
        sets.sort((a, b) => a.size - b.size);
        const isLive = this.liveCheck();
        const out: DriveNode[] = [];
        for (const id of sets[0]!) {
            if (!sets.every((set) => set.has(id))) continue;
            const node = this.nodes.get(id);
            if (node && isLive(node)) out.push(node);
        }
        return out;
    }

    /*
     * A check for "live": not trashed, no trashed folder above it, and every folder
     * above it here. Trashing a folder marks only the folder, so what is inside it
     * must be ruled out by its ancestors. Answers are remembered for the life of
     * the check.
     */
    private liveCheck() {
        const live = new Map<string, boolean>();
        const isLive = (node: DriveNode): boolean => {
            const known = live.get(node.id);
            if (known !== undefined) return known;
            // A parent that is not here was purged (or never arrived): nothing reaches this node.
            const parent = node.parentId ? this.nodes.get(node.parentId) : undefined;
            const value =
                !node.trashedAt &&
                (node.parentId === null || (parent !== undefined && isLive(parent)));
            live.set(node.id, value);
            return value;
        };
        return isLive;
    }

    /*
     * What changed lately, newest first: live nodes below the top folder that `keep` lets
     * through, a folder standing in for what it holds (`collapseRecent`). `fresher` rows (a
     * listing or a restore the catalogue has yet to file) take the place of its own.
     */
    recent(
        limit: number,
        keep: (node: DriveNode) => boolean = () => true,
        fresher: Iterable<DriveNode> = [],
    ) {
        const isLive = this.liveCheck();
        const found = new Map<string, DriveNode>();
        for (const node of this.nodes.values())
            if (node.parentId && isLive(node) && keep(node)) found.set(node.id, node);
        for (const node of fresher)
            if (node.parentId && !node.trashedAt && keep(node)) found.set(node.id, node);
        return collapseRecent(found.values(), limit, (id) => this.nodes.get(id)?.parentId);
    }

    /* How many live nodes carry each tag, for the sidebar. */
    tagCounts() {
        const counts = new Map<string, number>();
        const isLive = this.liveCheck();
        for (const [tagId, ids] of this.byTagId) {
            let count = 0;
            for (const id of ids) {
                const node = this.nodes.get(id);
                if (node && isLive(node)) count++;
            }
            if (count) counts.set(tagId, count);
        }
        return counts;
    }

    /* Every live node every query word lands on (none inside a trashed folder), best first; folders above files at a tie, then by name. */
    search({ query, limit = 50 }: CatalogueQuery): CatalogueHit[] {
        const words = tokenize(query);
        if (!words.length) return [];
        const hits: CatalogueHit[] = [];
        const isLive = this.liveCheck();
        for (const node of this.nodes.values()) {
            if (!node.parentId || !isLive(node)) continue;
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
            if (score)
                hits.push({
                    node,
                    score,
                    path: chain.map((ancestor) => (ancestor.parentId ? ancestor.name : ROOT_LABEL)),
                });
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

/*
 * Orders a batch of changes so a node comes after its parent whenever the parent is in the
 * batch too, keeping change order otherwise; what is not in the batch is taken as opened.
 * A node the batch holds twice (it changed again between two pages of one pull, or a pull
 * went back over what it had) is kept at its last copy, in the place of that copy.
 */
export function parentsBefore(rows: NodeView[]) {
    const byId = new Map<string, NodeView>();
    for (const row of rows) {
        byId.delete(row.id);
        byId.set(row.id, row);
    }
    const placed = new Set<string>();
    const ordered: NodeView[] = [];
    for (const row of byId.values()) {
        // Up the chain to the first ancestor placed or outside the batch, then back down.
        const chain: NodeView[] = [];
        for (
            let at: NodeView | undefined = row;
            at && !placed.has(at.id);
            at = at.parentId === null ? undefined : byId.get(at.parentId)
        ) {
            placed.add(at.id);
            chain.push(at);
        }
        for (let index = chain.length - 1; index >= 0; index--) ordered.push(chain[index]!);
    }
    return ordered;
}

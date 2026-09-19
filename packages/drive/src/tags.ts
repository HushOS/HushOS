/*
 * Tags. A tag is a set an item belongs to, across folders: flat, never
 * nested. The workspace keeps one registry as a sealed document under the
 * workspace key: the tags (id, name, colour) and which items carry each. Node
 * metadata never mentions tags, so someone holding an item's key and not the
 * workspace key, as a share's recipient does, learns nothing of them, and
 * tagging never touches a node's envelope or its version.
 */

export const TAGS_DOCUMENT = 'tags';
export const MAX_TAGS = 200;
export const MAX_TAGS_PER_NODE = 16;
export const TAG_NAME_MAX_CODE_POINTS = 40;

/* The five Ledger colours a new tag cycles through, and any hex colour a person picks instead. */
export const TAG_PRESETS = ['blue', 'ink', 'yellow', 'teal', 'coral'] as const;
export const TAG_COLOURS = TAG_PRESETS;
export type TagPreset = (typeof TAG_PRESETS)[number];
export type TagColour = TagPreset | `#${string}`;
const HEX = /^#[0-9a-f]{6}$/i;
export function isTagColour(value: unknown): value is TagColour {
    return (
        typeof value === 'string' &&
        ((TAG_PRESETS as readonly string[]).includes(value) || HEX.test(value))
    );
}
export function normaliseColour(value: TagColour): TagColour {
    return HEX.test(value) ? (value.toLowerCase() as TagColour) : value;
}

export type Tag = { id: string; name: string; colour: TagColour };
/* `items` maps a tag id to the ids of the nodes carrying it. */
export type TagRegistry = { version: 2; tags: Tag[]; items: Record<string, string[]> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function checkTagName(name: string) {
    if (typeof name !== 'string') throw new Error('Enter a tag name.');
    const clean = name.trim().replace(/\s+/g, ' ');
    const points = Array.from(clean).length;
    if (points < 1) throw new Error('Enter a tag name.');
    if (points > TAG_NAME_MAX_CODE_POINTS)
        throw new Error(`Use a tag name of at most ${TAG_NAME_MAX_CODE_POINTS} characters.`);
    for (const character of clean) {
        const point = character.codePointAt(0) ?? 0;
        if (point < 0x20 || point === 0x7f)
            throw new Error('Tag names cannot contain control characters.');
    }
    return clean;
}

const fold = (name: string) => name.toLocaleLowerCase();

export function emptyRegistry(): TagRegistry {
    return { version: 2, tags: [], items: {} };
}

/* Reads an opened document as a registry, dropping entries that make no sense rather than refusing the whole. */
export function parseRegistry(document: unknown): TagRegistry {
    if (!document || typeof document !== 'object' || Array.isArray(document))
        throw new Error('The tag list could not be read.');
    const value = document as Record<string, unknown>;
    if (value.version !== 1 && value.version !== 2)
        throw new Error('The tag list was made by a newer app.');
    const tags: Tag[] = [];
    const seen = new Set<string>();
    for (const entry of Array.isArray(value.tags) ? value.tags : []) {
        if (!entry || typeof entry !== 'object') continue;
        const tag = entry as Record<string, unknown>;
        if (typeof tag.id !== 'string' || !UUID.test(tag.id) || seen.has(tag.id)) continue;
        let name: string;
        try {
            name = checkTagName(tag.name as string);
        } catch {
            continue;
        }
        const colour = isTagColour(tag.colour)
            ? normaliseColour(tag.colour)
            : TAG_PRESETS[tags.length % TAG_PRESETS.length]!;
        seen.add(tag.id);
        tags.push({ id: tag.id, name, colour });
        if (tags.length === MAX_TAGS) break;
    }
    const items: Record<string, string[]> = {};
    const raw =
        value.items && typeof value.items === 'object'
            ? (value.items as Record<string, unknown>)
            : {};
    for (const tag of tags) {
        const list = raw[tag.id];
        if (!Array.isArray(list)) continue;
        const ids = [
            ...new Set(list.filter((id): id is string => typeof id === 'string' && UUID.test(id))),
        ];
        if (ids.length) items[tag.id] = ids;
    }
    return { version: 2, tags, items };
}

export function findTag(registry: TagRegistry, name: string) {
    const wanted = fold(checkTagName(name));
    return registry.tags.find((tag) => fold(tag.name) === wanted) ?? null;
}

/* The colour a new tag would get if nobody chose one: the next in the cycle. */
export function nextColour(registry: TagRegistry): TagColour {
    return TAG_PRESETS[registry.tags.length % TAG_PRESETS.length]!;
}

/* A new tag, in the chosen colour or the next in the cycle; an existing name is returned as is. */
export function addTag(
    registry: TagRegistry,
    name: string,
    colour?: TagColour,
): { registry: TagRegistry; tag: Tag } {
    const existing = findTag(registry, name);
    if (existing) return { registry, tag: existing };
    if (registry.tags.length >= MAX_TAGS)
        throw new Error(`A workspace can have at most ${MAX_TAGS} tags.`);
    if (colour !== undefined && !isTagColour(colour)) throw new Error('Pick a colour.');
    const tag: Tag = {
        id: crypto.randomUUID(),
        name: checkTagName(name),
        colour: colour === undefined ? nextColour(registry) : normaliseColour(colour),
    };
    return { registry: { ...registry, tags: [...registry.tags, tag] }, tag };
}

export function renameTag(registry: TagRegistry, id: string, name: string): TagRegistry {
    const clean = checkTagName(name);
    const taken = findTag(registry, clean);
    if (taken && taken.id !== id) throw new Error('A tag with that name already exists.');
    if (!registry.tags.some((tag) => tag.id === id)) throw new Error('That tag no longer exists.');
    return {
        ...registry,
        tags: registry.tags.map((tag) => (tag.id === id ? { ...tag, name: clean } : tag)),
    };
}

export function recolourTag(registry: TagRegistry, id: string, colour: TagColour): TagRegistry {
    if (!isTagColour(colour)) throw new Error('Pick a colour.');
    const clean = normaliseColour(colour);
    return {
        ...registry,
        tags: registry.tags.map((tag) => (tag.id === id ? { ...tag, colour: clean } : tag)),
    };
}

/* The tag and every item's membership in it go together. */
export function removeTag(registry: TagRegistry, id: string): TagRegistry {
    const { [id]: _gone, ...items } = registry.items;
    return { version: 2, tags: registry.tags.filter((tag) => tag.id !== id), items };
}

/* The ids of the tags a node carries, in the registry's order. */
export function tagsOf(registry: TagRegistry, nodeId: string) {
    return registry.tags
        .filter((tag) => registry.items[tag.id]?.includes(nodeId))
        .map((tag) => tag.id);
}

/* The node in exactly these tags and no other; unknown ids are dropped, the cap enforced. */
export function assign(registry: TagRegistry, nodeId: string, tagIds: string[]): TagRegistry {
    const wanted = new Set(tagIds.filter((id) => registry.tags.some((tag) => tag.id === id)));
    if (wanted.size > MAX_TAGS_PER_NODE)
        throw new Error(`An item can carry at most ${MAX_TAGS_PER_NODE} tags.`);
    const items: Record<string, string[]> = {};
    for (const tag of registry.tags) {
        const current = registry.items[tag.id] ?? [];
        const next = wanted.has(tag.id)
            ? current.includes(nodeId)
                ? current
                : [...current, nodeId]
            : current.filter((id) => id !== nodeId);
        if (next.length) items[tag.id] = next;
    }
    return { ...registry, items };
}

/*
 * Merges a registry another device saved over ours. Tags: every one either
 * side knows survives, ours winning a name or colour dispute for the same id
 * when we changed it, and a removal on either side sticking unless the other
 * side touched the tag. Items: per tag, what we added is added, what we removed
 * is removed, and the rest is theirs. Callers pass the registry they started
 * from, which is what gives "changed" and "added" a meaning.
 */
export function mergeRegistries(base: TagRegistry, ours: TagRegistry, theirs: TagRegistry) {
    const baseById = new Map(base.tags.map((tag) => [tag.id, tag]));
    const oursById = new Map(ours.tags.map((tag) => [tag.id, tag]));
    const theirsById = new Map(theirs.tags.map((tag) => [tag.id, tag]));
    const ids = new Set([...oursById.keys(), ...theirsById.keys()]);
    const tags: Tag[] = [];
    for (const id of ids) {
        const mine = oursById.get(id);
        const other = theirsById.get(id);
        const before = baseById.get(id);
        const changedByUs =
            mine !== undefined &&
            (!before || before.name !== mine.name || before.colour !== mine.colour);
        if (mine && other) tags.push(changedByUs ? mine : other);
        else if (mine && (!before || changedByUs)) tags.push(mine);
        else if (other && !before) tags.push(other);
    }
    if (tags.length > MAX_TAGS) tags.length = MAX_TAGS;
    const items: Record<string, string[]> = {};
    for (const tag of tags) {
        const was = new Set(base.items[tag.id] ?? []);
        const mine = new Set(ours.items[tag.id] ?? []);
        const other = new Set(theirs.items[tag.id] ?? []);
        const merged = new Set(other);
        for (const id of mine) if (!was.has(id)) merged.add(id);
        for (const id of was) if (!mine.has(id)) merged.delete(id);
        if (merged.size) items[tag.id] = [...merged];
    }
    return { version: 2 as const, tags, items };
}

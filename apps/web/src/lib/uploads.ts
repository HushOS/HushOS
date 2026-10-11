import type { DriveNode } from '@hushos/drive/client';
import type { QueryClient } from '@tanstack/react-query';
import { askCollision, type CollisionDecision } from '@/lib/collisions';
import { driveClient, folderQueryOptions, invalidateFolders, nextName } from '@/lib/drive';
import type { Dropped } from '@/lib/dropped-files';
import { transfers } from '@/lib/transfers';
import type { EnqueueInput } from '@hushos/drive/transfers';

/*
 * From dropped or picked files to queued uploads. A dropped folder merges into
 * what is already there: at every depth, a folder of the same name is reused and
 * only a missing one is made (empty ones too, when the drop says so). A file whose
 * name already exists in its destination, at any depth, waits for the person to
 * choose: replace (that file's next version), keep both under another name, or
 * skip. Files with free names start at once.
 */
export async function enqueueDropped(
    queryClient: QueryClient,
    folder: DriveNode,
    dropped: Dropped,
    knownChildren: DriveNode[],
) {
    const { files } = dropped;
    // What each destination already holds: the top folder's is known, a folder made by this
    // drop is empty, and any other folder is listed once when first needed.
    const listings = new Map<string, DriveNode[]>([[folder.id, knownChildren]]);
    const madeHere = new Set<string>();
    const childrenOf = async (parent: DriveNode) => {
        if (madeHere.has(parent.id)) return [];
        let children = listings.get(parent.id);
        if (!children) {
            children = (await queryClient.fetchQuery(folderQueryOptions(parent.id))).children;
            listings.set(parent.id, children);
        }
        return children;
    };
    // Every folder the drop needs, each prefix included, parents before children.
    const paths = new Set<string>();
    for (const path of [...files.map((entry) => entry.path), ...dropped.folders])
        for (let depth = 1; depth <= path.length; depth++)
            paths.add(path.slice(0, depth).join('/'));
    const ordered = [...paths].sort((a, b) => a.split('/').length - b.split('/').length);
    const parents = new Map<string, DriveNode>([['', folder]]);
    let createdAny = false;
    for (const key of ordered) {
        const segments = key.split('/');
        const parent = parents.get(segments.slice(0, -1).join('/')) ?? folder;
        const name = segments.at(-1)!;
        const same = (await childrenOf(parent)).find(
            (child) => child.kind === 'folder' && child.name === name,
        );
        if (same) {
            parents.set(key, same);
            continue;
        }
        const [created] = await driveClient.createFolderPath(parent, [name]);
        madeHere.add(created!.id);
        parents.set(key, created!);
        createdAny = true;
    }
    if (createdAny) await invalidateFolders(queryClient, folder.id);
    // Names match whatever their case, as the phones and the "keep both" names already do:
    // "notes.txt" arriving where "Notes.txt" lives is the same file, so it asks.
    const existing = new Map<string, Map<string, DriveNode>>();
    for (const parent of new Set(files.map((entry) => parents.get(entry.path.join('/')) ?? folder)))
        existing.set(
            parent.id,
            new Map(
                (await childrenOf(parent))
                    .filter((child) => child.kind === 'file')
                    .map((child) => [child.name.toLowerCase(), child]),
            ),
        );
    const free: EnqueueInput[] = [];
    const collisions: { input: EnqueueInput; replaces: DriveNode }[] = [];
    for (const entry of files) {
        const parent = parents.get(entry.path.join('/')) ?? folder;
        const input = { file: entry.file, parent, handle: entry.handle };
        const replaces = existing.get(parent.id)?.get(entry.file.name.toLowerCase());
        if (replaces) collisions.push({ input, replaces });
        else free.push(input);
    }
    const ids = transfers.enqueue(free);
    // Names claimed by this drop so far, per folder, so "keep both" cannot collide twice.
    const claimed = new Map<string, Set<string>>();
    const takenIn = (parent: DriveNode) => {
        let set = claimed.get(parent.id);
        if (!set) {
            set = new Set(existing.get(parent.id)?.keys() ?? []);
            claimed.set(parent.id, set);
        }
        return set;
    };
    for (const input of free) takenIn(input.parent).add(input.file.name);
    let standing: CollisionDecision | null = null;
    for (const [index, { input, replaces }] of collisions.entries()) {
        const taken = takenIn(input.parent);
        const decision: CollisionDecision =
            standing ??
            (await askCollision({
                fileName: input.file.name,
                folderName: input.parent.name,
                suggested: nextName(input.file.name, taken),
                taken,
                remaining: collisions.length - index - 1,
            }));
        if (decision.all && !standing) standing = decision;
        if (decision.action === 'skip') continue;
        if (decision.action === 'replace') {
            ids.push(...transfers.enqueue([{ ...input, replaces }]));
            continue;
        }
        // A standing "keep both" names each later file itself; a chosen name applies once.
        const name = standing === decision ? nextName(input.file.name, taken) : decision.name;
        taken.add(name);
        ids.push(...transfers.enqueue([{ ...input, name }]));
    }
    return ids;
}

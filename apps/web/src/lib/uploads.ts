import type { DriveNode } from '@hushos/drive/client';
import type { QueryClient } from '@tanstack/react-query';
import { askCollision, type CollisionDecision } from '@/lib/collisions';
import { driveClient, folderQueryOptions, invalidateFolders, nextName } from '@/lib/drive';
import type { DroppedFile } from '@/lib/dropped-files';
import { transfers } from '@/lib/transfers';
import type { EnqueueInput } from '@hushos/drive/transfers';

/*
 * From dropped or picked files to queued uploads. Files with a folder path get
 * their folders created first, one request per new folder, reusing a folder that
 * already exists at the top level of the drop; the queue then takes the files.
 * A file whose name already exists in its destination waits for the person to
 * choose: replace (that file's next version), keep both under another name, or
 * skip. Files with free names start at once.
 */
export async function enqueueDropped(
    queryClient: QueryClient,
    folder: DriveNode,
    dropped: DroppedFile[],
    knownChildren: DriveNode[],
) {
    const parents = new Map<string, DriveNode>();
    parents.set('', folder);
    for (const child of knownChildren)
        if (child.kind === 'folder' && !parents.has(child.name)) parents.set(child.name, child);
    const paths = [...new Set(dropped.map((entry) => entry.path.join('/')))]
        .filter(Boolean)
        .sort((a, b) => a.split('/').length - b.split('/').length);
    let createdAny = false;
    for (const key of paths) {
        if (parents.has(key)) continue;
        const segments = key.split('/');
        const parentKey = segments.slice(0, -1).join('/');
        const parent = parents.get(parentKey) ?? folder;
        const [created] = await driveClient.createFolderPath(parent, [segments.at(-1)!]);
        parents.set(key, created!);
        createdAny = true;
    }
    if (createdAny) await invalidateFolders(queryClient, folder.id);
    // Files already in each destination, by name: the top folder's are known, a
    // folder that existed before this drop is listed once, a new one is empty.
    const existing = new Map<string, Map<string, DriveNode>>();
    const byName = (children: DriveNode[]) =>
        new Map(
            children.filter((child) => child.kind === 'file').map((child) => [child.name, child]),
        );
    existing.set(folder.id, byName(knownChildren));
    for (const parent of new Set(
        dropped.map((entry) => parents.get(entry.path.join('/')) ?? folder),
    ))
        if (!existing.has(parent.id)) {
            const created = createdAny && !knownChildren.some((child) => child.id === parent.id);
            existing.set(
                parent.id,
                created
                    ? new Map()
                    : byName(
                          (await queryClient.fetchQuery(folderQueryOptions(parent.id))).children,
                      ),
            );
        }
    const free: EnqueueInput[] = [];
    const collisions: { input: EnqueueInput; replaces: DriveNode }[] = [];
    for (const entry of dropped) {
        const parent = parents.get(entry.path.join('/')) ?? folder;
        const input = { file: entry.file, parent, handle: entry.handle };
        const replaces = existing.get(parent.id)?.get(entry.file.name);
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

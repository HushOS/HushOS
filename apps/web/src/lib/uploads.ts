import type { DriveNode } from '@hushos/drive/client';
import type { QueryClient } from '@tanstack/react-query';
import { askCollision, type CollisionDecision } from '@/lib/collisions';
import {
    clientFor,
    folderQueryOptions,
    invalidateFolders,
    nextName,
    refuseWrite,
    waitsForKeyChange,
} from '@/lib/drive';
import { deviceSession } from '@/lib/device-session';
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
    // A sign-out while folders are made or a collision is asked about queues none of this.
    const from = { generation: deviceSession.generation() };
    // A family folder that may not be written now takes nothing. One a key change has not reached
    // yet (docs/groups-server.md 8) takes files, which wait in the queue until it has; folders the
    // drop makes there wait here first, since a new folder is wrapped under its parent's key.
    const needsFolders = dropped.folders.length > 0 || files.some((entry) => entry.path.length);
    if (needsFolders) folder = await untilWritable(queryClient, folder);
    else refuseUnlessWaiting(folder);
    // What each destination already holds: the top folder's is known, a folder made by this
    // drop is empty, and any other folder is listed once when first needed.
    const listings = new Map<string, DriveNode[]>([[folder.id, knownChildren]]);
    const madeHere = new Set<string>();
    const childrenOf = async (parent: DriveNode) => {
        if (madeHere.has(parent.id)) return [];
        let children = listings.get(parent.id);
        if (!children) {
            children = (
                await queryClient.fetchQuery(folderQueryOptions(parent.id, parent.workspaceId))
            ).children;
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
            // A folder already there may be one a key change has not reached yet: its files wait
            // in the queue, and folders made inside it wait here.
            const deeper = ordered.some((other) => other.startsWith(`${key}/`));
            parents.set(key, deeper ? await untilWritable(queryClient, same) : same);
            if (!deeper) refuseUnlessWaiting(same);
            continue;
        }
        const [created] = await clientFor(parent.workspaceId).createFolderPath(parent, [name]);
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
    // Names claimed by this drop so far, per folder, so neither a second file of the same name
    // nor a "keep both" name can land on one already given out.
    const claimed = new Map<string, Set<string>>();
    const takenIn = (parent: DriveNode) => {
        let set = claimed.get(parent.id);
        if (!set) {
            set = new Set(existing.get(parent.id)?.keys() ?? []);
            claimed.set(parent.id, set);
        }
        return set;
    };
    const free: EnqueueInput[] = [];
    const collisions: { input: EnqueueInput; replaces: DriveNode }[] = [];
    for (const entry of files) {
        const parent = parents.get(entry.path.join('/')) ?? folder;
        const input = { file: entry.file, parent, handle: entry.handle };
        const replaces = existing.get(parent.id)?.get(entry.file.name.toLowerCase());
        if (replaces) {
            collisions.push({ input, replaces });
            continue;
        }
        // Two same-named files with nothing in the folder to clash with (dragged from a search
        // window, say) land as "name" and "name (2)", as on the phones.
        const taken = takenIn(parent);
        const name = nextName(entry.file.name, taken);
        taken.add(name);
        free.push(name === entry.file.name ? input : { ...input, name });
    }
    const ids = transfers.enqueue(free, from);
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
            // A new version goes under the file's own key: one a key change has not reached
            // waits in the queue too.
            refuseUnlessWaiting(replaces);
            ids.push(...transfers.enqueue([{ ...input, replaces }], from));
            continue;
        }
        // A standing "keep both" names each later file itself; a chosen name applies once.
        const name = standing === decision ? nextName(input.file.name, taken) : decision.name;
        taken.add(name);
        ids.push(...transfers.enqueue([{ ...input, name }], from));
    }
    return ids;
}

/* A refusal that is not only a key change on its way (which the queue waits out) stops the drop. */
function refuseUnlessWaiting(target: DriveNode) {
    const refused = refuseWrite(target);
    if (refused && !waitsForKeyChange(target)) throw new Error(refused);
}

const KEY_CHANGE_RECHECK_MS = 5_000;
/* How long a drop's new folders wait for a key change before the drop gives up and says so. */
const KEY_CHANGE_GIVE_UP_MS = 10 * 60_000;
/*
 * `folder` once a family folder's key change has reached it (its key epoch at
 * the walk's target, read afresh) or the walk is over: what a new folder needs
 * before it is wrapped under its key. Any other refusal stops at once.
 */
async function untilWritable(queryClient: QueryClient, folder: DriveNode) {
    let current = folder;
    const giveUpAt = Date.now() + KEY_CHANGE_GIVE_UP_MS;
    for (;;) {
        const refused = refuseWrite(current);
        if (!refused) return current;
        if (!waitsForKeyChange(current)) throw new Error(refused);
        if (Date.now() > giveUpAt)
            throw new Error(
                'The family folder’s key change hasn’t reached this folder yet, so its folders weren’t made. Try again later.',
            );
        await new Promise((resolve) => setTimeout(resolve, KEY_CHANGE_RECHECK_MS));
        // The parent's listing names the folder with its key epoch as it is now.
        const fresh = await queryClient.fetchQuery({
            ...folderQueryOptions(current.id, current.workspaceId),
            staleTime: 0,
        });
        current = fresh.folder;
    }
}

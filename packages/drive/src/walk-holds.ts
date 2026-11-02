import type { Rpc } from './client';

/*
 * The window a walk's batch holds fresh keys pending in this tab's crypto
 * worker, per folder: from driveRotateNodes, across the batch's request,
 * until driveRotateCommit and driveRotateDrop. The worker's ledger hands a
 * folder's pending key to whatever is wrapped under the folder at the walk's
 * target epoch (it is what the walk's own children go under), so a write
 * meanwhile at that epoch (a new folder, an upload, a copy, a move or a
 * restore that re-wraps a key, into a folder this tab listed after another
 * device re-keyed it) could seal its key under one that the other device's
 * win then makes the server refuse: the server takes the write, the walk's
 * key is dropped, and the write opens for nobody. Such a write derives its key
 * only outside the window, after the batch's keys were committed or dropped:
 * at most one batch's round trip later, and with the key it would have had
 * with no walk running.
 *
 * Only a write naming the folder at the walk's target waits. One naming the
 * folder's earlier epoch never reaches the pending key (the ledger wraps it
 * under the folder's key at that epoch, as with no walk running) and goes at
 * once, as it always did: held back, it would only reach the server after the
 * batch re-keyed the folder and be refused as stale.
 *
 * Held per worker: the rpc is the tab's worker, which the personal Drive
 * client, every family folder's client and the transfer engine share. Only
 * the key derivation is held, never the request that sends what it sealed.
 */
const byWorker = new WeakMap<Rpc, Map<string, Promise<void>>>();

/* A folder at a key epoch: what a walk's batch holds, and what a write's key is wrapped under. */
export type HeldFolder = { id: string; keyEpoch: number };

/*
 * Takes `folders` in `workspaceId` once no one else holds any of them at the
 * same epoch, all at once, so a batch and a write never wait on each other in
 * a circle; the returned function releases them. A walk's batch holds the
 * nodes it may re-key at its target, a write the folder its key is wrapped
 * under at the epoch it names.
 */
export async function takeFolders(
    rpc: Rpc,
    workspaceId: string,
    folders: Iterable<HeldFolder>,
): Promise<() => void> {
    let held = byWorker.get(rpc);
    if (!held) byWorker.set(rpc, (held = new Map()));
    const slots = [...new Set([...folders].map((f) => `${workspaceId}/${f.id}@${f.keyEpoch}`))];
    for (;;) {
        const busy = slots.flatMap((at) => held.get(at) ?? []);
        if (!busy.length) break;
        await Promise.race(busy);
    }
    let release!: () => void;
    const done = new Promise<void>((resolve) => (release = resolve));
    for (const at of slots) held.set(at, done);
    return () => {
        for (const at of slots) if (held.get(at) === done) held.delete(at);
        release();
    };
}

/* Runs `body` holding `folder` (takeFolders), and lets it go however it ends. */
export async function holdFolder<T>(
    rpc: Rpc,
    workspaceId: string,
    folder: HeldFolder,
    body: () => Promise<T>,
): Promise<T> {
    const release = await takeFolders(rpc, workspaceId, [folder]);
    try {
        return await body();
    } finally {
        release();
    }
}

import type { DBSchema } from 'idb';
import { cachedConnection } from './connection';
import type { NodeChange, NodeView } from './api';

/*
 * The tree mirror: every node of a workspace as the server serves it, kept on
 * this device so the catalogue can be rebuilt without the network and so an
 * interrupted build resumes where it stopped. Rows are envelopes and ids, the
 * same bytes the server holds; no name or key ever lands here. A page of the
 * change feed and the cursor it advances to are written in one transaction,
 * so the cursor never claims a page that was not kept.
 *
 * One workspace lives here at a time: opening another drops the rows of the
 * one before, so a shared machine never keeps two accounts' trees side by side.
 */

export interface TreeMirror {
    /* The last change sequence applied for this workspace; 0 when nothing has been. */
    cursor(workspaceId: string): Promise<number>;
    /*
     * Applies a page of the feed asked for from `from` and advances the cursor to
     * `nextCursor`, atomically; true when it did. Every tab of this device writes here, each
     * pulling from where its own catalogue stands, so changes at or below the cursor are
     * already here or newer and are left alone: a slow page never puts back what another tab
     * moved on or deleted. A page asked for from past the cursor is refused, since the mirror
     * was cleared after it was asked for and the cursor would claim the gap: the caller pulls
     * again from the cursor.
     */
    apply(
        workspaceId: string,
        from: number,
        changes: NodeChange[],
        nextCursor: number,
    ): Promise<boolean>;
    rows(workspaceId: string): Promise<NodeView[]>;
    /*
     * Drops every row below these nodes, which the feed tombstoned. The server purges a
     * folder's contents later, a level at a time, and tombstones each as it goes; nothing can
     * reach them meanwhile, so they leave now rather than linger as rows without a parent
     * (which a build would take for a missed page and start over), whether or not this
     * device held the folder itself (a pull from nothing gets the contents, then the folder's
     * tombstone). One read of the whole workspace in a write transaction, once per pull that
     * carried tombstones: while the server empties a deleted folder, that is once a poll in
     * every visible tab.
     */
    dropBelow(workspaceId: string, nodeIds: string[]): Promise<void>;
    /* The rows and the cursor they stand at, read together: another tab may clear in between. */
    snapshot(workspaceId: string): Promise<{ cursor: number; rows: NodeView[] }>;
    /* Forgets everything about `workspaceId`, or every workspace when none is named. */
    clear(workspaceId?: string): Promise<void>;
    /* Every workspace with rows or a cursor here. */
    workspaces(): Promise<string[]>;
}

interface Schema extends DBSchema {
    nodes: { key: string; value: NodeView; indexes: { workspace: string } };
    cursors: { key: string; value: { workspaceId: string; cursor: number } };
}

/* What sits below `nodeIds` among `rows`, at any depth. */
function purgedBelow(nodeIds: string[], rows: NodeView[]) {
    const children = new Map<string, string[]>();
    for (const row of rows)
        if (row.parentId) {
            const list = children.get(row.parentId) ?? [];
            list.push(row.id);
            children.set(row.parentId, list);
        }
    const gone: string[] = [];
    const queue = [...nodeIds];
    for (let index = 0; index < queue.length; index++)
        for (const child of children.get(queue[index]!) ?? []) {
            gone.push(child);
            queue.push(child);
        }
    return gone;
}

export function createIndexedDbMirror(name = 'hushos-drive-mirror'): TreeMirror {
    // Another tab, or this one, deleting the database (a family wiped from this device, sign-out)
    // makes it let go at once rather than block that; the next read opens it again.
    const open = cachedConnection<Schema>(name, 1, (db) => {
        db.createObjectStore('nodes', { keyPath: 'id' }).createIndex('workspace', 'workspaceId');
        db.createObjectStore('cursors', { keyPath: 'workspaceId' });
    });
    return {
        async cursor(workspaceId) {
            const db = await open();
            return (await db.get('cursors', workspaceId))?.cursor ?? 0;
        },
        async apply(workspaceId, from, changes, nextCursor) {
            const db = await open();
            const tx = db.transaction(['nodes', 'cursors'], 'readwrite');
            const nodes = tx.objectStore('nodes');
            const cursors = tx.objectStore('cursors');
            const current = (await cursors.get(workspaceId))?.cursor ?? 0;
            if (from > current) {
                await tx.done;
                return false;
            }
            for (const change of changes) {
                if (change.changeSeq <= current) continue;
                if (change.kind === 'node') await nodes.put(change.node);
                else if (change.kind === 'tombstone') await nodes.delete(change.nodeId);
            }
            await cursors.put({ workspaceId, cursor: Math.max(current, nextCursor) });
            await tx.done;
            return true;
        },
        async rows(workspaceId) {
            const db = await open();
            return db.getAllFromIndex('nodes', 'workspace', workspaceId);
        },
        async dropBelow(workspaceId, nodeIds) {
            if (!nodeIds.length) return;
            const db = await open();
            const tx = db.transaction('nodes', 'readwrite');
            const rows = await tx.store.index('workspace').getAll(workspaceId);
            for (const id of purgedBelow(nodeIds, rows)) await tx.store.delete(id);
            await tx.done;
        },
        async snapshot(workspaceId) {
            const db = await open();
            const tx = db.transaction(['nodes', 'cursors']);
            const cursor = (await tx.objectStore('cursors').get(workspaceId))?.cursor ?? 0;
            const rows = await tx.objectStore('nodes').index('workspace').getAll(workspaceId);
            await tx.done;
            return { cursor, rows };
        },
        async clear(workspaceId) {
            const db = await open();
            const tx = db.transaction(['nodes', 'cursors'], 'readwrite');
            if (workspaceId === undefined) {
                await tx.objectStore('nodes').clear();
                await tx.objectStore('cursors').clear();
            } else {
                const index = tx.objectStore('nodes').index('workspace');
                let cursor = await index.openKeyCursor(workspaceId);
                while (cursor) {
                    await tx.objectStore('nodes').delete(cursor.primaryKey);
                    cursor = await cursor.continue();
                }
                await tx.objectStore('cursors').delete(workspaceId);
            }
            await tx.done;
        },
        async workspaces() {
            const db = await open();
            return (await db.getAll('cursors')).map((row) => row.workspaceId);
        },
    };
}

/* The same contract in memory, for tests and for browsers without IndexedDB. */
export function createMemoryMirror(): TreeMirror {
    const nodes = new Map<string, NodeView>();
    const cursors = new Map<string, number>();
    return {
        async cursor(workspaceId) {
            return cursors.get(workspaceId) ?? 0;
        },
        async apply(workspaceId, from, changes, nextCursor) {
            const current = cursors.get(workspaceId) ?? 0;
            if (from > current) return false;
            for (const change of changes) {
                if (change.changeSeq <= current) continue;
                if (change.kind === 'node') nodes.set(change.node.id, change.node);
                else if (change.kind === 'tombstone') nodes.delete(change.nodeId);
            }
            cursors.set(workspaceId, Math.max(current, nextCursor));
            return true;
        },
        async rows(workspaceId) {
            return [...nodes.values()].filter((node) => node.workspaceId === workspaceId);
        },
        async dropBelow(workspaceId, nodeIds) {
            const held = [...nodes.values()].filter((node) => node.workspaceId === workspaceId);
            for (const id of purgedBelow(nodeIds, held)) nodes.delete(id);
        },
        async snapshot(workspaceId) {
            return {
                cursor: cursors.get(workspaceId) ?? 0,
                rows: [...nodes.values()].filter((node) => node.workspaceId === workspaceId),
            };
        },
        async clear(workspaceId) {
            for (const [id, node] of nodes)
                if (workspaceId === undefined || node.workspaceId === workspaceId) nodes.delete(id);
            if (workspaceId === undefined) cursors.clear();
            else cursors.delete(workspaceId);
        },
        async workspaces() {
            return [...cursors.keys()];
        },
    };
}

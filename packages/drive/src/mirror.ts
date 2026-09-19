import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
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
    /* Applies a page and advances the cursor to `nextCursor`, atomically. */
    apply(workspaceId: string, changes: NodeChange[], nextCursor: number): Promise<void>;
    rows(workspaceId: string): Promise<NodeView[]>;
    /* Forgets everything about `workspaceId`, or every workspace when none is named. */
    clear(workspaceId?: string): Promise<void>;
    /* Every workspace with rows or a cursor here. */
    workspaces(): Promise<string[]>;
}

interface Schema extends DBSchema {
    nodes: { key: string; value: NodeView; indexes: { workspace: string } };
    cursors: { key: string; value: { workspaceId: string; cursor: number } };
}

export function createIndexedDbMirror(name = 'hushos-drive-mirror'): TreeMirror {
    let database: Promise<IDBPDatabase<Schema>> | undefined;
    const open = () =>
        (database ??= openDB<Schema>(name, 1, {
            upgrade(db) {
                db.createObjectStore('nodes', { keyPath: 'id' }).createIndex(
                    'workspace',
                    'workspaceId',
                );
                db.createObjectStore('cursors', { keyPath: 'workspaceId' });
            },
        }));
    return {
        async cursor(workspaceId) {
            const db = await open();
            return (await db.get('cursors', workspaceId))?.cursor ?? 0;
        },
        async apply(workspaceId, changes, nextCursor) {
            const db = await open();
            const tx = db.transaction(['nodes', 'cursors'], 'readwrite');
            const nodes = tx.objectStore('nodes');
            for (const change of changes) {
                if (change.kind === 'node') await nodes.put(change.node);
                else if (change.kind === 'tombstone') await nodes.delete(change.nodeId);
            }
            const current = (await tx.objectStore('cursors').get(workspaceId))?.cursor ?? 0;
            await tx
                .objectStore('cursors')
                .put({ workspaceId, cursor: Math.max(current, nextCursor) });
            await tx.done;
        },
        async rows(workspaceId) {
            const db = await open();
            return db.getAllFromIndex('nodes', 'workspace', workspaceId);
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
        async apply(workspaceId, changes, nextCursor) {
            for (const change of changes) {
                if (change.kind === 'node') nodes.set(change.node.id, change.node);
                else if (change.kind === 'tombstone') nodes.delete(change.nodeId);
            }
            cursors.set(workspaceId, Math.max(cursors.get(workspaceId) ?? 0, nextCursor));
        },
        async rows(workspaceId) {
            return [...nodes.values()].filter((node) => node.workspaceId === workspaceId);
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

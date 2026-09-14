import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

/*
 * The upload journal from the design: what a device remembers about an upload
 * so it can continue after a reload or a lock. Every entry holds the ids, the
 * content-key envelope and nonce (opaque without the node key, which the worker
 * reopens from the tree), the source file's identity, and per part the plaintext
 * digest, written with strict durability and awaited before that part's
 * ciphertext leaves the machine. A journal that cannot be trusted never resumes:
 * the upload starts over with fresh material instead.
 *
 * A second, lighter row is written the moment a file is queued, before the
 * server has heard of it, so that a reload forgets nothing: every file that was
 * waiting comes back and asks for its bytes. Copies of shared files have no file
 * on the person's disk; their bytes are stashed in the browser's private storage
 * and the row names the stash so they continue without being asked.
 */

export type JournalPart = { digest: string; etag?: string; bytes?: number };

/* Where an upload's bytes came from: a file the person holds, or a copy of something shared. */
export type UploadOrigin = 'file' | 'copy';

export type JournalEntry = {
    id: string;
    workspaceId: string;
    uploadId: string;
    nodeId: string;
    versionId: string;
    objectId: string;
    parentId: string;
    parentName: string;
    parentKeyEpoch: number;
    keyEpoch: number;
    /* The name in Drive, when a person chose one different from the file's own. */
    name?: string;
    newNode: boolean;
    /* The version begin expected to be current, so a conflict can tell an epoch race from a version race. */
    expectedVersionId?: string | null;
    /* The new file node's envelopes, so its key can be reopened before its content key. */
    node: { keyEnvelope: string; metadataEnvelope: string; metadataVersion: number } | null;
    contentKeyEnvelope: string;
    contentNonce: string;
    /* The object's content suite; a row without one predates suite 2 and cannot be resumed. */
    contentSuite?: number;
    /*
     * The sealed thumbnail trailer as the worker produced it at begin, or null for
     * a file without one. Ciphertext, never the image: a resumed last part appends
     * these same bytes, so the thumbnail is encrypted once under its nonce.
     */
    thumbnail?: Uint8Array | null;
    /* The object's declared size, trailer included: what the server reserved and will verify. */
    ciphertextSize?: number;
    file: { name: string; size: number; lastModified: number; type: string };
    /* Chromium keeps file handles across reloads; elsewhere the person picks the file again. */
    handle: FileSystemFileHandle | null;
    /* Absent on rows written before copies were journaled: a file the person holds. */
    origin?: UploadOrigin;
    /* The stash holding this upload's bytes on this device, when it has one. */
    stash?: string | null;
    parts: Record<string, JournalPart>;
    expiresAt: string;
    createdAt: number;
    updatedAt: number;
};

/* A file waiting in the queue: enough to ask for it again, nothing the server knows yet. */
export type QueuedEntry = {
    id: string;
    workspaceId: string;
    parentId: string;
    parentName: string;
    name: string;
    /* The file whose next version this upload is, or null for a new file. */
    replacesId: string | null;
    file: { name: string; size: number; lastModified: number; type: string };
    handle: FileSystemFileHandle | null;
    origin: UploadOrigin;
    stash: string | null;
    createdAt: number;
    updatedAt: number;
};

export interface UploadJournal {
    list(workspaceId: string): Promise<JournalEntry[]>;
    /* Every entry, whichever workspace: a person's own uploads and those into folders shared with them. */
    listAll(): Promise<JournalEntry[]>;
    put(entry: JournalEntry): Promise<void>;
    /* Read-modify-write of one entry; a missing entry is left missing. */
    update(id: string, patch: (entry: JournalEntry) => JournalEntry): Promise<void>;
    remove(id: string): Promise<void>;
    listQueued(workspaceId?: string): Promise<QueuedEntry[]>;
    putQueued(entry: QueuedEntry): Promise<void>;
    removeQueued(id: string): Promise<void>;
}

interface Schema extends DBSchema {
    uploads: { key: string; value: JournalEntry; indexes: { workspace: string } };
    queued: { key: string; value: QueuedEntry; indexes: { workspace: string } };
}

export function createIndexedDbJournal(name = 'hushos-drive'): UploadJournal {
    let database: Promise<IDBPDatabase<Schema>> | undefined;
    const open = () =>
        (database ??= openDB<Schema>(name, 2, {
            upgrade(db) {
                if (!db.objectStoreNames.contains('uploads'))
                    db.createObjectStore('uploads', { keyPath: 'id' }).createIndex(
                        'workspace',
                        'workspaceId',
                    );
                if (!db.objectStoreNames.contains('queued'))
                    db.createObjectStore('queued', { keyPath: 'id' }).createIndex(
                        'workspace',
                        'workspaceId',
                    );
            },
        }));
    return {
        async list(workspaceId) {
            const db = await open();
            return db.getAllFromIndex('uploads', 'workspace', workspaceId);
        },
        async listAll() {
            const db = await open();
            return db.getAll('uploads');
        },
        async put(entry) {
            const db = await open();
            const tx = db.transaction('uploads', 'readwrite', { durability: 'strict' });
            await tx.store.put(entry);
            await tx.done;
        },
        async update(id, patch) {
            const db = await open();
            const tx = db.transaction('uploads', 'readwrite', { durability: 'strict' });
            const current = await tx.store.get(id);
            if (current) await tx.store.put({ ...patch(current), updatedAt: Date.now() });
            await tx.done;
        },
        async remove(id) {
            const db = await open();
            const tx = db.transaction('uploads', 'readwrite', { durability: 'strict' });
            await tx.store.delete(id);
            await tx.done;
        },
        async listQueued(workspaceId) {
            const db = await open();
            return workspaceId
                ? db.getAllFromIndex('queued', 'workspace', workspaceId)
                : db.getAll('queued');
        },
        async putQueued(entry) {
            const db = await open();
            const tx = db.transaction('queued', 'readwrite', { durability: 'strict' });
            await tx.store.put(entry);
            await tx.done;
        },
        async removeQueued(id) {
            const db = await open();
            const tx = db.transaction('queued', 'readwrite', { durability: 'strict' });
            await tx.store.delete(id);
            await tx.done;
        },
    };
}

/* For tests and for browsers without IndexedDB: remembers nothing across reloads. */
export function createMemoryJournal(): UploadJournal & {
    entries: Map<string, JournalEntry>;
    queued: Map<string, QueuedEntry>;
} {
    const entries = new Map<string, JournalEntry>();
    const queued = new Map<string, QueuedEntry>();
    return {
        entries,
        queued,
        async list(workspaceId) {
            return [...entries.values()].filter((entry) => entry.workspaceId === workspaceId);
        },
        async listAll() {
            return [...entries.values()];
        },
        async put(entry) {
            entries.set(entry.id, structuredClone(entry));
        },
        async update(id, patch) {
            const current = entries.get(id);
            if (current)
                entries.set(id, { ...patch(structuredClone(current)), updatedAt: Date.now() });
        },
        async remove(id) {
            entries.delete(id);
        },
        async listQueued(workspaceId) {
            return [...queued.values()].filter(
                (entry) => !workspaceId || entry.workspaceId === workspaceId,
            );
        },
        async putQueued(entry) {
            queued.set(entry.id, structuredClone(entry));
        },
        async removeQueued(id) {
            queued.delete(id);
        },
    };
}

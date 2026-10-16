import { STORED_ACCEPTANCE } from './accepted';
import {
    acceptStored,
    storedCacheOf,
    type StoredChain,
    type StoredChainCache,
} from './group-trust';
import type { GroupPublicKey, SignedGroupStatement } from './groups';

/*
 * The server's side of the group core (group milestone 1b): acceptance of the
 * history it stores. Server-only: an app that imports this module is refused
 * at load, and apps/web checks that no browser module imports it
 * (src/lib/server-imports.test.ts). Its chains are StoredChains, which no
 * seal, opening or verdict takes: a reader always accepts with its own marks
 * (acceptRosters). The Rust core has no twin: no app accepts as the server.
 */
if (
    typeof document !== 'undefined' ||
    typeof (globalThis as { WorkerGlobalScope?: unknown }).WorkerGlobalScope !== 'undefined'
)
    throw new Error('The server’s group acceptance was imported into a browser build.');

/*
 * Accepts the stored history from the version 1 keys the server stored at the
 * group's creation (no words check, no pins, no reader), continuing from
 * `cache` (the last StoredChain's) when given. Every rule a device applies
 * holds; a stored history that conflicts with its own cache is refused.
 */
export async function acceptStoredChain(input: {
    groupId: string;
    firstKeys: GroupPublicKey;
    rosters: SignedGroupStatement[];
    successions: SignedGroupStatement[];
    mlDsaKeys: Record<string, string>;
    cache: StoredChainCache | null;
}): Promise<StoredChain> {
    return acceptStored(input, STORED_ACCEPTANCE);
}

/*
 * The record the server keeps to continue from next time: a StoredChain's
 * cache, marked as the server's, which a reader's acceptance refuses.
 */
export function storedRecord(chain: StoredChain): StoredChainCache {
    return storedCacheOf(chain, STORED_ACCEPTANCE);
}

export type { StoredChain, StoredChainCache };

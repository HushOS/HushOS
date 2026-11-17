/*
 * What the page and the archive's tools worker say to each other while a zip is open in the
 * viewer (docs/file-tools-design.md, section 1 (a)). Browsing is a viewer, not a run: it never
 * takes the one-run slot (lib/tools/run.ts), but it keeps the harness's rules. The worker holds no
 * keys and reads the archive only by range through the page (lib/tools/ranges.ts); it holds the
 * password, if one was typed, until the page terminates it. The page trusts nothing it says:
 * every message is read once and its checked fields copied out (session.ts).
 *
 * Imports nothing, so both sides can share it.
 */

export type ToArchive =
    /* Once, first: the archive's size and the port its ranges are read over. */
    | { type: 'open'; size: number; port: MessagePort }
    /* `index`: the entry whose password this is, tried first. */
    | { type: 'unlock'; id: number; password: string; index: number | null }
    /* The entry inflated whole, at most `limit` bytes; or, for a stored one, where it is. */
    | { type: 'preview'; id: number; index: number; limit: number }
    /* `port`: the download's own reads, served and counted apart from the archive's. */
    | { type: 'download'; id: number; index: number; port?: MessagePort }
    /* The page has taken the last chunk of download `id`: the next may come. */
    | { type: 'more'; id: number }
    | { type: 'stop'; id: number };

/* One entry of the list, as the worker sends it: plain values the page checks one by one. */
export type WireEntry = {
    index: number;
    path: string;
    /* Its folder (`parents` and `names` of the listing; 0 is the top) and its name there. */
    folder: number;
    name: string;
    directory: boolean;
    size: number;
    packed: number;
    dos: number;
    mtime: number | null;
    lock: 'none' | 'zipcrypto' | 'aes' | 'other';
    support: 'ok' | 'method' | 'encryption';
    link: boolean;
    nested: boolean;
    hidden: boolean;
    stored: boolean;
    saveName: string;
};

export type FromArchive =
    /* `parents` and `names`: the folders, as zip-format.ts's Folders. */
    | { type: 'listing'; entries: WireEntry[]; hidden: number; parents: Uint32Array; names: string }
    | { type: 'progress'; id: number }
    | { type: 'unlocked'; id: number; ok: boolean }
    | { type: 'bytes'; id: number; bytes: ArrayBuffer }
    | { type: 'span'; id: number; offset: number; size: number }
    | { type: 'chunk'; id: number; bytes: ArrayBuffer }
    | { type: 'end'; id: number }
    /* `id` null: the listing failed. `code` is a refusal (zip-format.ts) the page has words for. */
    | { type: 'fail'; id: number | null; code: string };

/* A download's chunks are gathered to about this size before they cross to the page. */
export const CHUNK_BYTES = 1024 * 1024;

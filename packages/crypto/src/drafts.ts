import { decryptKey, encryptKey } from './aead';
import { encodeStatement, uuid } from './canonical';
import { deriveStoreKey } from './device-store';
import { CryptoError } from './errors';
import { decode, encode } from './keys';

/*
 * An editor's unsaved text, sealed on the device it was typed on (docs/editing-design.md 3,
 * "Draft"; the twin of crates/hushos-core/src/drafts.rs, held to it by
 * crates/hushos-core/fixtures/drafts.json).
 *
 * Key: HKDF-SHA-256 of the account root, salt 32 zero bytes, info the compact JSON
 * ["hushos/drafts/v1",userId,workspaceId,nodeId], so each file has its own key and only an
 * unlocked session of this account derives it; nothing is stored that a locked device could
 * open the text with. The workspace is in it as well as the node: ids are a node table's by
 * workspace and node, and a share's node named like one of the account's own files must never
 * be offered that file's text. Under the root, not the settings key: a master-key rotation makes
 * older drafts unreadable, and they are dropped.
 *
 * Slot: where the record is kept, the first 16 bytes of the same HKDF under
 * ["hushos/drafts/slot/v1",userId,workspaceId,nodeId], base64url. Keyed, so the store says which
 * files have a draft to no one without the unlocked account.
 *
 * Record: compact JSON {v, base, encoding, lineEnding, mixed, savedAt, sealed}. What the restore
 * needs before it opens anything (the version the text started from, the save format, the time)
 * is beside the envelope, and the associated data
 * ["hushos/drafts",1,userId,workspaceId,nodeId,base,encoding,lineEnding,mixed,savedAt] binds it,
 * so a record moved to another file or account, given another base version or another format, or
 * another time, does not open.
 *
 * Envelope: [1][24-byte nonce][XChaCha20-Poly1305], base64url: the device store's layout
 * (device-store.ts). Plaintext: the selection's ends (`from`, where it began, and `to`, where the cursor is) as 32-bit big-endian UTF-16
 * offsets (0xFFFFFFFF for none), then the text in UTF-8.
 *
 * Runs in the crypto worker (session.ts, driveDraftSeal and friends): the root never reaches
 * the page.
 */

export const DRAFT_LABEL = 'hushos/drafts/v1';
export const DRAFT_SLOT_LABEL = 'hushos/drafts/slot/v1';
const DOMAIN = 'hushos/drafts';
export const DRAFT_VERSION = 1;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const NO_OFFSET = 0xffffffff;

/* The editor's own limit (TEXT_EDIT_LIMIT): a draft holds at most this much text, in UTF-8 bytes. */
export const DRAFT_TEXT_LIMIT = 8 * 1024 * 1024;
/* Drafts kept per account on one device; the oldest go first. */
export const DRAFTS_PER_ACCOUNT = 50;
/* A draft older than this is dropped, never offered. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export const DRAFT_ENCODINGS = ['utf-8', 'utf-8-bom', 'utf-16le', 'utf-16be'] as const;
export type DraftEncoding = (typeof DRAFT_ENCODINGS)[number];
export const DRAFT_LINE_ENDINGS = ['lf', 'crlf'] as const;
export type DraftLineEnding = (typeof DRAFT_LINE_ENDINGS)[number];

/* Which file, for whom: the account, and the file by its workspace and node. */
export type DraftPlace = { userId: string; workspaceId: string; nodeId: string };

/*
 * What the restore needs before the text: the version the text started from, the session's save
 * format (kept for the whole session, never found again from what was saved), and when it was
 * written (milliseconds since the epoch).
 */
export type DraftFrame = {
    baseVersionId: string;
    encoding: DraftEncoding;
    lineEnding: DraftLineEnding;
    mixed: boolean;
    savedAt: number;
};

/* UTF-16 offsets, as CodeMirror, UITextView and EditText count them. */
export type DraftSelection = { from: number; to: number };

export type Draft = { frame: DraftFrame; text: string; selection: DraftSelection | null };

/* A draft that does not open: another account's, another file's, damaged or changed. */
export class DraftError extends CryptoError {}

const unreadable = () => new DraftError('This draft could not be opened.');

/* A surrogate without its pair: UTF-8 can't hold it, and TextEncoder would put U+FFFD in its place. */
const LONE_SURROGATE = /[\uD800-\uDFFF]/u;

function place({ userId, workspaceId, nodeId }: DraftPlace) {
    return {
        userId: uuid(userId.toLowerCase(), 'user id'),
        workspaceId: uuid(workspaceId.toLowerCase(), 'workspace id'),
        nodeId: uuid(nodeId.toLowerCase(), 'node id'),
    };
}

/* The info a draft's key is derived under: the label, then whose and which file. */
export function draftKeyInfo(where: DraftPlace) {
    const { userId, workspaceId, nodeId } = place(where);
    return new TextDecoder().decode(encodeStatement([DRAFT_LABEL, userId, workspaceId, nodeId]));
}

function slotInfo(where: DraftPlace) {
    const { userId, workspaceId, nodeId } = place(where);
    return new TextDecoder().decode(
        encodeStatement([DRAFT_SLOT_LABEL, userId, workspaceId, nodeId]),
    );
}

function rootOf(root: Uint8Array) {
    if (root.byteLength !== 32) throw new CryptoError('Invalid account key.');
    return root.slice() as Uint8Array<ArrayBuffer>;
}

/* The file's draft key, raw: the caller zeroes it. */
export async function draftKey(root: Uint8Array, where: DraftPlace) {
    const material = rootOf(root);
    try {
        return await deriveStoreKey(material, draftKeyInfo(where));
    } finally {
        material.fill(0);
    }
}

/* Where the file's draft is kept: a name that needs the unlocked account to work out. */
export async function draftSlot(root: Uint8Array, where: DraftPlace) {
    const material = rootOf(root);
    try {
        const derived = await deriveStoreKey(material, slotInfo(where));
        const slot = encode(derived.subarray(0, 16));
        derived.fill(0);
        return slot;
    } finally {
        material.fill(0);
    }
}

function frameOf(frame: DraftFrame): DraftFrame {
    if (!DRAFT_ENCODINGS.includes(frame.encoding)) throw new CryptoError('Invalid encoding.');
    if (!DRAFT_LINE_ENDINGS.includes(frame.lineEnding))
        throw new CryptoError('Invalid line ending.');
    if (typeof frame.mixed !== 'boolean') throw new CryptoError('Invalid line ending.');
    if (!Number.isSafeInteger(frame.savedAt) || frame.savedAt < 0)
        throw new CryptoError('Invalid draft time.');
    return {
        baseVersionId: uuid(frame.baseVersionId.toLowerCase(), 'version id'),
        encoding: frame.encoding,
        lineEnding: frame.lineEnding,
        mixed: frame.mixed,
        savedAt: frame.savedAt,
    };
}

/* The associated data: the record's frame, bound to its account and file. */
export function draftContext(where: DraftPlace, frame: DraftFrame) {
    const { userId, workspaceId, nodeId } = place(where);
    const checked = frameOf(frame);
    return encodeStatement([
        DOMAIN,
        DRAFT_VERSION,
        userId,
        workspaceId,
        nodeId,
        checked.baseVersionId,
        checked.encoding,
        checked.lineEnding,
        checked.mixed ? 1 : 0,
        checked.savedAt,
    ]);
}

function offset(value: number) {
    if (!Number.isInteger(value) || value < 0 || value >= NO_OFFSET)
        throw new CryptoError('Invalid selection.');
    return value;
}

/* The plaintext: the selection, then the text in UTF-8. Refused past the limit or with half a character. */
export function draftPlaintext(text: string, selection: DraftSelection | null) {
    if (LONE_SURROGATE.test(text))
        throw new CryptoError('This text has half of a character in it.');
    const body = new TextEncoder().encode(text);
    if (body.byteLength > DRAFT_TEXT_LIMIT)
        throw new CryptoError('This text is too large to keep.');
    const out = new Uint8Array(8 + body.byteLength);
    const view = new DataView(out.buffer);
    view.setUint32(0, selection ? offset(selection.from) : NO_OFFSET);
    view.setUint32(4, selection ? offset(selection.to) : NO_OFFSET);
    out.set(body, 8);
    return out;
}

/* The record, as stored: the frame beside the envelope. `nonce` is for the fixtures only. */
export async function sealDraft(
    root: Uint8Array,
    where: DraftPlace,
    draft: Draft,
    nonce: Uint8Array = crypto.getRandomValues(new Uint8Array(NONCE_BYTES)),
) {
    if (nonce.byteLength !== NONCE_BYTES) throw new CryptoError('Invalid nonce.');
    const frame = frameOf(draft.frame);
    const context = draftContext(where, frame);
    const plaintext = draftPlaintext(draft.text, draft.selection);
    const key = await draftKey(root, where);
    try {
        const sealed = await encryptKey(plaintext, key, nonce, context);
        const envelope = new Uint8Array(1 + NONCE_BYTES + sealed.byteLength);
        envelope[0] = DRAFT_VERSION;
        envelope.set(nonce, 1);
        envelope.set(sealed, 1 + NONCE_BYTES);
        return JSON.stringify({
            v: DRAFT_VERSION,
            base: frame.baseVersionId,
            encoding: frame.encoding,
            lineEnding: frame.lineEnding,
            mixed: frame.mixed,
            savedAt: frame.savedAt,
            sealed: encode(envelope),
        });
    } finally {
        key.fill(0);
        plaintext.fill(0);
    }
}

type Parsed = { frame: DraftFrame; envelope: Uint8Array };

function parse(record: string): Parsed {
    let value: unknown;
    try {
        value = JSON.parse(record);
    } catch {
        throw unreadable();
    }
    if (typeof value !== 'object' || value === null) throw unreadable();
    const fields = value as Record<string, unknown>;
    if (fields.v !== DRAFT_VERSION || typeof fields.sealed !== 'string') throw unreadable();
    let frame: DraftFrame;
    let envelope: Uint8Array;
    try {
        frame = frameOf({
            baseVersionId: String(fields.base),
            encoding: fields.encoding as DraftEncoding,
            lineEnding: fields.lineEnding as DraftLineEnding,
            mixed: fields.mixed as boolean,
            savedAt: fields.savedAt as number,
        });
        envelope = decode(fields.sealed);
    } catch {
        throw unreadable();
    }
    if (envelope.byteLength < 1 + NONCE_BYTES + TAG_BYTES + 8 || envelope[0] !== DRAFT_VERSION)
        throw unreadable();
    return { frame, envelope };
}

/* When a record was written, read without a key (for the caps); null for one that doesn't parse. */
export function draftSavedAt(record: string) {
    try {
        return parse(record).frame.savedAt;
    } catch {
        return null;
    }
}

/* The draft a record holds for this account and file, or a DraftError: never "none". */
export async function openDraft(root: Uint8Array, where: DraftPlace, record: string) {
    const { frame, envelope } = parse(record);
    const context = draftContext(where, frame);
    const key = await draftKey(root, where);
    let plaintext: Uint8Array;
    try {
        plaintext = await decryptKey(
            envelope.subarray(1 + NONCE_BYTES),
            key,
            envelope.subarray(1, 1 + NONCE_BYTES),
            context,
        );
    } catch {
        throw unreadable();
    } finally {
        key.fill(0);
    }
    try {
        const view = new DataView(plaintext.buffer, plaintext.byteOffset, plaintext.byteLength);
        const from = view.getUint32(0);
        const to = view.getUint32(4);
        if ((from === NO_OFFSET) !== (to === NO_OFFSET)) throw unreadable();
        let text: string;
        try {
            text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                plaintext.subarray(8),
            );
        } catch {
            throw unreadable();
        }
        const draft: Draft = {
            frame,
            text,
            selection: from === NO_OFFSET ? null : { from, to },
        };
        return draft;
    } finally {
        plaintext.fill(0);
    }
}

/*
 * What reopening a file does with its draft:
 * - `same`: the text is what the file holds now; the draft is dropped, nothing offered.
 * - `current`: the file is still at the version the text started from; restored as an edit.
 * - `stale`: someone saved since (or the version can't be told); restored only through the stale
 *   choices, never as an edit of their version.
 */
export type DraftOffer = 'same' | 'current' | 'stale';

export function draftOffer(
    draft: { baseVersionId: string; text: string },
    opened: { versionId: string | null; text: string },
): DraftOffer {
    if (draft.text === opened.text) return 'same';
    if (opened.versionId !== null && opened.versionId.toLowerCase() === draft.baseVersionId)
        return 'current';
    return 'stale';
}

/* One stored draft, by its slot, and when it was written (null: unreadable, dropped first). */
export type DraftEntry = { slot: string; savedAt: number | null };

/*
 * The slots to delete so what is left keeps the caps: anything unreadable, anything older than
 * DRAFT_MAX_AGE_MS, then the oldest past DRAFTS_PER_ACCOUNT. `keep` (the draft being written) is
 * never dropped, and counts.
 */
export function draftsToDrop(entries: readonly DraftEntry[], now: number, keep?: string) {
    const drop = new Set<string>();
    const kept: { slot: string; savedAt: number }[] = [];
    for (const entry of entries) {
        if (entry.slot === keep) continue;
        if (entry.savedAt === null || now - entry.savedAt > DRAFT_MAX_AGE_MS) drop.add(entry.slot);
        else kept.push({ slot: entry.slot, savedAt: entry.savedAt });
    }
    const room = DRAFTS_PER_ACCOUNT - (keep === undefined ? 0 : 1);
    // Newest first; ties by slot, so every client drops the same ones.
    kept.sort((a, b) => b.savedAt - a.savedAt || (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
    for (const entry of kept.slice(Math.max(room, 0))) drop.add(entry.slot);
    return [...drop].sort();
}

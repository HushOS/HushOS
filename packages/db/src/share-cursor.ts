import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { serverHashKey } from './hash-key';

/*
 * A grantee's change-feed cursor: the owner's workspace change sequence it has
 * read up to, sealed so the grantee learns nothing from it. A bare sequence
 * number would tell a grantee how busy the owner's drive is outside the share;
 * sealed under a key only the server holds, with a fresh nonce every time, two
 * cursors say nothing about how far apart they are. The share id is bound in
 * as associated data, so a cursor from one share is refused on another, and
 * any change to a cursor fails to open.
 *
 * AES-256-GCM under a key derived from the server hash key (see hash-key.ts):
 * shared by every process when OPAQUE_SERVER_SETUP is set; otherwise per
 * process, and a cursor from another process is refused like a tampered one,
 * which a client answers by starting the feed over.
 */
const INFO = 'hushos/drive/share-feed-cursor/v1';
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BODY_BYTES = 8;
const CURSOR_BYTES = NONCE_BYTES + BODY_BYTES + TAG_BYTES;
export const SHARE_CURSOR_PATTERN = /^[A-Za-z0-9_-]{48}$/;

let key: Buffer | undefined;
function cursorKey() {
    key ??= Buffer.from(hkdfSync('sha256', serverHashKey(), Buffer.alloc(0), INFO, 32));
    return key;
}
const context = (shareId: string) => Buffer.from(`${INFO}:${shareId.toLowerCase()}`, 'utf8');

export function sealShareCursor(shareId: string, changeSeq: number) {
    if (!Number.isSafeInteger(changeSeq) || changeSeq < 0) throw new Error('Invalid sequence.');
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', cursorKey(), nonce, { authTagLength: TAG_BYTES });
    cipher.setAAD(context(shareId));
    const body = Buffer.alloc(BODY_BYTES);
    body.writeBigUInt64BE(BigInt(changeSeq));
    const sealed = Buffer.concat([nonce, cipher.update(body), cipher.final(), cipher.getAuthTag()]);
    return sealed.toString('base64url');
}

/* The sequence a cursor sealed for this share holds, or null for anything else. */
export function openShareCursor(shareId: string, cursor: string): number | null {
    if (!SHARE_CURSOR_PATTERN.test(cursor)) return null;
    const bytes = Buffer.from(cursor, 'base64url');
    if (bytes.length !== CURSOR_BYTES || bytes.toString('base64url') !== cursor) return null;
    try {
        const decipher = createDecipheriv(
            'aes-256-gcm',
            cursorKey(),
            bytes.subarray(0, NONCE_BYTES),
            { authTagLength: TAG_BYTES },
        );
        decipher.setAAD(context(shareId));
        decipher.setAuthTag(bytes.subarray(NONCE_BYTES + BODY_BYTES));
        const body = Buffer.concat([
            decipher.update(bytes.subarray(NONCE_BYTES, NONCE_BYTES + BODY_BYTES)),
            decipher.final(),
        ]);
        const value = body.readBigUInt64BE();
        return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : null;
    } catch {
        return null;
    }
}

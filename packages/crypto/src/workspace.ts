import { CryptoError } from './errors';
import { encryptKey, decryptKey } from './aead';
import { encode, decode } from './keys';

/*
 * A workspace key is a random 32-byte key that is independent of every member's
 * account root. Each member holds a grant: the workspace key wrapped under a key
 * derived from their own root. Rotating a root rewraps that member's grants and
 * nothing beneath them; folder and file keys hang off the workspace key.
 */
export type WorkspaceKeyEnvelope = {
    version: 1;
    workspaceId: string;
    keyVersion: number;
    workspaceKeyVersion: number;
    wrappingSalt: string;
    wrappingNonce: string;
    encryptedKey: string;
};

export const WORKSPACE_ID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

async function grantWrappingKey(root: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>) {
    const key = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
        await crypto.subtle.deriveBits(
            {
                name: 'HKDF',
                hash: 'SHA-256',
                salt,
                info: new TextEncoder().encode('hushos/workspace/grant-wrap/v1'),
            },
            key,
            256,
        ),
    );
}
function grantContext(
    userId: string,
    workspaceId: string,
    keyVersion: number,
    workspaceKeyVersion: number,
) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/workspace/grant',
            1,
            userId.toLowerCase(),
            workspaceId.toLowerCase(),
            keyVersion,
            workspaceKeyVersion,
        ]),
    );
}
function checkEnvelope(envelope: WorkspaceKeyEnvelope) {
    if (
        envelope.version !== 1 ||
        !WORKSPACE_ID_PATTERN.test(envelope.workspaceId) ||
        !Number.isSafeInteger(envelope.keyVersion) ||
        envelope.keyVersion < 1 ||
        !Number.isSafeInteger(envelope.workspaceKeyVersion) ||
        envelope.workspaceKeyVersion < 1
    )
        throw new CryptoError('Unsupported workspace key envelope.');
}
async function wrapWorkspaceKey(
    workspaceKey: Uint8Array<ArrayBuffer>,
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    workspaceId: string,
    keyVersion: number,
    workspaceKeyVersion: number,
): Promise<WorkspaceKeyEnvelope> {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const nonce = crypto.getRandomValues(new Uint8Array(24));
    const wrap = await grantWrappingKey(root, salt);
    try {
        return {
            version: 1,
            workspaceId,
            keyVersion,
            workspaceKeyVersion,
            wrappingSalt: encode(salt),
            wrappingNonce: encode(nonce),
            encryptedKey: encode(
                await encryptKey(
                    workspaceKey,
                    wrap,
                    nonce,
                    grantContext(userId, workspaceId, keyVersion, workspaceKeyVersion),
                ),
            ),
        };
    } finally {
        wrap.fill(0);
    }
}

// A new workspace: a fresh random key, granted to its creator.
export async function createWorkspaceGrant(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    workspaceId: string,
    keyVersion: number,
): Promise<WorkspaceKeyEnvelope> {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId)) throw new CryptoError('Invalid workspace id.');
    const workspaceKey = crypto.getRandomValues(new Uint8Array(32));
    try {
        return await wrapWorkspaceKey(workspaceKey, root, userId, workspaceId, keyVersion, 1);
    } finally {
        workspaceKey.fill(0);
    }
}

// The caller owns the returned key and must zero it.
export async function openWorkspaceKey(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: WorkspaceKeyEnvelope,
) {
    checkEnvelope(envelope);
    const wrap = await grantWrappingKey(root, decode(envelope.wrappingSalt, 32));
    try {
        const key = await decryptKey(
            decode(envelope.encryptedKey, 48),
            wrap,
            decode(envelope.wrappingNonce, 24),
            grantContext(
                userId,
                envelope.workspaceId,
                envelope.keyVersion,
                envelope.workspaceKeyVersion,
            ),
        );
        if (key.length !== 32) {
            key.fill(0);
            throw new CryptoError('Invalid workspace key.');
        }
        return key;
    } finally {
        wrap.fill(0);
    }
}

// Master-key rotation: the same workspace key, rewrapped under the new root.
export async function rewrapWorkspaceGrant(
    oldRoot: Uint8Array<ArrayBuffer>,
    newRoot: Uint8Array<ArrayBuffer>,
    userId: string,
    envelope: WorkspaceKeyEnvelope,
    keyVersion: number,
): Promise<WorkspaceKeyEnvelope> {
    const workspaceKey = await openWorkspaceKey(oldRoot, userId, envelope);
    try {
        return await wrapWorkspaceKey(
            workspaceKey,
            newRoot,
            userId,
            envelope.workspaceId,
            keyVersion,
            envelope.workspaceKeyVersion,
        );
    } finally {
        workspaceKey.fill(0);
    }
}

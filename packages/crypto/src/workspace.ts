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
/*
 * A group area's self-grant is bound to its group under a context of its own,
 * so the personal workspace path (openWorkspaceKey) can never open one: a
 * server serving a family folder's self-grant as the personal workspace's
 * grant gets a refusal, never a workspace the group's version checks skip.
 */
function areaSelfGrantContext(
    userId: string,
    groupId: string,
    workspaceId: string,
    keyVersion: number,
    workspaceKeyVersion: number,
) {
    return new TextEncoder().encode(
        JSON.stringify([
            'hushos/group/area-self-grant',
            1,
            userId.toLowerCase(),
            groupId.toLowerCase(),
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
    context = grantContext(userId, workspaceId, keyVersion, workspaceKeyVersion),
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
            encryptedKey: encode(await encryptKey(workspaceKey, wrap, nonce, context)),
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

/*
 * A group area's self-grant (docs/envelope-migrations.md 5): the area key,
 * opened from its area grant or made for a roster call, wrapped under the
 * member's own root in the same envelope shape as a personal grant, but bound
 * to its group under its own context (areaSelfGrantContext). The caller keeps
 * and zeroes the key.
 */
export async function grantAreaKey(
    workspaceKey: Uint8Array,
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    groupId: string,
    workspaceId: string,
    keyVersion: number,
    workspaceKeyVersion: number,
): Promise<WorkspaceKeyEnvelope> {
    if (!WORKSPACE_ID_PATTERN.test(workspaceId) || !WORKSPACE_ID_PATTERN.test(groupId))
        throw new CryptoError('Invalid workspace id.');
    if (workspaceKey.length !== 32) throw new CryptoError('Invalid workspace key.');
    // A copy the caller cannot see, so it is zeroed here; the caller zeroes its own.
    const copy = Uint8Array.from(workspaceKey);
    try {
        return await wrapWorkspaceKey(
            copy,
            root,
            userId,
            workspaceId,
            keyVersion,
            workspaceKeyVersion,
            areaSelfGrantContext(userId, groupId, workspaceId, keyVersion, workspaceKeyVersion),
        );
    } finally {
        copy.fill(0);
    }
}

/* A group area's self-grant, opened only as one of `groupId`'s. The caller owns the key and zeroes it. */
export async function openAreaSelfGrant(
    root: Uint8Array<ArrayBuffer>,
    userId: string,
    groupId: string,
    envelope: WorkspaceKeyEnvelope,
) {
    checkEnvelope(envelope);
    const wrap = await grantWrappingKey(root, decode(envelope.wrappingSalt, 32));
    try {
        const key = await decryptKey(
            decode(envelope.encryptedKey, 48),
            wrap,
            decode(envelope.wrappingNonce, 24),
            areaSelfGrantContext(
                userId,
                groupId,
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

/*
 * Master-key rotation of a group area's self-grant: the same area key under the
 * new root, still bound to `groupId`. It opens only as that group's, so a
 * server naming the wrong group (or none) gets a refusal, never a rewrap under
 * another context.
 */
export async function rewrapAreaSelfGrant(
    oldRoot: Uint8Array<ArrayBuffer>,
    newRoot: Uint8Array<ArrayBuffer>,
    userId: string,
    groupId: string,
    envelope: WorkspaceKeyEnvelope,
    keyVersion: number,
): Promise<WorkspaceKeyEnvelope> {
    const workspaceKey = await openAreaSelfGrant(oldRoot, userId, groupId, envelope);
    try {
        return await grantAreaKey(
            workspaceKey,
            newRoot,
            userId,
            groupId,
            envelope.workspaceId,
            keyVersion,
            envelope.workspaceKeyVersion,
        );
    } finally {
        workspaceKey.fill(0);
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

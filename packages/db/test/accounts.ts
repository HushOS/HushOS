import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as auth from '../src/auth';
import { keysStatement } from '../src/signatures';
import type { HybridSigner } from './helpers';

/*
 * Accounts made through the repository's own registration, with sessions, for
 * suites that need the whole account (keys, recovery, credential) rather than
 * createTestAccount's bare user and workspace. The same shapes auth.test.ts
 * builds locally; fold that file onto these once the group crypto branch,
 * which edits it, has merged.
 */

const HOUR = 60 * 60 * 1000;
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest();
export const bytes = (length: number) => randomBytes(length);
export const seedOf = (label: string) => sha256(label);

/* Byte shapes the schema's length checks accept; contents are irrelevant to the repository. */
export function registration(workspaceId = randomUUID()) {
    return {
        initialQuotaBytes: 1_073_741_824n,
        name: 'Test Person',
        registrationRecord: 'record',
        profileVersion: 1,
        serverSetupId: 'primary',
        envelope: {
            envelopeVersion: 1,
            wrappingSalt: bytes(32),
            wrappingNonce: bytes(24),
            encryptedKey: bytes(48),
        },
        recovery: {
            wrappingSalt: bytes(32),
            wrappingNonce: bytes(24),
            encryptedKey: bytes(48),
            backupNonce: bytes(24),
            encryptedRecoveryKey: bytes(48),
            publicKey: bytes(32),
        },
        identity: {
            wrappingSalt: bytes(32),
            encryptionPublicKey: bytes(32),
            encryptionPrivateKeyNonce: bytes(24),
            encryptedEncryptionPrivateKey: bytes(48),
            signingPublicKey: bytes(32),
            signingSeedNonce: bytes(24),
            encryptedSigningSeed: bytes(48),
        },
        workspace: {
            id: workspaceId,
            grant: {
                keyVersion: 1,
                wrappingSalt: bytes(32),
                wrappingNonce: bytes(24),
                encryptedKey: bytes(48),
            },
        },
    };
}

/*
 * A registered account (a version 1 identity with random keys) and its personal workspace id,
 * random unless a test needs it to sort a certain way.
 */
export async function registered(
    email = `${randomUUID()}@hushos.test`,
    workspaceId: ReturnType<typeof randomUUID> = randomUUID(),
) {
    const verification = randomUUID();
    const enrollment = randomUUID();
    await auth.createEnrollment({
        purpose: 'register',
        email,
        normalizedEmail: email,
        verificationTokenHash: sha256(verification),
        expiresAt: new Date(Date.now() + HOUR),
    });
    if (
        !(await auth.verifyEnrollment(
            sha256(verification),
            sha256(enrollment),
            new Date(Date.now() + HOUR),
        ))
    )
        throw new Error('Enrollment did not verify.');
    const result = await auth.registerAccount({
        enrollmentTokenHash: sha256(enrollment),
        ...registration(workspaceId),
    });
    if (result.status !== 'created') throw new Error(`Registration ${result.status}.`);
    return { user: result.user, workspaceId };
}

/* A current session for the account; the token's hash, as the repository takes it. */
export async function signedIn(userId: string, credentialVersion = 1) {
    const token = randomUUID();
    const session = await auth.createSession({
        userId,
        credentialVersion,
        tokenHash: sha256(token),
        previousTokenHash: null,
        expiresAt: new Date(Date.now() + HOUR),
    });
    if (!session) throw new Error('Session was not created.');
    return sha256(token);
}

/* A version 2 identity row at `keyVersion` whose keys statement `signer` really signed. */
export function freshV2(userId: string, signer: HybridSigner, keyVersion: number) {
    const encryptionPublicKey = bytes(32);
    const kemPublicKey = bytes(1184);
    return {
        version: 2 as const,
        keyVersion,
        wrappingSalt: bytes(32),
        encryptionPublicKey,
        encryptionPrivateKeyNonce: bytes(24),
        encryptedEncryptionPrivateKey: bytes(48),
        signingPublicKey: signer.signingPublicKey,
        signingSeedNonce: bytes(24),
        encryptedSigningSeed: bytes(48),
        kemPublicKey,
        kemSeedNonce: bytes(24),
        encryptedKemSeed: bytes(80),
        kemSignature: null,
        mlDsaPublicKey: signer.mlDsaPublicKey,
        mlDsaSeedNonce: bytes(24),
        encryptedMlDsaSeed: bytes(48),
        keysSignature: signer.sign(
            keysStatement({
                userId,
                keyVersion,
                encryptionPublicKey,
                signingPublicKey: signer.signingPublicKey,
                mlDsaPublicKey: signer.mlDsaPublicKey,
                kemPublicKey,
            }),
        ),
    };
}

import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import {
    createHash,
    createPrivateKey,
    createPublicKey,
    randomBytes,
    randomUUID,
    sign,
} from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../src/client';
import {
    accountIdentities,
    personalWorkspaces,
    users,
    workspaceStorage,
    workspaces,
} from '../src/schema';

/* Empties every application table between tests; migrations and pg-boss are left alone. */
export async function resetDatabase() {
    const tables = await db.execute<{ tablename: string }>(
        sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    const names = tables.rows.map((row) => `"${row.tablename}"`).join(', ');
    if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
}

/* A user with a personal workspace and base allowance, without the OPAQUE ceremony. */
export async function createTestAccount(input: { email?: string; quotaBytes?: bigint } = {}) {
    const email = input.email ?? `${randomUUID()}@hushos.test`;
    const [user] = await db
        .insert(users)
        .values({ name: 'Test', email, normalizedEmail: email, emailVerifiedAt: new Date() })
        .returning({ id: users.id });
    if (!user) throw new Error('Could not create the test user.');
    const [workspace] = await db
        .insert(workspaces)
        .values({ ownerKind: 'personal' })
        .returning({ id: workspaces.id });
    if (!workspace) throw new Error('Could not create the test workspace.');
    await db.insert(personalWorkspaces).values({ userId: user.id, workspaceId: workspace.id });
    await db.insert(workspaceStorage).values({
        workspaceId: workspace.id,
        baseQuotaBytes: input.quotaBytes ?? 1_073_741_824n,
    });
    return { userId: user.id, workspaceId: workspace.id, email };
}

export async function closeDatabase() {
    await db.$client.end();
}

/* An Ed25519 key pair from a 32-byte seed, as libsodium's crypto_sign_seed_keypair makes it. */
export function signingKeyFromSeed(seed: Buffer) {
    const privateKey = createPrivateKey({
        key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
        format: 'der',
        type: 'pkcs8',
    });
    const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
    return {
        publicKey: Buffer.from(jwk.x!, 'base64url'),
        sign: (message: Buffer) => sign(null, message, privateKey),
    };
}

export type TestSigner = ReturnType<typeof signingKeyFromSeed> & { userId: string };

/*
 * A person's hybrid signing keys for tests: Ed25519 from `seed` and ML-DSA-65
 * from its SHA-256, signing Ed25519 || ML-DSA-65 under the identity context,
 * as clients do (docs/identity-pq-design.md).
 */
export function hybridSignerFromSeed(seed: Buffer) {
    const ed = signingKeyFromSeed(seed);
    const lattice = ml_dsa65.keygen(createHash('sha256').update(seed).digest());
    const context = new TextEncoder().encode('hushos/identity/v1');
    return {
        signingPublicKey: ed.publicKey,
        mlDsaPublicKey: Buffer.from(lattice.publicKey),
        /* Ed25519 alone, as a stripped or version 1 signature would be. */
        signClassical: (message: Buffer) => ed.sign(message),
        /* Only the ML-DSA half, to pair with another key's Ed25519 half. */
        signLattice: (message: Buffer) =>
            Buffer.from(ml_dsa65.sign(message, lattice.secretKey, { context })),
        sign: (message: Buffer) =>
            Buffer.concat([
                ed.sign(message),
                Buffer.from(ml_dsa65.sign(message, lattice.secretKey, { context })),
            ]),
    };
}
export type HybridSigner = ReturnType<typeof hybridSignerFromSeed>;

const testSigners = new Map<string, TestSigner>();
/* The signing key createTestIdentity gave an account. */
export function signerFor(userId: string) {
    const signer = testSigners.get(userId);
    if (!signer) throw new Error('Give the account a test identity (createTestIdentity) first.');
    return signer;
}

/*
 * Gives an account an identity whose signing key is real, so writes it signs
 * verify; the other halves are random bytes of the right length, since nothing
 * here opens them. The seed follows from the account, so a failure reproduces.
 */
export async function createTestIdentity(
    userId: string,
    overrides: Partial<typeof accountIdentities.$inferInsert> = {},
): Promise<TestSigner> {
    const key = signingKeyFromSeed(
        createHash('sha256').update(`hushos-test-signing:${userId}`).digest(),
    );
    // A version 2 identity, as every account holds after the post-quantum release: the
    // Ed25519 key signs for real; the lattice fields only have the lengths the table checks.
    await db.insert(accountIdentities).values({
        userId,
        version: 2,
        wrappingSalt: randomBytes(32),
        encryptionPublicKey: randomBytes(32),
        encryptionPrivateKeyNonce: randomBytes(24),
        encryptedEncryptionPrivateKey: randomBytes(48),
        signingPublicKey: key.publicKey,
        signingSeedNonce: randomBytes(24),
        encryptedSigningSeed: randomBytes(48),
        kemPublicKey: randomBytes(1184),
        kemSeedNonce: randomBytes(24),
        encryptedKemSeed: randomBytes(80),
        mlDsaPublicKey: randomBytes(1952),
        mlDsaSeedNonce: randomBytes(24),
        encryptedMlDsaSeed: randomBytes(48),
        keysSignature: randomBytes(3373),
        ...overrides,
    });
    const signer = { ...key, userId };
    testSigners.set(userId, signer);
    return signer;
}

/*
 * Stores an identity whose public halves are real: the keys and keys
 * statement a client made (the group testkit's `person(n, version, { userId })`
 * makes them for a stored account), so the crypto core's checks hold over what
 * the server serves. The private halves are random bytes of the right length;
 * nothing here opens them.
 */
export async function storeTestIdentity(
    userId: string,
    served: {
        keyVersion: number;
        encryptionPublicKey: string;
        signingPublicKey: string;
        mlDsaPublicKey: string;
        kemPublicKey: string;
        keysSignature: string;
    },
) {
    const b = (value: string) => Buffer.from(value, 'base64url');
    await db.insert(accountIdentities).values({
        userId,
        version: 2,
        keyVersion: served.keyVersion,
        wrappingSalt: randomBytes(32),
        encryptionPublicKey: b(served.encryptionPublicKey),
        encryptionPrivateKeyNonce: randomBytes(24),
        encryptedEncryptionPrivateKey: randomBytes(48),
        signingPublicKey: b(served.signingPublicKey),
        signingSeedNonce: randomBytes(24),
        encryptedSigningSeed: randomBytes(48),
        kemPublicKey: b(served.kemPublicKey),
        kemSeedNonce: randomBytes(24),
        encryptedKemSeed: randomBytes(80),
        mlDsaPublicKey: b(served.mlDsaPublicKey),
        mlDsaSeedNonce: randomBytes(24),
        encryptedMlDsaSeed: randomBytes(48),
        keysSignature: b(served.keysSignature),
    });
}

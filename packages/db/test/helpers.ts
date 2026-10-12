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
    const [workspace] = await db.insert(workspaces).values({}).returning({ id: workspaces.id });
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
    await db.insert(accountIdentities).values({
        userId,
        wrappingSalt: randomBytes(32),
        encryptionPublicKey: randomBytes(32),
        encryptionPrivateKeyNonce: randomBytes(24),
        encryptedEncryptionPrivateKey: randomBytes(48),
        signingPublicKey: key.publicKey,
        signingSeedNonce: randomBytes(24),
        encryptedSigningSeed: randomBytes(48),
        ...overrides,
    });
    const signer = { ...key, userId };
    testSigners.set(userId, signer);
    return signer;
}

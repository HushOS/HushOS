import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import {
    createHash,
    createPrivateKey,
    createPublicKey,
    randomBytes,
    randomUUID,
    sign,
} from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { db } from '../src/client';
import type { CreateLink, CreateShare } from '../src/drive';
import {
    accountKeys,
    accountIdentities,
    driveLinks,
    driveShares,
    groupMemberships,
    groupStorage,
    groups,
    personalWorkspaces,
    users,
    workspaceStorage,
    workspaces,
} from '../src/schema';
import type { GroupRole } from '../src/schema';

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
    // An account root at key version 1, as an unlocked account has: self-grants are checked against it.
    await db.insert(accountKeys).values({
        userId: user.id,
        envelopeVersion: 1,
        wrappingSalt: randomBytes(32),
        wrappingNonce: randomBytes(24),
        encryptedKey: randomBytes(48),
    });
    await db.insert(workspaceStorage).values({
        workspaceId: workspace.id,
        baseQuotaBytes: input.quotaBytes ?? 1_073_741_824n,
    });
    return { userId: user.id, workspaceId: workspace.id, email };
}

export async function closeDatabase() {
    await db.$client.end();
}

/*
 * A connection of its own, outside the app's pool: for holding a lock as
 * another process would, and for seeing what waits on a lock. Close it with `end()`.
 */
export function lockObserver() {
    // One connection, so a lock taken here is released on the same session.
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    return {
        /* Holds the two-key advisory lock (space, hashtext(key)) until the returned release. */
        async hold(space: number, key: string) {
            await pool.query('select pg_advisory_lock($1::int, hashtext($2))', [space, key]);
            return async () => {
                await pool.query('select pg_advisory_unlock($1::int, hashtext($2))', [space, key]);
            };
        },
        /* Whether another session's statement naming `table` waits on a lock in this database. */
        async waitingOn(table: string) {
            // Inside a transaction this connection holds open, the view would stay as first read.
            await pool.query('select pg_stat_clear_snapshot()');
            const result = await pool.query<{ waiting: number }>(
                `select count(*)::int as waiting from pg_stat_activity
                 where datname = current_database() and pid <> pg_backend_pid()
                   and wait_event_type = 'Lock' and query like '%' || $1 || '%'`,
                [table],
            );
            return result.rows[0]!.waiting > 0;
        },
        /* A statement on this connection, for a transaction the test holds open itself. */
        async query(text: string, params: unknown[] = []) {
            return (await pool.query(text, params)).rows;
        },
        end: () => pool.end(),
    };
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

/*
 * A family's rows as the group domain leaves them, written directly: the group
 * (no rosters: nothing here reads them), its organizer and members as active
 * memberships, and its areas with their own storage rows. For billing and
 * quota tests, which never check a statement. `pooled` adds the empty pool a
 * group created with billing on has.
 */
export async function createTestFamily(input: {
    organizerId: string;
    members?: { userId: string; roles?: GroupRole[] }[];
    areas?: number;
    pooled?: boolean;
    areaQuotaBytes?: bigint;
}) {
    const id = randomUUID();
    const seed = () => randomBytes(16).toString('base64url');
    await db.insert(groups).values({
        id,
        idSeed: seed(),
        kind: 'family',
        name: 'The Family',
        creatorUserId: input.organizerId,
        firstEd25519PublicKey: randomBytes(32),
        firstMlDsaPublicKey: randomBytes(1952),
        rosterVersion: 1,
        rosterDigest: randomBytes(32),
        groupKeyVersion: 1,
    });
    const now = new Date();
    await db.insert(groupMemberships).values([
        {
            groupId: id,
            groupKind: 'family' as const,
            userId: input.organizerId,
            state: 'active',
            roles: ['billing', 'guardian', 'members'],
            admittedAt: now,
        },
        ...(input.members ?? []).map((member) => ({
            groupId: id,
            groupKind: 'family' as const,
            userId: member.userId,
            state: 'active' as const,
            roles: member.roles ?? [],
            admittedAt: now,
        })),
    ]);
    const areaIds: string[] = [];
    for (let index = 0; index < (input.areas ?? 1); index++) {
        const [area] = await db
            .insert(workspaces)
            .values({ ownerKind: 'group', groupId: id, areaKind: 'shared', idSeed: seed() })
            .returning({ id: workspaces.id });
        await db.insert(workspaceStorage).values({
            workspaceId: area!.id,
            baseQuotaBytes: input.areaQuotaBytes ?? (input.pooled ? 0n : 10n * 1_073_741_824n),
        });
        areaIds.push(area!.id);
    }
    if (input.pooled) await db.insert(groupStorage).values({ groupId: id, quotaBytes: 0n });
    return { groupId: id, areaIds };
}

/*
 * A share or link in a family folder as a server before the family-sharing
 * refusal could have stored it (docs/groups-server.md 8): written directly,
 * since the repository makes neither there any more. For what departures,
 * revocations and rotations still do with such rows.
 */
export async function insertLegacyShare(input: CreateShare) {
    const [row] = await db.insert(driveShares).values(input).returning();
    return row!;
}
export async function insertLegacyLink(input: CreateLink) {
    const [row] = await db.insert(driveLinks).values(input).returning();
    return row!;
}

/* Someone in a test family: accepted (waiting to be let in), active or left, with roles. */
export async function setTestMember(input: {
    groupId: string;
    userId: string;
    state: 'accepted' | 'active' | 'left';
    roles?: GroupRole[];
}) {
    const now = new Date();
    const values = {
        state: input.state,
        roles: input.roles ?? [],
        acceptedAt: now,
        admittedAt: input.state === 'accepted' ? null : now,
        leftAt: input.state === 'left' ? now : null,
    };
    await db
        .insert(groupMemberships)
        .values({ groupId: input.groupId, groupKind: 'family', userId: input.userId, ...values })
        .onConflictDoUpdate({
            target: [groupMemberships.groupId, groupMemberships.userId],
            set: values,
        });
}

/* What a workspace holds, as finished uploads leave it. */
export async function setTestUsedBytes(workspaceId: string, usedBytes: bigint) {
    await db
        .update(workspaceStorage)
        .set({ usedBytes })
        .where(eq(workspaceStorage.workspaceId, workspaceId));
}

/* An account deleted outright, as deleteAccount leaves the rows that point at it. */
export async function deleteTestAccount(userId: string) {
    await db.delete(users).where(eq(users.id, userId));
}

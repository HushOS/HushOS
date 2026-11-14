import { and, count, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import type { db } from './client';
import { accountDevices, accountKeys, opaqueCredentials, sessions, users } from './schema';
import { deviceSessionStatement, verifySignature } from './signatures';

/*
 * How a session row comes to exist, shared by the two repository functions that open one: a
 * sign-in that needs no second step (auth's `createSession`) and one that just passed it
 * (two-step's `openSteppedSession`). Not exported from the package: `twoStepAt` is decided
 * here and by those two callers, inside their transaction, and is never a caller's input.
 */

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type Executor = Tx | typeof db;

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/*
 * How long after sign-up the first device counts as the one the account was
 * created on (`enrolment`), when the account has no device yet. Registration
 * opens no session, so this is how the first sign-in is told apart.
 */
export const DEVICE_ENROLMENT_SECONDS = 30 * 60;
/* How long a device that keeps its session goes without being asked for the step again. */
export const TWO_STEP_REMEMBER_SECONDS = 30 * 24 * 60 * 60;
/*
 * How long a replacement session lasts at most: the session a security change writes for the
 * device that made it, when that device asked for one and passed the second step with the
 * change (`changeAccountSecurity`). It is there to be replaced by the sign-in that follows
 * at once, which then inherits its step; ten minutes covers a slow device and nothing more.
 */
export const REPLACEMENT_SESSION_SECONDS = 10 * 60;

/* `device`: a new device whose sign-in another of the account's devices approved (the step). */
export type CreatedDevice = 'enrolment' | 'password' | 'device';
/* A device key's signature over one sign-in attempt (`deviceSessionStatement`). */
export type DeviceProof = { id: string; signature: Buffer; attemptDigest: Buffer };
type SessionDevice = { id: string; registered: boolean };

const userFields = { id: users.id, name: users.name, email: users.email, role: users.role };

/* Takes the account's row lock, which every write to its sessions, devices and step holds. */
export async function lockAccount(tx: Tx, userId: string) {
    const [user] = await tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
    return user !== undefined;
}

/* Whether the session is live and on the account's current credential: a rotation since ends it. */
export async function sessionIsCurrent(
    tx: Tx,
    input: { userId: string; credentialVersion: number; sessionTokenHash: Buffer },
) {
    const [session] = await tx
        .select({ id: sessions.id })
        .from(sessions)
        .innerJoin(
            opaqueCredentials,
            and(
                eq(opaqueCredentials.userId, sessions.userId),
                eq(opaqueCredentials.version, sessions.credentialVersion),
            ),
        )
        .where(
            and(
                eq(sessions.userId, input.userId),
                eq(sessions.tokenHash, input.sessionTokenHash),
                eq(sessions.credentialVersion, input.credentialVersion),
                gt(sessions.expiresAt, new Date()),
            ),
        );
    return session !== undefined;
}

/*
 * The account under its lock, as a sign-in needs it: the user and the password envelope at
 * `credentialVersion`. Null when the account is gone or its credential has moved on.
 */
export async function lockSignIn(tx: Tx, userId: string, credentialVersion: number) {
    const [user] = await tx
        .select({ ...userFields, suspendedAt: users.suspendedAt, createdAt: users.createdAt })
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
    if (!user) return null;
    if (user.suspendedAt) return { suspended: true as const };
    const [record] = await tx
        .select({ key: accountKeys })
        .from(opaqueCredentials)
        .innerJoin(
            accountKeys,
            and(
                eq(accountKeys.userId, opaqueCredentials.userId),
                eq(accountKeys.credentialVersion, opaqueCredentials.version),
            ),
        )
        .where(
            and(
                eq(opaqueCredentials.userId, user.id),
                eq(opaqueCredentials.version, credentialVersion),
            ),
        );
    if (!record) return null;
    const { suspendedAt: _suspendedAt, ...account } = user;
    return { suspended: false as const, user: account, key: record.key };
}

/*
 * The account's device a key proof is good for, with its row locked, or null: the device must
 * be this account's, approved, keyed and not removed, and the signature must be its key's over
 * this attempt. A malformed id is no proof, not an error.
 */
export async function provenDevice(tx: Tx, userId: string, proof: DeviceProof | null | undefined) {
    if (!proof || !UUID_PATTERN.test(proof.id)) return null;
    const [row] = await tx
        .select({ id: accountDevices.id, key: accountDevices.signingPublicKey })
        .from(accountDevices)
        .where(
            and(
                eq(accountDevices.id, proof.id),
                eq(accountDevices.userId, userId),
                isNull(accountDevices.revokedAt),
                isNotNull(accountDevices.approvedAt),
                isNotNull(accountDevices.signingPublicKey),
            ),
        )
        .for('update');
    if (
        !row?.key ||
        !verifySignature(
            row.key,
            deviceSessionStatement({
                userId,
                deviceId: row.id,
                attemptDigest: proof.attemptDigest,
            }),
            proof.signature,
        )
    )
        return null;
    return row.id;
}

/*
 * The device a sign-in comes back to, read and locked but not yet written:
 * - `provenDeviceId`, a device whose key proof was verified (`provenDevice`), now or when the
 *   sign-in's step token was made;
 * - otherwise the browser's previous session, if it is this account's and its device never
 *   got a key, lends its device: holding the cookie is the proof.
 * Null means the sign-in will make a new device.
 */
export async function returningDevice(
    tx: Tx,
    input: { userId: string; provenDeviceId: string | null; previousTokenHash: Buffer | null },
): Promise<SessionDevice | null> {
    if (input.provenDeviceId) {
        const [proven] = await tx
            .select({ id: accountDevices.id })
            .from(accountDevices)
            .where(
                and(
                    eq(accountDevices.id, input.provenDeviceId),
                    eq(accountDevices.userId, input.userId),
                    isNull(accountDevices.revokedAt),
                    isNotNull(accountDevices.approvedAt),
                    isNotNull(accountDevices.signingPublicKey),
                ),
            )
            .for('update');
        if (proven) return { id: proven.id, registered: true };
    }
    if (!input.previousTokenHash) return null;
    const [previous] = await tx
        .select({ id: accountDevices.id, kind: accountDevices.kind })
        .from(sessions)
        .innerJoin(accountDevices, eq(accountDevices.id, sessions.deviceId))
        .where(
            and(
                eq(sessions.tokenHash, input.previousTokenHash),
                eq(sessions.userId, input.userId),
                isNull(accountDevices.revokedAt),
                isNotNull(accountDevices.approvedAt),
                isNull(accountDevices.signingPublicKey),
            ),
        )
        .for('update', { of: accountDevices });
    return previous ? { id: previous.id, registered: previous.kind !== null } : null;
}

/*
 * When the browser's previous session passed the step, if that still counts for a new session
 * on `deviceId` (docs/two-step-design.md 4, the web's unlock after a lock): the previous
 * session must be this account's, live, on the current credential and on that same device,
 * and must have passed the step less than 30 days ago. The new session inherits that moment
 * and does not extend it. Null when the sign-in has to pass the step itself.
 */
export async function rememberedStep(
    tx: Tx,
    input: {
        userId: string;
        credentialVersion: number;
        previousTokenHash: Buffer | null;
        deviceId: string;
    },
) {
    if (!input.previousTokenHash) return null;
    const now = new Date();
    const [previous] = await tx
        .select({ twoStepAt: sessions.twoStepAt })
        .from(sessions)
        .where(
            and(
                eq(sessions.tokenHash, input.previousTokenHash),
                eq(sessions.userId, input.userId),
                eq(sessions.credentialVersion, input.credentialVersion),
                eq(sessions.deviceId, input.deviceId),
                gt(sessions.expiresAt, now),
                gt(sessions.twoStepAt, new Date(now.getTime() - TWO_STEP_REMEMBER_SECONDS * 1000)),
            ),
        );
    return previous?.twoStepAt ?? null;
}

/*
 * Writes the session, on `device` or on a new device (`enrolment` when the account is fresh
 * and has none, `password` in every other case). The device's other session, if any, ends:
 * one live session per device. `twoStepAt` is when this sign-in passed the second step, or
 * inherited it; null for an account that has no step. The caller holds the account's lock.
 */
export async function writeSession(
    tx: Tx,
    input: {
        user: { id: string; createdAt: Date };
        credentialVersion: number;
        tokenHash: Buffer;
        previousTokenHash: Buffer | null;
        expiresAt: Date;
        device: SessionDevice | null;
        twoStepAt: Date | null;
        /* The device that approved this sign-in as its second step, recorded on a new device. */
        approvedByDeviceId?: string | null;
    },
) {
    const { user } = input;
    const now = new Date();
    let device = input.device;
    let created: CreatedDevice | null = null;
    const attached = device !== null;
    if (!device) {
        const [existing] = await tx
            .select({ count: count() })
            .from(accountDevices)
            .where(eq(accountDevices.userId, user.id));
        created = input.approvedByDeviceId
            ? 'device'
            : (existing?.count ?? 0) === 0 &&
                user.createdAt.getTime() > now.getTime() - DEVICE_ENROLMENT_SECONDS * 1000
              ? 'enrolment'
              : 'password';
        const [row] = await tx
            .insert(accountDevices)
            .values({
                userId: user.id,
                approvedBy: created,
                approvedByDeviceId: input.approvedByDeviceId ?? null,
                approvedAt: now,
                createdAt: now,
                lastSeenAt: now,
            })
            .returning({ id: accountDevices.id });
        if (!row) throw new Error('Could not create the device.');
        device = { id: row.id, registered: false };
    } else
        await tx
            .update(accountDevices)
            .set({ lastSeenAt: now })
            .where(eq(accountDevices.id, device.id));

    if (input.previousTokenHash)
        await tx.delete(sessions).where(eq(sessions.tokenHash, input.previousTokenHash));
    await tx.delete(sessions).where(eq(sessions.deviceId, device.id));
    await tx.insert(sessions).values({
        userId: user.id,
        credentialVersion: input.credentialVersion,
        tokenHash: input.tokenHash,
        deviceId: device.id,
        expiresAt: input.expiresAt,
        lastSeenAt: now,
        twoStepAt: input.twoStepAt,
    });
    return { id: device.id, attached, registered: device.registered, created };
}

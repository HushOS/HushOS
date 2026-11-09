import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../src/client';
import {
    accountDevices,
    groupMemberships,
    sessions,
    twoStepAttempts,
    twoStepBackupCodes,
    twoStepFactors,
    twoStepState,
} from '../src/schema';

/*
 * Rows a two-step test reads, and the few it sets by hand because no request
 * can: a step passed 29 days ago, a session that ended on its own, a count of
 * wrong codes standing at ninety-nine. For the suites that drive the routes
 * (apps/web's `*.db.test.ts`), which reach the database only through here.
 */

export const sessionRows = () => db.select().from(sessions);
export const deviceRows = () => db.select().from(accountDevices);
export const attemptRows = () => db.select().from(twoStepAttempts);
export const factorRows = () => db.select().from(twoStepFactors);
export const backupCodeRows = () => db.select().from(twoStepBackupCodes);

export async function sessionRow(tokenHash: Buffer) {
    const [row] = await db.select().from(sessions).where(eq(sessions.tokenHash, tokenHash));
    return row;
}

/* The session ends as an idle one does: its row goes, its device and the device's key stay. */
export async function endSession(tokenHash: Buffer) {
    await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
}

/* When the session passed the step, as if that had been `at`. */
export async function setSteppedAt(tokenHash: Buffer, at: Date | null) {
    await db.update(sessions).set({ twoStepAt: at }).where(eq(sessions.tokenHash, tokenHash));
}

/* Wrong codes in a row from sign-ins that proved no device, without sending them. */
export async function setSharedFailures(userId: string, count: number) {
    await db
        .update(twoStepState)
        .set({ consecutiveFailures: count })
        .where(eq(twoStepState.userId, userId));
}

/* Wrong codes in a row from sign-ins that proved no device, as counted so far. */
export async function sharedFailures(userId: string) {
    const [row] = await db
        .select({ count: twoStepState.consecutiveFailures })
        .from(twoStepState)
        .where(eq(twoStepState.userId, userId));
    return row?.count;
}

/* Wrong codes in a row from one known device, without sending them. */
export async function setDeviceFailures(deviceId: string, count: number) {
    await db
        .update(accountDevices)
        .set({ twoStepFailures: count })
        .where(eq(accountDevices.id, deviceId));
}

/*
 * One of the account's unused backup codes, as if it had been made under a key nobody has: the
 * rest of the set stays as it was. No request leaves a set like this today (a set is written
 * whole, under one key); the check must not depend on that.
 */
export async function strandOneBackupCode(userId: string) {
    const [code] = await db
        .select({ codeHash: twoStepBackupCodes.codeHash })
        .from(twoStepBackupCodes)
        .where(and(eq(twoStepBackupCodes.userId, userId), isNull(twoStepBackupCodes.usedAt)))
        .limit(1);
    if (!code) throw new Error('No unused backup code.');
    await db
        .update(twoStepBackupCodes)
        .set({ keyId: Buffer.alloc(8, 0xee) })
        .where(
            and(
                eq(twoStepBackupCodes.userId, userId),
                eq(twoStepBackupCodes.codeHash, code.codeHash),
            ),
        );
}

export async function membershipState(groupId: string, userId: string) {
    const [row] = await db
        .select({ state: groupMemberships.state })
        .from(groupMemberships)
        .where(and(eq(groupMemberships.groupId, groupId), eq(groupMemberships.userId, userId)));
    return row?.state;
}

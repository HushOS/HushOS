import { timingSafeEqual } from 'node:crypto';
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { db } from './client';
import {
    accountDevices,
    sessions,
    twoStepAttempts,
    twoStepBackupCodes,
    twoStepDeviceRequests,
    twoStepFactors,
    twoStepKeyRegistrations,
    twoStepState,
    type DeviceKind,
    type DeviceRequestClass,
    type DeviceRequestEnd,
    type DeviceRequestState,
    type TwoStepPurpose,
} from './schema';
import { lockAccount, sessionIsCurrent, type Executor, type Tx } from './sessions';
import { deviceStepCommitment, deviceStepStatement, verifySignature } from './signatures';
import {
    PENDING_FACTOR_SECONDS,
    agedPurpose,
    approvingDevices,
    confirmedFactors,
    countPoolFailure,
    endDeviceRequests,
    ensureState,
    hourOf,
    passStepIfOn,
    readAttempt,
    settleDefault,
    settleRefusal,
    type StepAttempt,
    type StepPool,
    type StepProof,
    type TwoStepRefusal,
} from './two-step.core';

/*
 * Approving on another device, as the second step (docs/two-step-design.md 12,
 * docs/devices-design.md 2): the rows of a request, from the asking device's commitment to its
 * end. The step token is the request's bearer. What this repository guarantees, whatever the
 * server does around it:
 * - a request exists only for a live token, names it and its purpose, and never outlives it;
 * - the asking device reveals once, only after one approving device opened the request, and
 *   only what it committed to;
 * - only a device that may approve does: another of the account's devices, never the one the
 *   token names, with a device key and a live session that passed the step, and for a step-up
 *   only between devices that have been on the account for seven days;
 * - an approval is the approving device's signature over this account, request, purpose, token
 *   and asking device, checked here against its stored key;
 * - requests are budgeted by class, and the classes never share room: a sign-in that proved no
 *   device (five a day for the account, one open at a time), a sign-in that proved its device
 *   (five a day for that device), and a step-up (five a day for that device, ten for the account);
 * - a request denied, answered with a wrong code, or left unanswered by a sign-in that proved no
 *   device is counted as a failed step, once.
 * Passing the step with an approved request is `passStep`'s (two-step.core.ts), under the same
 * lock as every other answer.
 */

/* How many requests a day each budget allows (docs/two-step-design.md 12). */
export const DEVICE_REQUESTS_A_DAY = 5;
export const CHANGE_REQUESTS_A_DAY = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const OPEN: DeviceRequestState[] = ['waiting', 'opened', 'revealed', 'approved'];

/* The account's method row of the kind, confirmed or still pending within its ten minutes. */
async function deviceFactor(executor: Executor, userId: string) {
    const [factor] = await executor
        .select({
            id: twoStepFactors.id,
            confirmedAt: twoStepFactors.confirmedAt,
            createdAt: twoStepFactors.createdAt,
        })
        .from(twoStepFactors)
        .where(and(eq(twoStepFactors.userId, userId), eq(twoStepFactors.kind, 'device')));
    if (!factor) return null;
    const fresh = factor.createdAt.getTime() > Date.now() - PENDING_FACTOR_SECONDS * 1000;
    return factor.confirmedAt
        ? { id: factor.id, confirmed: true as const }
        : fresh
          ? { id: factor.id, confirmed: false as const }
          : null;
}

/* A device of the account as a request names it, if it is one that may ask: not removed, keyed. */
async function askingDevice(executor: Executor, userId: string, deviceId: string) {
    const [device] = await executor
        .select({
            id: accountDevices.id,
            kind: accountDevices.kind,
            name: accountDevices.name,
            key: accountDevices.signingPublicKey,
            approvedAt: accountDevices.approvedAt,
        })
        .from(accountDevices)
        .where(
            and(
                eq(accountDevices.id, deviceId),
                eq(accountDevices.userId, userId),
                isNull(accountDevices.revokedAt),
                isNotNull(accountDevices.approvedAt),
                isNotNull(accountDevices.signingPublicKey),
            ),
        );
    return device?.key && device.approvedAt
        ? { ...device, key: device.key, approvedAt: device.approvedAt }
        : null;
}

const agedEnough = (approvedAt: Date) =>
    approvedAt.getTime() <= Date.now() - 7 * 24 * 60 * 60 * 1000;

/*
 * What a token's request would be, or null when another device cannot answer it: the class it
 * is budgeted in, the device asking (when the server knows it), and whether this is the one
 * approval that turns the method on. Null when
 * - the account has no such method (a pending one counts only for the token that confirms it);
 * - a step-up's own device has no key, or has been on the account for less than seven days;
 * - no other device may approve.
 * Nothing here says which, to anyone.
 */
async function requestFor(executor: Executor, attempt: StepAttempt) {
    if (attempt.purpose === 'enrol') return null;
    const factor = await deviceFactor(executor, attempt.userId);
    const confirming = attempt.purpose === 'device-approval';
    if (!factor || factor.confirmed === confirming) return null;
    const deviceId = attempt.pool.kind === 'device' ? attempt.pool.deviceId : null;
    const signIn = attempt.purpose === 'login';
    const device = deviceId ? await askingDevice(executor, attempt.userId, deviceId) : null;
    // A sign-in whose device has no key yet is still one device asking another; a step-up is not.
    if (!signIn && !device) return null;
    if (agedPurpose(attempt.purpose) && device && !agedEnough(device.approvedAt)) return null;
    const bootstrap = confirming && (await confirmedFactors(executor, attempt.userId)).length === 0;
    const approvers = await approvingDevices(executor, {
        userId: attempt.userId,
        purpose: attempt.purpose,
        exceptDeviceId: deviceId,
        bootstrap,
    });
    if (approvers.length === 0) return null;
    const requestClass: DeviceRequestClass = !signIn ? 'change' : device ? 'known' : 'unknown';
    return { class: requestClass, device: requestClass === 'unknown' ? null : device, bootstrap };
}

/* Whether another device can answer this token now: what `methods` lists `device` by. */
export async function deviceStepUsable(attempt: StepAttempt) {
    return (await requestFor(db, attempt)) !== null;
}

/*
 * Whether this session's device could turn the method on now: it holds a device key, and
 * another of the account's devices could approve it. What settings offers the method by.
 */
export async function canAddDeviceStep(input: { userId: string; sessionTokenHash: Buffer }) {
    const [session] = await db
        .select({ deviceId: sessions.deviceId })
        .from(sessions)
        .where(
            and(
                eq(sessions.tokenHash, input.sessionTokenHash),
                eq(sessions.userId, input.userId),
                gt(sessions.expiresAt, new Date()),
            ),
        );
    if (!session?.deviceId) return false;
    if (!(await askingDevice(db, input.userId, session.deviceId))) return false;
    const approvers = await approvingDevices(db, {
        userId: input.userId,
        purpose: 'device-approval',
        exceptDeviceId: session.deviceId,
        bootstrap: (await confirmedFactors(db, input.userId)).length === 0,
    });
    return approvers.length > 0;
}

/* ------------------------------------------------------------------------- */
/* Counting                                                                   */
/* ------------------------------------------------------------------------- */

/* A request counted as a failed step: whose it was, and the count it moved. */
export type CountedRequest = {
    userId: string;
    requestId: string;
    purpose: TwoStepPurpose;
    class: DeviceRequestClass;
    reason: DeviceRequestEnd;
    /* The device whose count it went to, or null for the account's. */
    deviceId: string | null;
    consecutiveFailures: number;
    /* From the fifth in a row on. */
    notice: boolean;
    froze: boolean;
};

const poolOf = (deviceId: string | null): StepPool =>
    deviceId ? { kind: 'device', deviceId } : { kind: 'account' };

/*
 * Ends the account's requests whose time is up or whose token is gone, under its lock. One from
 * a sign-in that proved no device and was never answered is a failed step, counted here once
 * (docs/two-step-design.md 12): whoever raised it had the password and nothing else. One that
 * was replaced while its token lived is counted with it when the token ends unused. A request of
 * a known device or a step-up just ends.
 */
async function settleAccount(tx: Tx, userId: string): Promise<CountedRequest[]> {
    const now = new Date();
    const live = sql`exists (select 1 from ${twoStepAttempts} where ${twoStepAttempts.tokenHash} = ${twoStepDeviceRequests.tokenHash} and ${twoStepAttempts.expiresAt} > ${now})`;
    const over = await tx
        .select({
            id: twoStepDeviceRequests.id,
            purpose: twoStepDeviceRequests.purpose,
            class: twoStepDeviceRequests.class,
            tokenHash: twoStepDeviceRequests.tokenHash,
        })
        .from(twoStepDeviceRequests)
        .where(
            and(
                eq(twoStepDeviceRequests.userId, userId),
                eq(twoStepDeviceRequests.counted, false),
                or(
                    ne(twoStepDeviceRequests.state, 'ended'),
                    eq(twoStepDeviceRequests.endedReason, 'replaced'),
                ),
                or(lt(twoStepDeviceRequests.expiresAt, now), sql`not ${live}`),
            ),
        )
        .orderBy(asc(twoStepDeviceRequests.createdAt))
        .for('update');
    const counted: CountedRequest[] = [];
    // One sign-in left unanswered is one failed step, however many times it asked.
    const tokens = new Set<string>();
    for (const request of over) {
        const token = request.tokenHash.toString('hex');
        const failed = request.class === 'unknown' && !tokens.has(token);
        tokens.add(token);
        await tx
            .update(twoStepDeviceRequests)
            .set({
                state: 'ended',
                endedReason: 'expired',
                endedAt: now,
                counted: failed,
            })
            .where(eq(twoStepDeviceRequests.id, request.id));
        if (!failed) continue;
        counted.push({
            userId,
            requestId: request.id,
            purpose: request.purpose,
            class: request.class,
            reason: 'expired',
            deviceId: null,
            ...(await countPoolFailure(tx, userId, { kind: 'account' })),
        });
    }
    return counted;
}

/*
 * Ends what is over, for one account or (the worker's sweep) for every account that has any:
 * what was counted as a failed step comes back, for the caller to log and tell the account.
 */
export async function settleDeviceRequests(userId?: string): Promise<CountedRequest[]> {
    const now = new Date();
    // Asked on every look at an account's requests: with none still open, no lock is taken.
    if (userId) {
        const [open] = await db
            .select({ id: twoStepDeviceRequests.id })
            .from(twoStepDeviceRequests)
            .where(
                and(
                    eq(twoStepDeviceRequests.userId, userId),
                    eq(twoStepDeviceRequests.counted, false),
                    or(
                        ne(twoStepDeviceRequests.state, 'ended'),
                        eq(twoStepDeviceRequests.endedReason, 'replaced'),
                    ),
                ),
            )
            .limit(1);
        if (!open) return [];
    }
    const accounts = userId
        ? [userId]
        : (
              await db
                  .selectDistinct({ userId: twoStepDeviceRequests.userId })
                  .from(twoStepDeviceRequests)
                  .where(
                      and(
                          eq(twoStepDeviceRequests.counted, false),
                          or(
                              ne(twoStepDeviceRequests.state, 'ended'),
                              eq(twoStepDeviceRequests.endedReason, 'replaced'),
                          ),
                          lt(twoStepDeviceRequests.expiresAt, now),
                      ),
                  )
                  .limit(500)
          ).map((row) => row.userId);
    const counted: CountedRequest[] = [];
    for (const account of accounts)
        counted.push(
            ...(await db.transaction(async (tx) =>
                (await lockAccount(tx, account)) ? settleAccount(tx, account) : [],
            )),
        );
    return counted;
}

/* ------------------------------------------------------------------------- */
/* The asking device                                                          */
/* ------------------------------------------------------------------------- */

export type CreateRequestResult =
    | {
          status: 'ok';
          id: string;
          userId: string;
          purpose: TwoStepPurpose;
          class: DeviceRequestClass;
          expiresAt: Date;
          /* What ending the account's older requests counted as failed steps. */
          counted: CountedRequest[];
      }
    /*
     * `gone`: the token cannot pass. `unavailable`: another device cannot answer it. `limit`:
     * the day's budget for its class is spent. `busy`: another sign-in's request is open and a
     * device has it in hand.
     */
    | { status: 'gone' | 'unavailable' | 'limit' | 'busy'; counted?: CountedRequest[] };

/*
 * Makes a request for the token, with the asking device's commitment and nothing else of it.
 * Under the account's lock:
 * - the token must be live, and one another device can answer (`requestFor`);
 * - the budget of its class must have room: the rows of the last 24 hours are the count, so
 *   the classes cannot spend each other's;
 * - one request is open at a time for a sign-in that proved no device, and one for each device:
 *   a newer one replaces it. A request of another sign-in that a device already opened is not
 *   replaced (`busy`): the person is in the middle of answering it.
 * `kind` and `name` are the asking device's own words, used only when the server does not know
 * the device; they are shown to the approving device and to nobody else.
 */
export async function createDeviceRequest(input: {
    tokenHash: Buffer;
    commitment: Buffer;
    kind?: DeviceKind | null;
    name?: string | null;
}): Promise<CreateRequestResult> {
    return db.transaction(async (tx): Promise<CreateRequestResult> => {
        const [seen] = await tx
            .select({ userId: twoStepAttempts.userId })
            .from(twoStepAttempts)
            .where(eq(twoStepAttempts.tokenHash, input.tokenHash));
        if (!seen || !(await lockAccount(tx, seen.userId))) return { status: 'gone' };
        const attempt = await readAttempt(tx, input.tokenHash);
        if (!attempt) return { status: 'gone' };
        const counted = await settleAccount(tx, attempt.userId);
        const asked = await requestFor(tx, attempt);
        if (!asked) return { status: 'unavailable', counted };
        const { userId } = attempt;
        const deviceId = asked.device?.id ?? null;
        const scope = and(
            eq(twoStepDeviceRequests.userId, userId),
            eq(twoStepDeviceRequests.class, asked.class),
            deviceId ? eq(twoStepDeviceRequests.deviceId, deviceId) : undefined,
        );
        const open = await tx
            .select({
                id: twoStepDeviceRequests.id,
                state: twoStepDeviceRequests.state,
                tokenHash: twoStepDeviceRequests.tokenHash,
            })
            .from(twoStepDeviceRequests)
            .where(and(scope, inArray(twoStepDeviceRequests.state, OPEN)))
            .for('update');
        if (
            asked.class === 'unknown' &&
            open.some(
                (request) =>
                    request.state !== 'waiting' && !request.tokenHash.equals(input.tokenHash),
            )
        )
            return { status: 'busy', counted };
        const since = new Date(Date.now() - DAY_MS);
        const made = async (where: ReturnType<typeof and>) =>
            (
                await tx
                    .select({ count: count() })
                    .from(twoStepDeviceRequests)
                    .where(and(where, gt(twoStepDeviceRequests.createdAt, since)))
            )[0]?.count ?? 0;
        if ((await made(scope)) >= DEVICE_REQUESTS_A_DAY) return { status: 'limit', counted };
        if (
            asked.class === 'change' &&
            (await made(
                and(
                    eq(twoStepDeviceRequests.userId, userId),
                    eq(twoStepDeviceRequests.class, 'change'),
                ),
            )) >= CHANGE_REQUESTS_A_DAY
        )
            return { status: 'limit', counted };
        if (open.length)
            await tx
                .update(twoStepDeviceRequests)
                .set({ state: 'ended', endedReason: 'replaced', endedAt: new Date() })
                .where(
                    inArray(
                        twoStepDeviceRequests.id,
                        open.map((request) => request.id),
                    ),
                );
        const [row] = await tx
            .insert(twoStepDeviceRequests)
            .values({
                userId,
                tokenHash: input.tokenHash,
                purpose: attempt.purpose,
                class: asked.class,
                deviceId,
                deviceKind: asked.device ? asked.device.kind : (input.kind ?? null),
                deviceName: asked.device ? asked.device.name : (input.name ?? null),
                commitment: input.commitment,
                expiresAt: attempt.expiresAt,
            })
            .returning({ id: twoStepDeviceRequests.id });
        if (!row) throw new Error('The request could not be stored.');
        return {
            status: 'ok',
            id: row.id,
            userId,
            purpose: attempt.purpose,
            class: asked.class,
            expiresAt: attempt.expiresAt,
            counted,
        };
    });
}

/* A token's own request, read under the account's lock with the token still live, or null. */
async function ownRequest(tx: Tx, input: { tokenHash: Buffer; requestId: string }) {
    const [seen] = await tx
        .select({ userId: twoStepAttempts.userId })
        .from(twoStepAttempts)
        .where(eq(twoStepAttempts.tokenHash, input.tokenHash));
    if (!seen || !(await lockAccount(tx, seen.userId))) return null;
    const attempt = await readAttempt(tx, input.tokenHash);
    if (!attempt) return null;
    const [request] = await tx
        .select()
        .from(twoStepDeviceRequests)
        .where(
            and(
                eq(twoStepDeviceRequests.id, input.requestId),
                eq(twoStepDeviceRequests.userId, attempt.userId),
                eq(twoStepDeviceRequests.tokenHash, input.tokenHash),
            ),
        )
        .for('update');
    return request ? { attempt, request } : null;
}

export type RequestStatus = {
    state: DeviceRequestState;
    endedReason: DeviceRequestEnd | null;
    /* The approving device's fresh key, once one opened the request. */
    approverKey: Buffer | null;
};

/* Where the token's request stands, for the device that made it; null once the token is over. */
export async function getDeviceRequest(input: {
    tokenHash: Buffer;
    requestId: string;
}): Promise<RequestStatus | null> {
    const attempt = await readAttempt(db, input.tokenHash);
    if (!attempt) return null;
    const [request] = await db
        .select({
            state: twoStepDeviceRequests.state,
            endedReason: twoStepDeviceRequests.endedReason,
            approverKey: twoStepDeviceRequests.approverKey,
        })
        .from(twoStepDeviceRequests)
        .where(
            and(
                eq(twoStepDeviceRequests.id, input.requestId),
                eq(twoStepDeviceRequests.userId, attempt.userId),
                eq(twoStepDeviceRequests.tokenHash, input.tokenHash),
            ),
        );
    return request ?? null;
}

/*
 * The asking device shows what it committed to: its signing key and its nonce. Only after an
 * approving device opened the request, and once (`state` otherwise). What it reveals must be
 * what it committed to, for this token and purpose, and a device the server knows must reveal
 * its own key: anything else ends the request (`mismatch`), since no code could match.
 */
export async function revealDeviceRequest(input: {
    tokenHash: Buffer;
    requestId: string;
    deviceKey: Buffer;
    nonce: Buffer;
}): Promise<{ status: 'ok' | 'gone' | 'state' | 'mismatch' }> {
    return db.transaction(async (tx) => {
        const own = await ownRequest(tx, input);
        if (!own) return { status: 'gone' };
        const { attempt, request } = own;
        if (request.state !== 'opened') return { status: 'state' };
        const known = request.deviceId
            ? await askingDevice(tx, attempt.userId, request.deviceId)
            : null;
        const committed = deviceStepCommitment({
            purpose: request.purpose,
            tokenDigest: request.tokenHash,
            deviceSigningKey: input.deviceKey,
            nonce: input.nonce,
        });
        const honest =
            timingSafeEqual(committed, request.commitment) &&
            (request.deviceId === null || (known !== null && known.key.equals(input.deviceKey)));
        if (!honest) {
            await tx
                .update(twoStepDeviceRequests)
                .set({ state: 'ended', endedReason: 'mismatch', endedAt: new Date() })
                .where(eq(twoStepDeviceRequests.id, request.id));
            return { status: 'mismatch' };
        }
        await tx
            .update(twoStepDeviceRequests)
            .set({ state: 'revealed', deviceKey: input.deviceKey, nonce: input.nonce })
            .where(eq(twoStepDeviceRequests.id, request.id));
        return { status: 'ok' };
    });
}

/* ------------------------------------------------------------------------- */
/* The approving device                                                       */
/* ------------------------------------------------------------------------- */

/* The session asking to approve, on the account's current credential, with its device. */
async function approverSession(executor: Executor, sessionTokenHash: Buffer) {
    const [session] = await executor
        .select({ userId: sessions.userId, deviceId: sessions.deviceId })
        .from(sessions)
        .where(and(eq(sessions.tokenHash, sessionTokenHash), gt(sessions.expiresAt, new Date())));
    return session?.deviceId ? { userId: session.userId, deviceId: session.deviceId } : null;
}

/* Whether `deviceId` may approve this request: by the rule of its purpose, and never its own. */
async function mayApprove(
    executor: Executor,
    request: { userId: string; purpose: TwoStepPurpose; deviceId: string | null },
    deviceId: string,
) {
    if (request.deviceId === deviceId) return false;
    const bootstrap =
        request.purpose === 'device-approval' &&
        (await confirmedFactors(executor, request.userId)).length === 0;
    const [approver] = await approvingDevices(executor, {
        userId: request.userId,
        purpose: request.purpose,
        exceptDeviceId: request.deviceId,
        bootstrap,
        onlyDeviceId: deviceId,
    });
    return approver !== undefined;
}

/* A request as a device that may approve it sees it. */
export type ApprovalPrompt = {
    id: string;
    purpose: TwoStepPurpose;
    class: DeviceRequestClass;
    device: { kind: DeviceKind | null; name: string | null };
    createdAt: Date;
    expiresAt: Date;
    /* The token's hash and the asking device's commitment: what the code and the statement cover. */
    tokenDigest: Buffer;
    commitment: Buffer;
    /* This device opened it, with this key; once revealed, what the asking device showed. */
    opened: { approverKey: Buffer; reveal: { deviceKey: Buffer; nonce: Buffer } | null } | null;
};

/*
 * The requests this session's device may answer now: the account's open ones, with their token
 * still live, that are not its own, and that no other device has opened. Empty for a device that
 * may approve nothing (no key, a session that never passed the step, too new for a step-up).
 */
export async function listApprovalPrompts(sessionTokenHash: Buffer): Promise<ApprovalPrompt[]> {
    const session = await approverSession(db, sessionTokenHash);
    if (!session) return [];
    const now = new Date();
    const rows = await db
        .select({ request: twoStepDeviceRequests })
        .from(twoStepDeviceRequests)
        .innerJoin(
            twoStepAttempts,
            and(
                eq(twoStepAttempts.tokenHash, twoStepDeviceRequests.tokenHash),
                gt(twoStepAttempts.expiresAt, now),
            ),
        )
        .where(
            and(
                eq(twoStepDeviceRequests.userId, session.userId),
                inArray(twoStepDeviceRequests.state, ['waiting', 'opened', 'revealed']),
                gt(twoStepDeviceRequests.expiresAt, now),
                or(
                    isNull(twoStepDeviceRequests.approverDeviceId),
                    eq(twoStepDeviceRequests.approverDeviceId, session.deviceId),
                ),
            ),
        )
        .orderBy(asc(twoStepDeviceRequests.createdAt));
    const prompts: ApprovalPrompt[] = [];
    for (const { request } of rows) {
        // The token must still be able to pass, and this device must be one that may answer it.
        if (!(await readAttempt(db, request.tokenHash))) continue;
        if (!(await mayApprove(db, request, session.deviceId))) continue;
        prompts.push({
            id: request.id,
            purpose: request.purpose,
            class: request.class,
            device: { kind: request.deviceKind, name: request.deviceName },
            createdAt: request.createdAt,
            expiresAt: request.expiresAt,
            tokenDigest: request.tokenHash,
            commitment: request.commitment,
            opened: request.approverKey
                ? {
                      approverKey: request.approverKey,
                      reveal:
                          request.deviceKey && request.nonce
                              ? { deviceKey: request.deviceKey, nonce: request.nonce }
                              : null,
                  }
                : null,
        });
    }
    return prompts;
}

/* An open request under the account's lock, for a session whose device may approve it. */
async function approvable(tx: Tx, input: { sessionTokenHash: Buffer; requestId: string }) {
    const session = await approverSession(tx, input.sessionTokenHash);
    if (!session || !(await lockAccount(tx, session.userId))) return null;
    const [request] = await tx
        .select()
        .from(twoStepDeviceRequests)
        .where(
            and(
                eq(twoStepDeviceRequests.id, input.requestId),
                eq(twoStepDeviceRequests.userId, session.userId),
                gt(twoStepDeviceRequests.expiresAt, new Date()),
            ),
        )
        .for('update');
    if (!request || request.state === 'ended') return null;
    // The request never outlives its token: one whose token ended is no longer anyone's to answer.
    if (!(await readAttempt(tx, request.tokenHash))) return null;
    if (!(await mayApprove(tx, request, session.deviceId))) return null;
    return { session, request };
}

/*
 * The first approving device to open a request posts its fresh key; the asking device reveals
 * only after. A request another device opened is `taken`. Opening again from the same device
 * answers the key it posted the first time, so both sides keep computing the same code.
 */
export async function openDeviceRequest(input: {
    sessionTokenHash: Buffer;
    requestId: string;
    approverKey: Buffer;
}): Promise<{ status: 'ok'; approverKey: Buffer } | { status: 'gone' | 'taken' }> {
    return db.transaction(async (tx) => {
        const found = await approvable(tx, input);
        if (!found) return { status: 'gone' };
        const { session, request } = found;
        if (request.state !== 'waiting')
            return request.approverDeviceId === session.deviceId && request.approverKey
                ? { status: 'ok', approverKey: request.approverKey }
                : { status: 'taken' };
        await tx
            .update(twoStepDeviceRequests)
            .set({
                state: 'opened',
                approverDeviceId: session.deviceId,
                approverKey: input.approverKey,
            })
            .where(eq(twoStepDeviceRequests.id, request.id));
        return { status: 'ok', approverKey: input.approverKey };
    });
}

/*
 * The approving device's signature, by its device key, over the statement that names the
 * account, the request, the purpose, the token and the asking device's key as it was revealed.
 * Only the device that opened the request approves it, only once it was revealed, and only with
 * a signature that verifies against its stored key: one that does not ends the request.
 */
export async function approveDeviceRequest(input: {
    sessionTokenHash: Buffer;
    requestId: string;
    signature: Buffer;
}): Promise<{ status: 'ok' | 'gone' | 'state' | 'signature' }> {
    return db.transaction(async (tx) => {
        const found = await approvable(tx, input);
        if (!found) return { status: 'gone' };
        const { session, request } = found;
        if (request.approverDeviceId !== session.deviceId) return { status: 'gone' };
        if (request.state !== 'revealed' || !request.deviceKey) return { status: 'state' };
        const approver = await askingDevice(tx, session.userId, session.deviceId);
        const signed =
            approver !== null &&
            verifySignature(
                approver.key,
                deviceStepStatement({
                    userId: request.userId,
                    requestId: request.id,
                    purpose: request.purpose,
                    tokenDigest: request.tokenHash,
                    deviceSigningKey: request.deviceKey,
                }),
                input.signature,
            );
        if (!signed) {
            await tx
                .update(twoStepDeviceRequests)
                .set({ state: 'ended', endedReason: 'mismatch', endedAt: new Date() })
                .where(eq(twoStepDeviceRequests.id, request.id));
            return { status: 'signature' };
        }
        await tx
            .update(twoStepDeviceRequests)
            .set({ state: 'approved', signature: input.signature })
            .where(eq(twoStepDeviceRequests.id, request.id));
        return { status: 'ok' };
    });
}

/*
 * The approving device ends a request: Deny (`denied`), a code that did not match
 * (`wrong-code`), This wasn't me (`not-me`), or what the asking device revealed is not what it
 * committed to (`mismatch`). The first three are a failed step, counted once in the pool the
 * request came from: the asking device's own count, or the account's for a sign-in that proved
 * none. The token is left as it was: the person can still answer it another way. Any device that
 * may approve can end a request nobody opened; one that was opened is its opener's.
 */
export async function denyDeviceRequest(input: {
    sessionTokenHash: Buffer;
    requestId: string;
    reason: 'denied' | 'wrong-code' | 'not-me' | 'mismatch';
}): Promise<{ status: 'ok'; counted: CountedRequest | null } | { status: 'gone' }> {
    return db.transaction(async (tx) => {
        const found = await approvable(tx, input);
        if (!found) return { status: 'gone' };
        const { session, request } = found;
        if (request.approverDeviceId && request.approverDeviceId !== session.deviceId)
            return { status: 'gone' };
        // Approved already: the answer was given, and only using it or its time running out ends it.
        if (request.state === 'approved') return { status: 'gone' };
        const failed = input.reason !== 'mismatch';
        await tx
            .update(twoStepDeviceRequests)
            .set({
                state: 'ended',
                endedReason: input.reason,
                endedAt: new Date(),
                counted: failed,
            })
            .where(eq(twoStepDeviceRequests.id, request.id));
        if (!failed) return { status: 'ok', counted: null };
        return {
            status: 'ok',
            counted: {
                userId: request.userId,
                requestId: request.id,
                purpose: request.purpose,
                class: request.class,
                reason: input.reason,
                deviceId: request.deviceId,
                ...(await countPoolFailure(tx, request.userId, poolOf(request.deviceId))),
            },
        };
    });
}

/* ------------------------------------------------------------------------- */
/* Turning the method on                                                      */
/* ------------------------------------------------------------------------- */

export type StartDeviceFactorResult =
    | { status: 'ok'; id: string }
    /* `unavailable`: this device has no key, or no other device could approve. `exists`: already on. */
    | { status: 'session' | 'unavailable' | 'exists' }
    | TwoStepRefusal;

/*
 * Starts turning on Approve on another device: a pending method, good for ten minutes, and the
 * step token that the one approval confirming it runs from (purpose `device-approval`, bound to
 * the session asking). While the account has the step on, adding a method needs the step
 * (`step`). Nothing is stored unless this session's device holds a key and another device could
 * approve it. Starting again replaces the earlier pending method and its token.
 */
export async function startDeviceFactor(input: {
    userId: string;
    sessionTokenHash: Buffer;
    credentialVersion: number;
    tokenHash: Buffer;
    expiresAt: Date;
    step?: StepProof & { sessionTokenHash: Buffer };
}): Promise<StartDeviceFactorResult> {
    try {
        return await db.transaction(async (tx): Promise<StartDeviceFactorResult> => {
            if (!(await lockAccount(tx, input.userId)) || !(await sessionIsCurrent(tx, input)))
                return { status: 'session' };
            const session = await approverSession(tx, input.sessionTokenHash);
            if (!session || !(await askingDevice(tx, input.userId, session.deviceId)))
                return { status: 'unavailable' };
            const confirmed = await confirmedFactors(tx, input.userId);
            if (confirmed.some(({ kind }) => kind === 'device')) return { status: 'exists' };
            const approvers = await approvingDevices(tx, {
                userId: input.userId,
                purpose: 'device-approval',
                exceptDeviceId: session.deviceId,
                bootstrap: confirmed.length === 0,
            });
            if (approvers.length === 0) return { status: 'unavailable' };
            await passStepIfOn(tx, {
                userId: input.userId,
                purpose: 'two-step',
                sessionTokenHash: input.step?.sessionTokenHash ?? null,
                proof: input.step,
            });
            await tx
                .delete(twoStepFactors)
                .where(
                    and(eq(twoStepFactors.userId, input.userId), eq(twoStepFactors.kind, 'device')),
                );
            await tx
                .delete(twoStepAttempts)
                .where(
                    and(
                        eq(twoStepAttempts.userId, input.userId),
                        eq(twoStepAttempts.purpose, 'device-approval'),
                    ),
                );
            const [factor] = await tx
                .insert(twoStepFactors)
                .values({ userId: input.userId, kind: 'device' })
                .returning({ id: twoStepFactors.id });
            if (!factor) throw new Error('The method could not be stored.');
            await tx.insert(twoStepAttempts).values({
                tokenHash: input.tokenHash,
                userId: input.userId,
                purpose: 'device-approval',
                sessionTokenHash: input.sessionTokenHash,
                credentialVersion: input.credentialVersion,
                expiresAt: input.expiresAt,
            });
            return { status: 'ok', id: factor.id };
        });
    } catch (error) {
        const refusal = await settleRefusal(error);
        if (!refusal) throw error;
        return refusal;
    }
}

export type ConfirmDeviceFactorResult =
    /* `turnedOn`: this was the account's first method, so the step is now on and the codes were stored. */
    | { status: 'ok'; turnedOn: boolean; approverDeviceId: string }
    /* `pending`: no device has approved yet. */
    | { status: 'session' | 'missing' | 'pending' | 'codes-required' };

/*
 * Confirms the pending method with the one real approval it waits for. Under the account's lock:
 * - the session asking must be the account's own, live and on its current credential;
 * - the method must be this account's, pending and younger than ten minutes, and the token the
 *   one made with it, for this session;
 * - the request must be that token's, and approved by a device that may still approve;
 * - the account's first method turns the step on, as an app's does: it needs `backupCodes`,
 *   becomes the default, and both sessions are stamped as having passed the step, the one that
 *   turned it on and the one that approved, so each counts as another device from then on.
 * The token and the request are used up with it.
 */
export async function confirmDeviceFactor(input: {
    userId: string;
    factorId: string;
    sessionTokenHash: Buffer;
    credentialVersion: number;
    tokenHash: Buffer;
    requestId: string;
    backupCodes?: { keyId: Buffer; hashes: Buffer[] };
}): Promise<ConfirmDeviceFactorResult> {
    return db.transaction(async (tx): Promise<ConfirmDeviceFactorResult> => {
        if (!(await lockAccount(tx, input.userId)) || !(await sessionIsCurrent(tx, input)))
            return { status: 'session' };
        const factor = await deviceFactor(tx, input.userId);
        if (!factor || factor.confirmed || factor.id !== input.factorId)
            return { status: 'missing' };
        const attempt = await readAttempt(tx, input.tokenHash);
        if (
            !attempt ||
            attempt.userId !== input.userId ||
            attempt.purpose !== 'device-approval' ||
            !attempt.sessionTokenHash?.equals(input.sessionTokenHash)
        )
            return { status: 'missing' };
        const [request] = await tx
            .select()
            .from(twoStepDeviceRequests)
            .where(
                and(
                    eq(twoStepDeviceRequests.id, input.requestId),
                    eq(twoStepDeviceRequests.userId, input.userId),
                    eq(twoStepDeviceRequests.tokenHash, input.tokenHash),
                    eq(twoStepDeviceRequests.purpose, 'device-approval'),
                    gt(twoStepDeviceRequests.expiresAt, new Date()),
                ),
            )
            .for('update');
        if (!request) return { status: 'missing' };
        if (request.state !== 'approved')
            return { status: request.state === 'ended' ? 'missing' : 'pending' };
        const approverDeviceId = request.approverDeviceId;
        if (!approverDeviceId || !(await mayApprove(tx, request, approverDeviceId)))
            return { status: 'missing' };
        const confirmed = await confirmedFactors(tx, input.userId);
        const turnedOn = confirmed.length === 0;
        const codes = input.backupCodes;
        if (turnedOn && !codes) return { status: 'codes-required' };
        const now = new Date();
        await tx
            .update(twoStepFactors)
            .set({ confirmedAt: now, lastUsedAt: hourOf(now) })
            .where(eq(twoStepFactors.id, factor.id));
        await settleDefault(
            tx,
            input.userId,
            confirmed.map(({ kind }) => kind),
            turnedOn ? 'device' : undefined,
        );
        if (turnedOn && codes) {
            await ensureState(tx, input.userId);
            await tx.delete(twoStepBackupCodes).where(eq(twoStepBackupCodes.userId, input.userId));
            await tx.insert(twoStepBackupCodes).values(
                codes.hashes.map((codeHash) => ({
                    userId: input.userId,
                    codeHash,
                    keyId: codes.keyId,
                    createdAt: now,
                })),
            );
            // A fresh start, as when an app turns the step on.
            await tx
                .update(twoStepState)
                .set({ consecutiveFailures: 0, totpFrozenAt: null })
                .where(eq(twoStepState.userId, input.userId));
            await tx
                .delete(twoStepFactors)
                .where(
                    and(
                        eq(twoStepFactors.userId, input.userId),
                        isNull(twoStepFactors.confirmedAt),
                    ),
                );
            await tx
                .delete(twoStepKeyRegistrations)
                .where(eq(twoStepKeyRegistrations.userId, input.userId));
            // Both sessions passed this step together: the one that asked and the one that approved.
            await tx
                .update(sessions)
                .set({ twoStepAt: sql`coalesce(${sessions.twoStepAt}, ${now})` })
                .where(
                    and(
                        eq(sessions.userId, input.userId),
                        or(
                            eq(sessions.tokenHash, input.sessionTokenHash),
                            eq(sessions.deviceId, approverDeviceId),
                        ),
                    ),
                );
        }
        await tx.delete(twoStepAttempts).where(eq(twoStepAttempts.tokenHash, input.tokenHash));
        await tx
            .update(twoStepDeviceRequests)
            .set({ state: 'ended', endedReason: 'used', endedAt: now })
            .where(eq(twoStepDeviceRequests.id, request.id));
        return { status: 'ok', turnedOn, approverDeviceId };
    });
}

/* Ends every open request of an account whose method was removed. The caller holds its lock. */
export async function endRequestsOfRemovedMethod(tx: Tx, userId: string) {
    await endDeviceRequests(tx, { userId, reason: 'off' });
    await tx
        .delete(twoStepAttempts)
        .where(
            and(eq(twoStepAttempts.userId, userId), eq(twoStepAttempts.purpose, 'device-approval')),
        );
}

/*
 * The token was answered another way (a code, a key, the phrase): its open request ends there,
 * whatever that answer turns out to be. It is not a failed step of its own: the answer is
 * counted, or not, as what it is.
 */
export async function endRequestsOfToken(attempt: StepAttempt) {
    await db.transaction(async (tx) => {
        if (!(await lockAccount(tx, attempt.userId))) return;
        await endDeviceRequests(tx, {
            userId: attempt.userId,
            tokenHash: attempt.tokenHash,
            reason: 'passed',
        });
    });
}

import { OPAQUE_IDENTIFIERS, OPAQUE_PROFILE_VERSION } from '@hushos/crypto';
import { ready, server } from '@hushos/crypto/server';

/*
 * A password proved again by a signed-in session (deleting the account, a
 * security change, removing devices): a one-use OPAQUE attempt started by that
 * session for that purpose, then finished with the client's KE3. Everything an
 * attempt is bound to is checked here, in one place, so no caller can forget a
 * check: the purpose, the account, its credential version, the session that
 * started it, the expiry, the profile, and finally the OPAQUE finish itself.
 * The caller consumes the attempt (a DELETE … RETURNING) before calling this,
 * so a replay finds nothing.
 */
export type BoundPurpose = 'delete' | 'password' | 'master-key' | 'recovery-key' | 'devices';

export type StoredAttempt = {
    purpose: string;
    userId: string | null;
    credentialVersion: number | null;
    sessionTokenHash: Buffer | null;
    expiresAt: Date;
    profileVersion: number;
    serverState: string;
};

export async function boundAttemptHolds(
    attempt: StoredAttempt | null,
    expected: {
        purpose: BoundPurpose;
        userId: string;
        credentialVersion: number;
        sessionTokenHash: Buffer;
    },
    finishLoginRequest: string,
    now: number = Date.now(),
) {
    if (
        !attempt ||
        attempt.purpose !== expected.purpose ||
        attempt.userId !== expected.userId ||
        attempt.credentialVersion !== expected.credentialVersion ||
        !attempt.sessionTokenHash?.equals(expected.sessionTokenHash) ||
        attempt.expiresAt.getTime() <= now ||
        attempt.profileVersion !== OPAQUE_PROFILE_VERSION
    )
        return false;
    await ready;
    try {
        server.finishLogin({
            serverLoginState: attempt.serverState,
            finishLoginRequest,
            identifiers: OPAQUE_IDENTIFIERS,
        });
        return true;
    } catch {
        return false;
    }
}

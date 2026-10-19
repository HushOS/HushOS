/*
 * Signing out finishes after the sign-in page is on screen: the device is wiped once more when
 * the open workspace has closed, and that can wait seconds on a database another tab holds. A
 * sign-in started meanwhile (a password manager makes it quick) would open the new session's
 * upload journal and family stores, and the wipe would take them. So a sign-in waits for any
 * sign-out still clearing this device, in this tab and, through a Web Lock, in the others.
 */

/* Past this, a sign-in stops waiting on a sign-out and says so; the wait is let go. */
export const SIGN_IN_WAIT_MS = 35_000;
const LOCK = 'hushos-sign-out';

let pending: Promise<unknown> = Promise.resolve();
/* Sign-outs that reached the server: a sign-in queued before one of them is stale. */
let signedOut = 0;

function lockManager() {
    return typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined;
}

function within<T>(work: Promise<T>, ms: number, message: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export const UNFINISHED =
    'Signing out of this browser hasn’t finished. Reload the page, then sign in again.';
export const SIGNED_OUT_MEANWHILE = 'You were signed out while this was waiting. Sign in again.';

/*
 * Called by a sign-out for the work a sign-in must not overlap. Other tabs wait on the same
 * lock while it is held, never longer than a sign-in would wait here.
 */
export function holdSignIn(work: Promise<unknown>) {
    const settled = work.catch(() => {});
    pending = Promise.all([pending, settled]);
    void lockManager()
        ?.request(LOCK, () => within(settled, SIGN_IN_WAIT_MS, UNFINISHED).catch(() => {}))
        .catch(() => {});
}

/* Called once a sign-out's logout reached the server, before the sign-in page is shown. */
export function markSignedOut() {
    signedOut++;
}

/*
 * Resolves once every sign-out begun so far, here or in another tab, has finished clearing
 * this device. One that never finishes is given up on after SIGN_IN_WAIT_MS: the wait is let
 * go and the sign-in fails with words a person can act on.
 */
export async function signOutSettled() {
    const waited = pending;
    const locks = lockManager();
    try {
        await within(
            Promise.all([
                waited,
                locks?.request(LOCK, { mode: 'shared' }, () => {}).catch(() => {}),
            ]),
            SIGN_IN_WAIT_MS,
            UNFINISHED,
        );
    } catch (error) {
        if (pending === waited) pending = Promise.resolve();
        throw error;
    }
}

type StartsSessions = {
    login: (...args: never[]) => Promise<unknown>;
    register: (...args: never[]) => Promise<unknown>;
    recover: (...args: never[]) => Promise<unknown>;
    logout: () => Promise<unknown>;
};

/*
 * The auth client with every way of starting a session made to wait for signOutSettled(). One
 * that was waiting when a sign-out reached the server (an unlock pressed on the locked screen
 * while signing out stalled) is refused rather than left open behind the sign-in page; one that
 * got its session as that sign-out landed signs out again.
 */
export function afterSignOut<C extends StartsSessions>(client: C): C {
    const wait =
        <A extends unknown[], R>(start: (...args: A) => Promise<R>) =>
        async (...args: A) => {
            const before = signedOut;
            await signOutSettled();
            if (signedOut !== before) throw new Error(SIGNED_OUT_MEANWHILE);
            const result = await start(...args);
            if (signedOut !== before) {
                await client.logout().catch(() => {});
                throw new Error(SIGNED_OUT_MEANWHILE);
            }
            return result;
        };
    return {
        ...client,
        login: wait(client.login),
        register: wait(client.register),
        recover: wait(client.recover),
    };
}

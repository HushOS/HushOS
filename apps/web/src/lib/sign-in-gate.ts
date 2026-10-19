/*
 * Signing out finishes after the sign-in page is on screen: the device is wiped once more when
 * the open workspace has closed, and that can wait seconds on a database another tab holds. A
 * sign-in started meanwhile (a password manager makes it quick) would open the new session's
 * upload journal and family stores, and the wipe would take them. So a sign-in waits for any
 * sign-out still clearing this device.
 */
let pending: Promise<unknown> = Promise.resolve();

/* Called by a sign-out for the work a sign-in must not overlap; its failure is the sign-out's to say. */
export function holdSignIn(work: Promise<unknown>) {
    const settled = work.catch(() => {});
    pending = Promise.all([pending, settled]);
}

/* Resolves once every sign-out begun so far has finished clearing this device. */
export function signOutSettled() {
    return pending.then(() => {});
}

type StartsSessions = {
    login: (...args: never[]) => Promise<unknown>;
    register: (...args: never[]) => Promise<unknown>;
    recover: (...args: never[]) => Promise<unknown>;
};

/* The auth client with every way of starting a session made to wait for signOutSettled(). */
export function afterSignOut<C extends StartsSessions>(client: C): C {
    const wait =
        <A extends unknown[], R>(start: (...args: A) => Promise<R>) =>
        async (...args: A) => {
            await signOutSettled();
            return start(...args);
        };
    return {
        ...client,
        login: wait(client.login),
        register: wait(client.register),
        recover: wait(client.recover),
    };
}

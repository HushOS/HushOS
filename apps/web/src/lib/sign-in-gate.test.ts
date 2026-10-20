import { afterEach, expect, test, vi } from 'vitest';

/*
 * The sign-in gate across tabs. A sign-out keeps clearing this device after the sign-in page
 * is up, and other tabs can only know through the `hushos-sign-out` Web Lock; a sign-in in
 * another tab that stopped waiting on it would open its new session's stores while the wipe
 * is still taking them. Each tab is its own copy of the module, sharing one lock manager, as
 * two tabs share the browser's.
 */

/*
 * A minimal navigator.locks (jsdom has none): exclusive and shared modes, granted in order, and
 * ifAvailable, which runs the callback with null at once when the lock is taken.
 */
function stubLocks() {
    type Waiting = { mode: LockMode; grant: () => void };
    const held = new Map<string, LockMode[]>();
    const queued = new Map<string, Waiting[]>();
    const pump = (name: string) => {
        const holding = held.get(name) ?? [];
        const queue = queued.get(name) ?? [];
        while (queue.length > 0) {
            const next = queue[0]!;
            const free =
                holding.length === 0 || (next.mode === 'shared' && !holding.includes('exclusive'));
            if (!free) break;
            queue.shift();
            holding.push(next.mode);
            next.grant();
        }
        held.set(name, holding);
        queued.set(name, queue);
    };
    const locks = {
        request(name: string, ...args: unknown[]) {
            const callback = args.at(-1) as (
                lock: { name: string; mode: LockMode } | null,
            ) => unknown;
            const options = args.length > 1 ? (args[0] as LockOptions) : {};
            const mode = options.mode ?? 'exclusive';
            const holding = held.get(name) ?? [];
            const taken =
                (queued.get(name) ?? []).length > 0 ||
                (holding.length > 0 && (mode === 'exclusive' || holding.includes('exclusive')));
            if (options.ifAvailable && taken) return Promise.resolve().then(() => callback(null));
            return new Promise((resolve, reject) => {
                const grant = () => {
                    void Promise.resolve()
                        .then(() => callback({ name, mode }))
                        .then(resolve, reject)
                        .finally(() => {
                            const holding = held.get(name)!;
                            holding.splice(holding.indexOf(mode), 1);
                            pump(name);
                        });
                };
                queued.set(name, [...(queued.get(name) ?? []), { mode, grant }]);
                pump(name);
            });
        },
    };
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}

async function openTab() {
    vi.resetModules();
    return import('./sign-in-gate');
}

afterEach(() => {
    delete (navigator as { locks?: unknown }).locks;
});

test('a sign-in in one tab waits until a sign-out in another has finished clearing the device', async () => {
    stubLocks();
    const leaving = await openTab();
    const signingIn = await openTab();

    // The first tab signed out and is still wiping the device (a database another tab holds).
    let wiped!: () => void;
    leaving.holdSignIn(new Promise<void>((resolve) => (wiped = resolve)));

    // The second tab signs straight back in.
    const opened: string[] = [];
    const client = signingIn.afterSignOut({
        login: async () => {
            opened.push('maya');
        },
        register: async () => {},
        recover: async () => {},
        logout: async () => {},
    });
    const signIn = client.login();
    await new Promise((resolve) => setTimeout(resolve, 50));
    // No session opened while the wipe could still take its stores.
    expect(opened).toEqual([]);

    wiped();
    await signIn;
    expect(opened).toEqual(['maya']);
});

/*
 * Editors with unsaved text, so locking writes their drafts first (lib/drafts.ts): a lock drops
 * the editor's text, and its draft is what brings it back after the unlock. A lock reaches every
 * tab of this browser at once, so the tab that locks asks the others too, over a
 * BroadcastChannel: each tab with an open editor says it is writing, writes, and says it is done,
 * and the lock waits for them, never longer than `ms`. Imports nothing, so the lock control
 * carries none of the editor's code.
 */
const flushers = new Set<() => Promise<void>>();
const CHANNEL = 'hushos-draft-flush';
/* How long the asking tab waits for another tab to say it is writing before taking it there is none. */
const ANSWER_MS = 250;

type Message =
    | { kind: 'ask'; id: string; from: string }
    | { kind: 'writing' | 'written'; id: string; tab: string };

const tab = typeof crypto !== 'undefined' ? crypto.randomUUID() : String(Math.random());
let listening: BroadcastChannel | null = null;

function within(work: Promise<unknown>, ms: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        work.then(() => {}),
        new Promise<void>((resolve) => {
            timer = setTimeout(resolve, ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

/* This tab's editors, written now. */
function flushHere(ms: number) {
    if (flushers.size === 0) return Promise.resolve();
    return within(Promise.allSettled([...flushers].map((flush) => flush())), ms);
}

/* Answers another tab's lock: writes this tab's editors, saying so before and after. */
function listen() {
    if (listening || typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(CHANNEL);
    listening = channel;
    // Node's (in tests) would otherwise keep the process alive; browsers have no such method.
    (channel as { unref?: () => void }).unref?.();
    channel.onmessage = (event: MessageEvent<Message>) => {
        const message = event.data;
        if (message?.kind !== 'ask' || message.from === tab || flushers.size === 0) return;
        channel.postMessage({ kind: 'writing', id: message.id, tab } satisfies Message);
        void flushHere(1_500).then(() =>
            channel.postMessage({ kind: 'written', id: message.id, tab } satisfies Message),
        );
    };
}

/* Registers an open editor's flush; the returned function unregisters it. */
export function flushBeforeLock(flush: () => Promise<void>) {
    flushers.add(flush);
    listen();
    return () => {
        flushers.delete(flush);
    };
}

/* Every other tab's editors, asked to write, and waited for: none answering within ANSWER_MS is none. */
function flushOthers(ms: number) {
    if (typeof BroadcastChannel === 'undefined') return Promise.resolve();
    const channel = new BroadcastChannel(CHANNEL);
    const id = crypto.randomUUID();
    const writing = new Set<string>();
    let graceOver = false;
    let finish: () => void = () => {};
    const done = new Promise<void>((resolve) => {
        finish = resolve;
    });
    const settle = () => {
        if (graceOver && writing.size === 0) finish();
    };
    channel.onmessage = (event: MessageEvent<Message>) => {
        const message = event.data;
        if (message?.kind === 'ask' || message?.id !== id) return;
        if (message.kind === 'writing') writing.add(message.tab);
        else writing.delete(message.tab);
        settle();
    };
    const grace = setTimeout(() => {
        graceOver = true;
        settle();
    }, ANSWER_MS);
    channel.postMessage({ kind: 'ask', id, from: tab } satisfies Message);
    return within(done, ms).finally(() => {
        clearTimeout(grace);
        channel.close();
    });
}

/* Writes every open editor's draft in this browser, never waiting longer than `ms`: a lock is never held up for long. */
export async function flushDrafts(ms = 1_500) {
    await Promise.all([flushHere(ms), flushOthers(ms)]);
}

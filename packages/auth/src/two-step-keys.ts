import {
    deriveTwoStepKey,
    openTotpSecret,
    sealTotpSecret,
    twoStepKeyId,
} from '@hushos/crypto/two-step/server';
import { authRepository, twoStepRepository } from '@hushos/db';
import { opaqueEnv } from '@hushos/env/opaque';
import { twoStepEnv } from '@hushos/env/two-step';

/*
 * The two-step key, and moving what is sealed under an old one to the current one
 * (docs/two-step-design.md 8). The web service and the worker both build their keys here,
 * from the same settings, so the two never disagree about which key a row names. Nothing in
 * this module is logged or returned but key ids (the first 8 bytes of a key's SHA-256) and
 * counts.
 */

export type TwoStepKeyring = {
    /* The key new secrets and codes are made under. */
    current: { key: Uint8Array; id: Buffer };
    /* Every key this process has, by the id a row records. */
    byId: Map<string, Uint8Array>;
};

/*
 * The key new secrets and codes are made under, and every key older rows may name: the
 * operator's TWO_STEP_KEY when set, its predecessor during a rotation, and the key derived
 * from the OPAQUE server setup, which is what an instance used before it set one. The worker
 * moves authenticator secrets to the current key (`resealTwoStepSecrets`); backup codes stay
 * under the key they were hashed with until their owner makes a new set.
 *
 * `serverSetup` is null only for a process that has none to read (a worker whose operator
 * keeps the setup in the web service's environment alone): then there is no derived key, and
 * without a TWO_STEP_KEY either there is no keyring at all.
 */
export async function twoStepKeyring(input: {
    serverSetup: string | null;
    key?: string;
    previousKey?: string;
}): Promise<TwoStepKeyring | null> {
    const decode = (value: string) => new Uint8Array(Buffer.from(value, 'base64url'));
    const derived = input.serverSetup ? await deriveTwoStepKey(decode(input.serverSetup)) : null;
    const explicit = input.key ? decode(input.key) : null;
    const previous = input.previousKey ? decode(input.previousKey) : null;
    const byId = new Map<string, Uint8Array>();
    for (const key of [derived, previous, explicit])
        if (key) byId.set(Buffer.from(await twoStepKeyId(key)).toString('hex'), key);
    const current = explicit ?? derived;
    if (!current) return null;
    return { current: { key: current, id: Buffer.from(await twoStepKeyId(current)) }, byId };
}

/* This process's keys, from its own settings (TWO_STEP_KEY and TWO_STEP_PREVIOUS_KEY, or their files). */
export function twoStepKeyringFromEnv(serverSetup: string | null) {
    return twoStepKeyring({
        serverSetup,
        key: twoStepEnv.TWO_STEP_KEY,
        previousKey: twoStepEnv.TWO_STEP_PREVIOUS_KEY,
    });
}

/*
 * The OPAQUE server setup as a process that never makes one finds it: in its environment, or
 * where the web service stored it on first start. Null when it is in neither place.
 */
export async function storedServerSetup() {
    return (
        opaqueEnv.OPAQUE_SERVER_SETUP ??
        (await authRepository.getServerSecret(`opaque-setup:${opaqueEnv.OPAQUE_SERVER_SETUP_ID}`))
    );
}

/* What one pass over the table did. Counts and key ids only. */
export type ResealCounts = {
    /* Moved to the current key. */
    moved: number;
    /* Changed or removed between being read and being written: left for the next run. */
    changed: number;
    /* Sealed under a key this process has, and not opened by it: damaged, or not the row it claims to be. */
    unopened: number;
    /* Sealed under a key this process does not have, by that key's id. */
    unknown: Record<string, number>;
};

/*
 * One pass: every authenticator secret that is not under the current key is opened with the
 * key its row names and sealed again under the current one. The secret is the same secret, so
 * the person's app goes on showing the right codes and nothing they see changes.
 *
 * - A row under a key this process does not have is left exactly as it is: the key may be
 *   put back (TWO_STEP_PREVIOUS_KEY), and until then only that key opens it.
 * - A row that does not open under the key it names is left too. The seal binds the account,
 *   the method and the key, so bytes copied from another row, or damaged, do not open, and
 *   re-sealing must never give them a fresh, valid seal.
 * - Each write replaces the row only if it is still the row that was read (the repository's
 *   `resealTotpSecret`), so a second run, a new app or a removal at the same moment wins.
 *
 * Idempotent: a second pass finds nothing the first one moved.
 */
export async function resealTotpSecrets(
    keyring: TwoStepKeyring,
    options: { batchSize?: number; signal?: AbortSignal } = {},
): Promise<ResealCounts> {
    const counts: ResealCounts = { moved: 0, changed: 0, unopened: 0, unknown: {} };
    let after: string | null = null;
    for (;;) {
        options.signal?.throwIfAborted();
        const page: twoStepRepository.SealedTotp[] = await twoStepRepository.listTotpSealedOutside({
            keyId: keyring.current.id,
            after,
            limit: options.batchSize,
        });
        for (const row of page) {
            const sealedWith = row.keyId.toString('hex');
            const key = keyring.byId.get(sealedWith);
            if (!key) {
                counts.unknown[sealedWith] = (counts.unknown[sealedWith] ?? 0) + 1;
                continue;
            }
            const names = { userId: row.userId, factorId: row.id };
            const secret = await openTotpSecret({
                sealed: row.sealedSecret,
                nonce: row.nonce,
                key,
                ...names,
            });
            if (!secret) {
                counts.unopened++;
                continue;
            }
            const sealed = await sealTotpSecret({ secret, key: keyring.current.key, ...names });
            secret.fill(0);
            const moved = await twoStepRepository.resealTotpSecret({
                id: row.id,
                from: row,
                to: {
                    keyId: Buffer.from(sealed.keyId),
                    nonce: Buffer.from(sealed.nonce),
                    sealedSecret: Buffer.from(sealed.sealed),
                },
            });
            if (moved) counts.moved++;
            else counts.changed++;
        }
        const last = page.at(-1);
        if (!last) return counts;
        after = last.id;
    }
}

/* How long every running web process must have sealed under a key before secrets are moved to it. */
export const RESEAL_GRACE_MS = 30 * 60_000;

/*
 * Why nothing is moved yet:
 * - `no-reader`: no web process has been seen in the last five minutes;
 * - `cannot-read`: a running web process does not have the worker's current key at all;
 * - `other-key`: a running web process seals new secrets under another key;
 * - `grace`: every running web process seals under it, and not all have for 30 minutes yet.
 */
export type ResealWait = 'no-reader' | 'cannot-read' | 'other-key' | 'grace';

/*
 * Whether the web processes agree on `sealedWith` (a key id) as the key to seal under, enough
 * for the worker to move older secrets to it. Re-sealing overwrites the old seal, so it waits
 * for two things:
 *
 * - **Every web process seen in the last five minutes can read the key and seals under it.**
 *   During a rolling update some processes are still on the old settings: a secret moved to
 *   the new key would be unreadable to them, and the person's sign-in would land on one of
 *   them. The worker being given a key the web service was not is the same case.
 * - **Each of them has sealed under it for 30 minutes.** A rollout that is taken back in its
 *   first minutes then finds every secret where it was, still under the old key. A process
 *   that restarts is a new reader and waits its own 30 minutes.
 *
 * A process that has not been seen for five minutes no longer counts: it exited.
 */
export function sealingAgreed(
    readers: twoStepRepository.KeyReader[],
    sealedWith: string,
    now: Date,
):
    | { agreed: true }
    | { agreed: false; reason: ResealWait; webSealsWith: string[]; readyAt: Date | null } {
    const webSealsWith = [...new Set(readers.map((reader) => reader.sealingKeyId))].sort();
    const waiting = (reason: ResealWait, readyAt: Date | null = null) =>
        ({ agreed: false, reason, webSealsWith, readyAt }) as const;
    if (!readers.length) return waiting('no-reader');
    if (readers.some((reader) => !reader.readableKeyIds.includes(sealedWith)))
        return waiting('cannot-read');
    if (readers.some((reader) => reader.sealingKeyId !== sealedWith)) return waiting('other-key');
    const newest = Math.max(...readers.map((reader) => reader.sealingSince.getTime()));
    const readyAt = new Date(newest + RESEAL_GRACE_MS);
    return readyAt > now ? waiting('grace', readyAt) : { agreed: true };
}

export type ResealRun =
    /* This process has no key to seal under: no TWO_STEP_KEY, and no OPAQUE setup it can read. */
    | { status: 'no-key' }
    /* The web processes do not agree on this process's current key yet (`sealingAgreed`). Nothing was touched. */
    | {
          status: 'waiting';
          /* The id of this process's current key. */
          sealedWith: string;
          reason: ResealWait;
          /* How many web processes were seen in the last five minutes, and the key ids they seal under. */
          readers: number;
          webSealsWith: string[];
          /* `grace`: when the 30 minutes are over, if no web process restarts before. */
          readyAt: string | null;
      }
    | ({
          status: 'done';
          /* The id of the current key. */
          sealedWith: string;
          /* Authenticator secrets still under another key after this run, by key id. */
          left: Record<string, number>;
          /* Accounts with unused backup codes under another key, by key id. They are never re-keyed. */
          backupCodes: Record<string, number>;
      } & ResealCounts);

/*
 * The worker's run after a rotation of the two-step key. It moves secrets to its current key
 * only once the web processes agree on that key (`sealingAgreed`), and otherwise touches
 * nothing and says why. Rows of web processes long gone are dropped on the way.
 */
export async function resealTwoStepSecrets(
    options: {
        batchSize?: number;
        signal?: AbortSignal;
        keyring?: TwoStepKeyring | null;
        /* The moment the run is judged at; the database's clock when not given. */
        now?: Date;
    } = {},
): Promise<ResealRun> {
    const keyring =
        options.keyring === undefined
            ? await twoStepKeyringFromEnv(await storedServerSetup())
            : options.keyring;
    // Before anything else: the rows of web processes long gone go whether or not this
    // worker has a key to seal under, or they would pile up for as long as it has none.
    await twoStepRepository.dropStaleKeyReaders(options.now);
    if (!keyring) return { status: 'no-key' };
    const sealedWith = keyring.current.id.toString('hex');
    const { now, readers } = await twoStepRepository.liveKeyReaders(options.now);
    const web = sealingAgreed(readers, sealedWith, now);
    if (!web.agreed)
        return {
            status: 'waiting',
            sealedWith,
            reason: web.reason,
            readers: readers.length,
            webSealsWith: web.webSealsWith,
            readyAt: web.readyAt?.toISOString() ?? null,
        };
    const counts = await resealTotpSecrets(keyring, options);
    const under = await twoStepRepository.sealedUnder();
    const others = <T extends { keyId: Buffer }>(rows: T[], count: (row: T) => number) =>
        Object.fromEntries(
            rows
                .filter((row) => !row.keyId.equals(keyring.current.id))
                .map((row) => [row.keyId.toString('hex'), count(row)]),
        );
    return {
        status: 'done',
        sealedWith,
        ...counts,
        left: others(under.totp, (row) => row.secrets),
        backupCodes: others(under.backupCodes, (row) => row.accounts),
    };
}

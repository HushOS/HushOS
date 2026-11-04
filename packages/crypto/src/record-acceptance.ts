import {
    FAMILY_FORGOTTEN,
    NOT_THIS_ACCOUNT,
    NO_ACCOUNT,
    OLDER_CHAIN,
    OPEN_SETTINGS,
    SPLIT_CHAIN,
} from './protocol';

/*
 * The order a family's served chain is accepted in against this device's
 * record (docs/groups-design.md 2.4 step 3 and 2.7). The data layer
 * (apps/web/src/lib/groups/sync.ts) runs it with each attempt fetching route
 * 5 and handing the worker's groupAccept what it served; the Rust core's
 * `AreaLedger::accept_served` is its twin, answering `FetchFromVersionOne`
 * where this fetches again from version 1.
 *
 * 1. After the record's roster version, continuing its cache.
 * 2. Refused, or overtaken (served short of the chain this session already
 *    committed: a damaged cache that names no head does that): from version
 *    1, the cache still given (its digests are marks, so a server that served
 *    another history gets the fork, not a quiet refusal). Skipped when the
 *    first attempt was already from version 1.
 * 3. Refused again: from version 1 with the cache left out (`withoutCache`),
 *    the record's own pin still a mark beside the settings pin. The cache may
 *    be what is refused (one a newer release wrote, or a damaged one), and
 *    retrying with it would refuse the family on this device for good; the
 *    pin keeps every chain below the record's version and digest a rollback,
 *    so a server that gets the cache refused and serves older settings rolls
 *    nothing back. Never against the settings pin alone.
 *
 * Without a record there is one attempt, from version 1. A run overtaken
 * from version 1 (the worker refusing what a later acceptance in the same
 * session overtook, OLDER_CHAIN or SPLIT_CHAIN), an account error (the
 * session forgotten or another account open meanwhile) and any error `rethrow`
 * names (the route's own answers) are the caller's, never retried here.
 *
 * `accept` is told whether a refusal of that attempt is retried here
 * (`retried`): the worker then keeps the family committed under the chain it
 * already holds, and only the last attempt's refusal (or a fork) uncommits it,
 * so the family's folders are not held back between attempts.
 */
export async function acceptFromRecord<T>(
    recordVersion: number | null,
    accept: (after: number, withoutCache: boolean, retried: boolean) => Promise<T>,
    rethrow: (error: unknown) => boolean = () => false,
): Promise<T> {
    const passes = (error: unknown) => accountError(error) || rethrow(error);
    try {
        // With a record a refusal here is always tried again (from version 1, then without the cache).
        return await accept(recordVersion ?? 0, false, recordVersion !== null);
    } catch (error) {
        if (recordVersion === null || passes(error)) throw error;
        // Overtaken on the continuation: a reason to fetch from version 1, once. From version 1 it is the answer.
        if (recordVersion === 0 && lostRace(error)) throw error;
        try {
            if (recordVersion === 0) throw error;
            return await accept(0, false, true);
        } catch (again) {
            if (lostRace(again) || passes(again)) throw again;
            return await accept(0, true, false);
        }
    }
}

/*
 * The worker's answer to a run begun under a session or account that is gone,
 * or before the account was unlocked or its settings opened, or of a family
 * the session let go of while it ran: nothing the server served is in
 * question, so no attempt is retried for it (a retry would take the family
 * back after its wipe).
 */
export function accountError(error: unknown) {
    return (
        error instanceof Error &&
        [NOT_THIS_ACCOUNT, NO_ACCOUNT, OPEN_SETTINGS, FAMILY_FORGOTTEN].includes(error.message)
    );
}

/* The worker's answer to a run that a later acceptance in the same session overtook. */
export function lostRace(error: unknown) {
    return (
        error instanceof Error && (error.message === OLDER_CHAIN || error.message === SPLIT_CHAIN)
    );
}

/*
 * After three runs that all came back overtaken, it is no race: the server
 * keeps serving an older member list than this device already checked, or
 * another one at its version. The core's `served_race_message` says the same.
 */
export const SERVED_OLDER =
    'HushOS sent an older member list than this device already checked. Try again later.';
export const SERVED_SPLIT =
    'HushOS sent a different member list at the version this device already checked. Try again later.';
export function servedRaceMessage(split: boolean) {
    return split ? SERVED_SPLIT : SERVED_OLDER;
}

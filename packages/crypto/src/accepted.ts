import { CryptoError } from './errors';

/*
 * Every chain acceptRosters returned, and nothing else. Every function that
 * trusts a chain takes it only if it is here: the three seals and their
 * openings, member signers, nextRoster, checkNextRoster, checkNextSuccession,
 * pinAfter, trustAsGroupDoes and groupWriterTrust. An object written out by
 * hand, or a copy of an accepted one with a field swapped, opens and vouches
 * for nothing; the chain itself is frozen (its byte arrays cannot be, and
 * nothing reads trust from them). Not exported from the package.
 */
const accepted = new WeakSet<object>();

export function markAccepted<T extends object>(chain: T): T {
    accepted.add(chain);
    return chain;
}

export function requireAccepted(chain: object) {
    if (!accepted.has(chain))
        throw new CryptoError('This is not a member list this device accepted.');
}

/*
 * Every chain the server's acceptance made (acceptStoredChain, and
 * checkNextRoster / checkNextSuccession), and nothing else: a registry of its
 * own, so a stored chain passes requireStoredOrAccepted and never
 * requireAccepted. It anchors on what the server stored, with no words check
 * and no marks, so no seal, opening or verdict may take it.
 */
const stored = new WeakSet<object>();

export function markStored<T extends object>(chain: T): T {
    stored.add(chain);
    return chain;
}

/* A chain a device accepted, or one the server's acceptance made: what checkNext* continue from. */
export function requireStoredOrAccepted(chain: object) {
    if (!accepted.has(chain) && !stored.has(chain))
        throw new CryptoError('This is not a member list this device or the server accepted.');
}

/*
 * What the server's acceptance needs and no client has: group-trust.ts takes it
 * only from the server entry (group-trust-server.ts). This module is not
 * exported from the package, so an app cannot reach it.
 */
export const STORED_ACCEPTANCE: unique symbol = Symbol('stored acceptance');

/* Freezes an accepted chain's plain parts all the way down (byte arrays cannot be frozen). */
export function deepFreeze<T>(value: T): T {
    if (typeof value === 'object' && value !== null && !ArrayBuffer.isView(value)) {
        for (const inner of Object.values(value)) deepFreeze(inner);
        Object.freeze(value);
    }
    return value;
}

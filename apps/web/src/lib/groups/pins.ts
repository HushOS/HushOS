import type { CryptoResults, GroupPin } from '@hushos/crypto';
import type { GroupContext } from './context';

/*
 * The cross-device mark (F4; docs/groups-design.md 2.7, the 1c plan 1.4).
 * After every committed acceptance the worker hands back the pin it computed
 * (pinAfter over the settings pin and this device's own, through the chain it
 * just accepted); the device's own copy is already inside the sealed record.
 * Here that pin reaches the settings document, so every other device of the
 * account holds the mark too. Three rules:
 *
 * - **Never lower.** A settings pin at a later roster than the acceptance
 *   reached is never overwritten: another device saw more, and this one
 *   accepts again with that pin as a mark (a server that showed this device
 *   less is then a rollback, refused, or a fork, warned about).
 * - **Compare and set, then accept again.** When another device saved in
 *   between, the newer settings may carry a higher mark: they are read (the
 *   worker takes their pins as marks on the read), acceptance runs again, and
 *   only that pin is saved. A pin is never merged blind into settings this
 *   device did not accept against.
 * - **Areas only from opened grants.** An area enters `areas` only as
 *   groupOpenArea's `pinArea`, after the worker checked the area belongs to
 *   the group (areaOf) and opened its key; the chain's or the server's list of
 *   areas never adds one. pinAfter carries areas across pins but adds none.
 *
 * A pin is never written from a staged chain: the only pins here are the ones
 * a committed acceptance returned. A `not-member` wipe leaves the settings pin
 * alone (sync.ts): if the family comes back, it is still a mark, and joining
 * it again over another history stays refused.
 */

export type OpenedArea = CryptoResults['groupOpenArea']['pinArea'];
type Accepted = Extract<CryptoResults['groupAccept'], { status: 'accepted' }>;
type Fork = Extract<CryptoResults['groupAccept'], { status: 'fork' }>;
export type Reaccepted = Pick<Accepted, 'pin'> | Fork;

/*
 * `next`, with the opened areas folded in, as it may be saved over `current`:
 * - null when `current` is ahead of it (a later roster or group key), so it
 *   must not be written;
 * - 'conflict' when the two name other first keys, or other rosters or group
 *   keys at one version: never saved over, and acceptance (run again with the
 *   settings pin as a mark) says what it is.
 */
export function mergePin(
    current: GroupPin | null,
    next: GroupPin,
    opened: readonly OpenedArea[] = [],
): GroupPin | null | 'conflict' {
    if (current) {
        if (
            current.firstEd25519PublicKey !== next.firstEd25519PublicKey ||
            current.firstMlDsaPublicKeyDigest !== next.firstMlDsaPublicKeyDigest
        )
            return 'conflict';
        if (
            (current.rosterVersion === next.rosterVersion &&
                current.rosterDigest !== next.rosterDigest) ||
            (current.keyVersion === next.keyVersion &&
                current.groupKeyDigest !== next.groupKeyDigest)
        )
            return 'conflict';
        if (current.rosterVersion > next.rosterVersion || current.keyVersion > next.keyVersion)
            return null;
    }
    const areas: Record<string, number> = { ...current?.areas };
    for (const [workspaceId, version] of Object.entries(next.areas))
        areas[workspaceId] = Math.max(areas[workspaceId] ?? 0, version);
    for (const { workspaceId, version } of opened)
        areas[workspaceId] = Math.max(areas[workspaceId] ?? 0, version);
    return {
        ...next,
        // The earliest words check stands, whichever side made it.
        checkedAt:
            current && current.checkedAt < next.checkedAt ? current.checkedAt : next.checkedAt,
        areas,
    };
}

/* Whether saving `next` over `current` records anything new. */
export function pinAhead(current: GroupPin | null, next: GroupPin) {
    if (!current) return true;
    if (next.rosterVersion > current.rosterVersion || next.keyVersion > current.keyVersion)
        return true;
    if (next.checkedAt < current.checkedAt) return true;
    return Object.entries(next.areas).some(
        ([workspaceId, version]) => version > (current.areas[workspaceId] ?? 0),
    );
}

const ATTEMPTS = 4;

export type Settled = { status: 'settled'; pin: GroupPin | null } | Fork;

/*
 * Brings the settings pin of `groupId` up to `accepted.pin` (plus the areas
 * opened since). `reaccept` runs acceptance again after the settings were
 * read anew (so the worker holds their pin as a mark); it is called whenever
 * the stored pin is ahead of this one, conflicts with it, or a save lost a
 * race. A fork it returns is this function's answer: the worker has then
 * dropped the chain, and nothing is saved.
 */
export async function settlePin(
    ctx: GroupContext,
    groupId: string,
    accepted: Pick<Accepted, 'pin'>,
    options: { opened?: readonly OpenedArea[]; reaccept: () => Promise<Reaccepted> },
): Promise<Settled> {
    let pin = accepted.pin;
    const again = async () => {
        const result = await options.reaccept();
        if ('status' in result && result.status === 'fork') return result;
        pin = (result as Pick<Accepted, 'pin'>).pin;
        return null;
    };
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        // Read (and so opened in the worker) before anything is compared or saved.
        const { settings, version } = await ctx.settings.read();
        const current = settings.groups?.[groupId] ?? null;
        // An acceptance that wrote no pin has none to save.
        if (!pin) return { status: 'settled', pin: current };
        const merged = mergePin(current, pin, options.opened);
        if (merged === null || merged === 'conflict') {
            // Another device holds a higher or another mark: accept again against it.
            const fork = await again();
            if (fork) return fork;
            continue;
        }
        if (!pinAhead(current, merged)) return { status: 'settled', pin: current };
        const saved = await ctx.settings.write(version, {
            ...settings,
            groups: { ...settings.groups, [groupId]: merged },
        });
        if (saved) return { status: 'settled', pin: merged };
        // Another device saved first: its pin may be higher. Accept again with it as a mark.
        const fork = await again();
        if (fork) return fork;
    }
    throw new Error('Your settings keep changing on another device. Try again.');
}

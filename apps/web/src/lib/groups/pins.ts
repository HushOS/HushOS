import type { CryptoResults, GroupPin } from '@hushos/crypto';
import { mergePin, pinAhead, type OpenedArea } from '@hushos/crypto/pins';
import type { GroupContext } from './context';
import { withFamilyChecks } from './family-checks';

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

type Accepted = Extract<CryptoResults['groupAccept'], { status: 'accepted' }>;
type Fork = Extract<CryptoResults['groupAccept'], { status: 'fork' }>;
export type Reaccepted = Pick<Accepted, 'pin'> | Fork;

/*
 * mergePin and pinAhead live in @hushos/crypto/pins (pure, with a Rust twin,
 * `merge_pin` and `pin_ahead`): an opened area is groupOpenArea's `pinArea`.
 */
export type { OpenedArea };

const ATTEMPTS = 4;

export type Settled = { status: 'settled'; pin: GroupPin | null } | Fork;

/*
 * What vouched for the family in the acceptance being settled: the worker's
 * `checked`, or a creation this device finished (its own seed vouched, even
 * when this acceptance ran from the record it wrote first).
 */
export type Vouched = Pick<Accepted, 'checked'> & { created?: boolean };

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
    accepted: Pick<Accepted, 'pin'> & Partial<Vouched>,
    options: { opened?: readonly OpenedArea[]; reaccept: () => Promise<Reaccepted> },
): Promise<Settled> {
    const checked = accepted.created
        ? { how: 'created' as const, rosterVersion: 1 }
        : (accepted.checked ?? null);
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
        const merged = mergePin(groupId, current, pin, options.opened);
        if (merged === null || merged === 'conflict') {
            // Another device holds a higher or another mark: accept again against it.
            const fork = await again();
            if (fork) return fork;
            continue;
        }
        if (!pinAhead(current, merged)) return { status: 'settled', pin: current };
        // Never a family pin into settings without the first-use marker (docs/optional-verification.md
        // 7.2): the marker and a `before` record for each pin already there go in the same save,
        // derived again from the settings this attempt read.
        const marked = withFamilyChecks(settings, ctx.now().toISOString(), { groupId, checked });
        const saved = await ctx.settings.write(version, {
            ...marked,
            groups: { ...marked.groups, [groupId]: merged },
        });
        if (saved) return { status: 'settled', pin: merged };
        // Another device saved first: its pin may be higher. Accept again with it as a mark.
        const fork = await again();
        if (fork) return fork;
    }
    throw new Error('Your settings keep changing on another device. Try again.');
}

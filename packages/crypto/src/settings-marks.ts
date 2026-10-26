import { CryptoError } from './errors';
import { openSettings, type ContactPin, type Settings, type SettingsEnvelope } from './contacts';
import type { PairMark } from './group-trust';
import type { GroupPin } from './pins';

/*
 * The settings a session holds for an account (groups 1d, Core 6): the group
 * pins acceptance takes as marks and the contact pins an admission, the
 * admin's join code and an admission's resend read, as the worker keeps them
 * from the document it opened itself (session.ts's settingsOpen). The twin of
 * crates/hushos-core/src/ledger_settings.rs, which opens the served envelopes
 * in the core's AreaLedger; the shared fixtures run both
 * (settings-areas-testkit.ts, tests/common/settings_areas.rs).
 */

export const OLDER_SETTINGS =
    'The server sent older settings than this device has opened, so nothing was changed.';

export type SettingsMarks = {
    userId: string;
    /* `{ ...settings.groups }`: each family's pin as filed, checked (checkGroupPin) only when acceptance reads it. */
    pins: Record<string, GroupPin>;
    /* `{ ...settings.contacts }`: the only pins an admission or a join code reads. */
    contacts: Record<string, ContactPin>;
    /*
     * `{ ...settings.familyChecks }`: each family's check record as filed
     * (docs/optional-verification.md 3.4), read only when acceptance takes
     * that family's marks (familyCheckOf).
     */
    checks: Record<string, unknown>;
    /* Whether they came from a settings document that opened, not from "none". */
    opened: boolean;
    /* The highest settings version opened in this unlock (0: none): an older copy served again is refused. */
    settingsVersion: number;
};

/*
 * Within one unlock, settings that opened never give way to none (or to a
 * version 1 document, which opens as none): a server answering so would drop
 * the family pins, and with them the marks that keep a family from being
 * joined again onto another history (decision D7).
 */
export function refuseDowngrade(held: SettingsMarks | null, userId: string) {
    if (held?.userId === userId && held.opened) throw new CryptoError(OLDER_SETTINGS);
}

/*
 * The marks after `settings` (null: none stored) opened at `settingsVersion`,
 * or refused as a downgrade: none after settings that opened, or a document
 * older than the highest one opened in this unlock (a server serving 6, then
 * 5, would drop the pins 6 added).
 */
export function settingsMarks(
    held: SettingsMarks | null,
    userId: string,
    settings: { groups?: unknown; contacts?: unknown; familyChecks?: unknown } | null,
    settingsVersion = 0,
): SettingsMarks {
    if (settings === null) refuseDowngrade(held, userId);
    else if (held?.userId === userId && held.opened && settingsVersion < held.settingsVersion)
        throw new CryptoError(OLDER_SETTINGS);
    return {
        userId,
        pins: { ...(settings?.groups as Record<string, GroupPin> | undefined) },
        contacts: { ...(settings?.contacts as Record<string, ContactPin> | undefined) },
        checks: { ...(settings?.familyChecks as Record<string, unknown> | undefined) },
        opened: settings !== null,
        settingsVersion: settings === null ? 0 : settingsVersion,
    };
}

/*
 * The account's contact pin of `userId`: the first member whose key and whose
 * `userId` both lowercase to the id; null without one. A member that is no
 * object, or whose `userId` is no string, is no pin (it threw a TypeError
 * here before Core 6; the core skips it the same way).
 */
export function contactPinOf(
    marks: SettingsMarks | null,
    account: string,
    userId: string,
): ContactPin | null {
    if (!marks || marks.userId !== account) return null;
    const wanted = userId.toLowerCase();
    for (const [key, pin] of Object.entries(marks.contacts as Record<string, unknown>)) {
        if (key.toLowerCase() !== wanted || !pin || typeof pin !== 'object') continue;
        const filed = (pin as { userId?: unknown }).userId;
        if (typeof filed === 'string' && filed.toLowerCase() === wanted) return pin as ContactPin;
    }
    return null;
}

/*
 * The family's check record as filed: whether there is one (any value but
 * none or a JSON null), and the pair mark acceptance holds it as. A record
 * without a `code` (the migration's `before` record, docs/optional-verification.md
 * 7.2) is a mark but no pair mark; anything else is handed to acceptance as a
 * pair mark, which refuses that family alone when it is malformed.
 */
export function familyCheckOf(
    marks: SettingsMarks,
    groupId: string,
): { checked: boolean; pairMarks: PairMark[] } {
    const record = Object.hasOwn(marks.checks, groupId) ? marks.checks[groupId] : null;
    if (record === null || record === undefined) return { checked: false, pairMarks: [] };
    if (typeof record === 'object' && !Object.hasOwn(record, 'code'))
        return { checked: true, pairMarks: [] };
    const { rosterVersion, with: other, code } = record as Record<string, unknown>;
    return {
        checked: true,
        pairMarks: [{ rosterVersion, with: other, code } as PairMark],
    };
}

/* The family's settings pin as filed: null for none or a JSON null (acceptance filters both out). */
export function settingsPinOf(marks: SettingsMarks, groupId: string): GroupPin | null {
    return Object.hasOwn(marks.pins, groupId) ? (marks.pins[groupId] ?? null) : null;
}

/*
 * The worker's settingsOpen (session.ts calls it): none stored is "no
 * settings" for the account unlocked only; a version 1 envelope (null here)
 * is legacy settings, never a reading of "no settings"; version 2 opens under
 * the settings key settingsKeyOpen opened, and its pins become the marks.
 */
export async function settingsOpenFor(
    groups: {
        useSettings(userId: string, settings: Settings | null, settingsVersion?: number): void;
        legacySettings(userId: string): void;
    },
    input: {
        userId: string;
        envelope: SettingsEnvelope | null;
        settingsKey: Uint8Array<ArrayBuffer> | null;
        unlocked: boolean;
    },
): Promise<Settings | null> {
    const { userId, envelope } = input;
    if (envelope === null) {
        if (!input.unlocked) throw new CryptoError('Unlock your account first.');
        groups.useSettings(userId, null);
        return null;
    }
    const settings = await openSettings(input.settingsKey, userId, envelope);
    if (envelope.version !== 2) groups.legacySettings(userId);
    else groups.useSettings(userId, settings, envelope.settingsVersion);
    return settings;
}

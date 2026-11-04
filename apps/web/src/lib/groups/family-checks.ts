import type { CryptoResults } from '@hushos/crypto';
import type { FamilyChecked } from '@hushos/crypto/group-trust';
import type { FamilyCheck, GroupSettings } from './context';

/*
 * Which families this person vouched for (docs/optional-verification.md 3.4,
 * 7.2), from the synced settings: `familyChecks`, one record per family, and
 * `familyChecksSince`, the time this account's first client able to take a
 * family on first use began writing them.
 *
 * Every family accepted before first use existed was anchored by creation or
 * a compared join code, so a group pin with no check record reads as checked
 * until the marker is set, and as first use after it. **The invariant:** no
 * group pin is ever saved into settings that lack the marker without the
 * marker and a `before` record for every pin already there in the same save
 * (withFamilyChecks), so a pin labelled `before` was never a first-use one,
 * whichever device or client saves first and however compare-and-set saves
 * race: each attempt derives its document again from the one it read.
 */

/* Whether this person vouched for `groupId`: a check record, or a pin from before the marker. */
export function familyChecked(settings: GroupSettings, groupId: string) {
    const record = settings.familyChecks?.[groupId];
    if (record !== undefined && record !== null) return true;
    if (!settings.groups?.[groupId]) return false;
    return !settings.familyChecksSince;
}

/*
 * The settings a family pin is saved into (pins.ts settlePin, and a family
 * check's save): with the marker, if they lack it, and a `before` record at
 * each pin's own roster for every family pin they already hold; then a record
 * of what vouched for this acceptance (`checked`: created, or a join code
 * compared), so a family this person vouched for never reads as first use
 * once the marker is there. A first-use acceptance (`checked` null) adds no
 * record. Pure: the caller saves it with compare-and-set.
 */
export function withFamilyChecks(
    settings: GroupSettings,
    now: string,
    acceptance?: { groupId: string; checked: FamilyChecked | null },
): GroupSettings {
    const checks: Record<string, FamilyCheck> = { ...settings.familyChecks };
    let since = settings.familyChecksSince;
    if (!since) {
        for (const [groupId, pin] of Object.entries(settings.groups ?? {})) {
            if (checks[groupId] || !pin || typeof pin !== 'object') continue;
            const rosterVersion = (pin as { rosterVersion?: unknown }).rosterVersion;
            if (!Number.isSafeInteger(rosterVersion)) continue;
            checks[groupId] = {
                rosterVersion: rosterVersion as number,
                how: 'before',
                checkedAt: now,
            };
        }
        since = now;
    }
    const checked = acceptance?.checked;
    if (acceptance && checked && checked.how !== 'compared' && !checks[acceptance.groupId])
        checks[acceptance.groupId] = {
            rosterVersion: checked.rosterVersion,
            how: checked.how,
            checkedAt: now,
        };
    return { ...settings, familyChecks: checks, familyChecksSince: since };
}

type VerifiedNodes = CryptoResults['groupVerify']['nodes'];

/*
 * A family folder's verdicts as this person may read them (2.6): what the
 * member list vouches for is `verified` (via the family) only when this person
 * vouched for the family; in a family taken on first use, nobody checked the
 * member list, so the same work reads `seen` (via the family), as a first-seen
 * contact's does. A verdict that comes from this person's own verified pin
 * (no `via`) stays verified either way; nothing else changes.
 */
export function asFirstUse(nodes: VerifiedNodes, groupId: string): VerifiedNodes {
    const seen = <T extends { via: string | null }>(verdict: T, key: keyof T): T =>
        verdict[key] === 'verified' && verdict.via === groupId
            ? { ...verdict, [key]: 'seen' }
            : verdict;
    return nodes.map((node) => ({
        ...seen(node, 'metadata'),
        ...(node.metadataRekey ? { metadataRekey: seen(node.metadataRekey, 'rekeyer') } : {}),
        versions: node.versions.map((version) => ({
            ...seen(version, 'integrity'),
            ...(version.rekey ? { rekey: seen(version.rekey, 'rekeyer') } : {}),
        })),
    }));
}

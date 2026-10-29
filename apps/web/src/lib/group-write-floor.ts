import { isProductVersion, compareVersions } from '@hushos/drive/protocol';
import { GROUP_WRITE_PROTOCOL } from '@hushos/groups/protocol';

/*
 * The client floor on family-changing routes (docs/optional-verification.md
 * 7.3). A browser tab opened before a change to the family-write rules keeps
 * running the old code until the person reloads (release-notice.tsx offers a
 * reload, never forces one), and that code would still ask for words and
 * knows nothing of the manager rule (3.6). So the routes that let people in,
 * change roles or seal family keys refuse it with 426 `unsupported` (which
 * the web words as "Update HushOS to do this. Reload the page to get the
 * latest version."), while every other route, Drive and the join's own routes
 * included, keeps serving it as before.
 *
 * A web tab says which rules it follows in GROUP_WRITE_HEADER, a number
 * (@hushos/groups/protocol) bumped only when those rules change: hushos.com
 * deploys every merge without bumping the release version, so the version
 * can't tell an old tab from a new one, and a floor at the release would
 * refuse every tab on every release. A tab that sends no number is from
 * before it existed. Only `web/` is held to it: no shipped phone can change
 * roles or let anyone in, and a phone floor would lock out iOS 0.10.0 joins.
 *
 * On top of that, per client name, the version floor is the higher of
 * DRIVE_CLIENT_MINIMUMS and GROUP_WRITE_CLIENT_MINIMUMS (same format), so
 * the variable only ever raises what Drive already asks for.
 */

/* The higher of two minimums: a product version is past every pre-1.0 floor (meetsMinimum). */
export function higherMinimum(a: string | undefined, b: string | undefined) {
    if (a === undefined) return b;
    if (b === undefined) return a;
    const productA = isProductVersion(a);
    const productB = isProductVersion(b);
    if (productA !== productB) return productA ? a : b;
    return compareVersions(a, b) >= 0 ? a : b;
}

/* The family-changing routes' version minimums, per client name. */
export function groupWriteMinimums(
    drive: ReadonlyMap<string, string>,
    groupWrite: ReadonlyMap<string, string>,
) {
    const out = new Map<string, string>();
    for (const name of new Set([...drive.keys(), ...groupWrite.keys()]))
        out.set(name, higherMinimum(drive.get(name), groupWrite.get(name))!);
    return out;
}

/*
 * Whether a client may change a family under the rules this server follows:
 * a web client must send GROUP_WRITE_HEADER at `minimum` or above (none, or
 * anything that isn't a whole number, counts as old); other clients aren't
 * asked. The client header itself is checked first (requireClient).
 */
export function followsGroupWrites(
    client: string,
    header: string | null | undefined,
    minimum: number = GROUP_WRITE_PROTOCOL,
) {
    if (client !== 'web') return true;
    if (header === null || header === undefined || !/^[1-9]\d{0,8}$/.test(header.trim()))
        return false;
    return Number(header.trim()) >= minimum;
}

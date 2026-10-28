import { isProductVersion, compareVersions } from '@hushos/drive/protocol';
import { HUSHOS_VERSION } from '@/lib/version';

/*
 * The client floor on family-changing routes (docs/optional-verification.md
 * 7.3). A browser tab opened before this release keeps running the old code
 * until the person reloads (release-notice.tsx offers a reload, never forces
 * one), and that code would still ask for words and knows nothing of the
 * manager rule (3.6). So the routes that let people in, change roles or seal
 * family keys refuse it with 426 `unsupported` (which the web words as
 * "Update HushOS to do this. Reload the page to get the latest version."),
 * while every other route, Drive and the join's own routes included, keeps
 * serving it as before.
 *
 * Per client name, the floor is the higher of DRIVE_CLIENT_MINIMUMS,
 * GROUP_WRITE_CLIENT_MINIMUMS (same format) and the built-in web floor, so a
 * self-hosted server gets it on upgrade with nothing to set, and the variable
 * only ever raises it. Only `web/` is built in: no shipped phone can change
 * roles or let anyone in, and a phone floor would lock out iOS 0.10.0 joins.
 *
 * The built-in web floor is this server's own release (package.json, as the
 * web bundle sends it): a release refuses family changes from tabs of any
 * earlier release. Between releases a build still carries the last release's
 * version, so a floor naming the next release would refuse the build's own
 * tabs until the release lands.
 */
export const GROUP_WRITE_WEB_FLOOR = HUSHOS_VERSION;

/* The higher of two minimums: a product version is past every pre-1.0 floor (meetsMinimum). */
export function higherMinimum(a: string | undefined, b: string | undefined) {
    if (a === undefined) return b;
    if (b === undefined) return a;
    const productA = isProductVersion(a);
    const productB = isProductVersion(b);
    if (productA !== productB) return productA ? a : b;
    return compareVersions(a, b) >= 0 ? a : b;
}

/* The family-changing routes' minimums, per client name. */
export function groupWriteMinimums(
    drive: ReadonlyMap<string, string>,
    groupWrite: ReadonlyMap<string, string>,
    builtIn: Readonly<Record<string, string>> = { web: GROUP_WRITE_WEB_FLOOR },
) {
    const out = new Map<string, string>();
    for (const name of new Set([...drive.keys(), ...groupWrite.keys(), ...Object.keys(builtIn)]))
        out.set(
            name,
            higherMinimum(higherMinimum(drive.get(name), groupWrite.get(name)), builtIn[name])!,
        );
    return out;
}

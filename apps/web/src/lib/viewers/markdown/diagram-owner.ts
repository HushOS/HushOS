/*
 * Whether the drive's post-unlock preload owns the diagram bundle's fetch (lib/viewers/preload.ts). A module of its
 * own with no imports, so the preload marks it at once, before any view could start the bundle itself.
 */
let owned = false;

export const preloadOwnsDiagrams = () => owned;

export function claimDiagramsForPreload() {
    owned = true;
}

/*
 * How a family's pool counts what it holds (docs/families-shared-pool.md 3.6 step 5, 3.9), with
 * no imports so that the browser can use it too: Plans says which tiers can't hold someone's
 * files with the same arithmetic the server refuses them with. `pool.ts` explains why it counts
 * in parts.
 */

export const GIB = 1n << 30n;

/* Bytes rounded up to a whole GiB (an amount to free, a total shown). */
export function wholeGibUp(bytes: bigint) {
    return bytes <= 0n ? 0n : ((bytes + GIB - 1n) / GIB) * GIB;
}

/*
 * What a pool counts as stored: each part (the family folders together, each pooled member's
 * own files) rounded up to a whole GiB on its own, then summed.
 */
export function countedPool(parts: readonly bigint[]) {
    return parts.reduce((sum, part) => sum + wholeGibUp(part), 0n);
}

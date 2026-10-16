import { CryptoError } from './errors';

/*
 * Padmé: a length rounded up so that only its top bits survive, about log2 of
 * log2 of them. What the server can learn of a suite 3 object's size is this
 * bucket. The padding is under 2^-S of the length, S = floor(log2(log2 L)) + 1:
 * under 6.25% up to 64 KiB, 3.125% up to 4 GiB, 1.5625% beyond. Everything up
 * to 256 bytes is one bucket. (`padded` in drive.ts is the other kind: metadata
 * padded to fixed steps.)
 */
export function paddedLength(length: number) {
    if (!Number.isSafeInteger(length) || length < 0) throw new CryptoError('Invalid file size.');
    if (length <= 256) return 256;
    const value = BigInt(length);
    const e = BigInt(value.toString(2).length - 1);
    const s = BigInt(e.toString(2).length);
    const mask = (1n << (e - s)) - 1n;
    const out = (value + mask) & ~mask;
    if (out > BigInt(Number.MAX_SAFE_INTEGER)) throw new CryptoError('Invalid file size.');
    return Number(out);
}

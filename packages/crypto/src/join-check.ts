import { CryptoError } from './errors';

/*
 * Whether the two words a newcomer typed are the join code's at the two
 * positions the page hid for this showing (docs/groups-design.md 3.2;
 * apps/web/src/lib/groups/join.ts issues the positions and calls this). The
 * twin is the Rust core's join_check (crates/hushos-core/src/join.rs), which
 * the phones call: both read the same cases (fixtures/join-check-cases.json)
 * and the fuzz kind `join_check` compares them on any input.
 *
 * - `code`: twelve words of 3 to 8 lowercase letters, as joinCode writes it;
 *   anything else is refused ('Invalid join code.').
 * - `hidden`: two positions, 0 to 11, strictly ascending; anything else is
 *   refused ('Invalid hidden positions.'). The caller draws them from the
 *   crypto RNG, keeps them for that showing only and never sends them.
 * - `typed`: the two words in the order of `hidden`, each trimmed and
 *   lowercased before it is compared. Anything but two non-blank words is
 *   'incomplete'; one answer for the pair otherwise, never which word is wrong.
 */
export type JoinCheck = 'match' | 'no-match' | 'incomplete';

export function joinCheck(
    code: readonly string[],
    hidden: readonly number[],
    typed: readonly string[],
): JoinCheck {
    if (
        !Array.isArray(code) ||
        code.length !== 12 ||
        !code.every((word) => typeof word === 'string' && /^[a-z]{3,8}$/.test(word))
    )
        throw new CryptoError('Invalid join code.');
    if (
        !Array.isArray(hidden) ||
        hidden.length !== 2 ||
        !hidden.every((at) => Number.isInteger(at) && at >= 0 && at <= 11) ||
        hidden[0]! >= hidden[1]!
    )
        throw new CryptoError('Invalid hidden positions.');
    if (
        !Array.isArray(typed) ||
        typed.length !== 2 ||
        typed.some((word) => typeof word !== 'string' || !word.trim())
    )
        return 'incomplete';
    return hidden.every((at, index) => typed[index]!.trim().toLowerCase() === code[at])
        ? 'match'
        : 'no-match';
}

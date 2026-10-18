import { CryptoError } from './errors';
import type { JoinMark } from './group-trust';
import { joinCheck } from './join-check';

/*
 * The join's escalation (docs/groups-design.md 3.2), held by the crypto
 * worker per family (session-groups.ts: groupJoinPreview, groupJoinCheck)
 * and twin of the Rust core's join book
 * (crates/hushos-core/src/join.rs), which the phones run:
 *
 * - a code hides two positions drawn from the crypto RNG when it is first
 *   shown, and keeps them until a match (a family keeps at most 64 codes,
 *   dropping the earliest no wrong pair holds);
 * - a wrong pair holds that code's positions; it is said calmly
 *   ('wrong-words', most likely misheard) the first time for the family, and
 *   is the alarm ('mismatch') after that, for that code or any other, since
 *   a server grinding a made-up family passes a showing only when both hidden
 *   words fall among the ones it matched, and a person who retries after
 *   every calm line would hand it fresh positions each time;
 * - a match clears the family's wrong pair and the code's hold.
 *
 * What a wrong pair leaves (the held positions, the family's wrong pair) goes
 * in and out of groupJoinPreview and groupJoinCheck sealed (`holds`), so a
 * reload or a lock keeps it (`holdsValue`, `restoreHolds`).
 * The shared fixtures (`joinSessions` in the join fixture files) run both
 * twins through the same showings and checks with the same draws.
 */

export const NOT_SHOWN = 'Compare the join code again.';
/* A kept escalation that does not open for this account and family: the data layer deletes it. */
export const HOLDS_UNREADABLE = 'This saved join check could not be opened on this account.';
const TOO_MANY = 'Too many join codes were shown for this family. Compare it again later.';
/* The codes one family's escalation keeps, held ones first to stay. */
export const MAX_SHOWN_CODES = 64;

/* The positions hidden for one code, whether a wrong pair holds them, and when it was first shown. */
export type Issued = { positions: [number, number]; held: boolean; seq: number };
/* One family's escalation: its wrong pair, and the positions issued per code shown (bounded). */
export type JoinFamily = { tried: boolean; issued: Map<string, Issued>; seq: number };

export const newJoinFamily = (): JoinFamily => ({ tried: false, issued: new Map(), seq: 0 });

/* Room for one more code: the earliest shown code no wrong pair holds goes; refused when all are held. */
export function makeRoom(family: JoinFamily) {
    if (family.issued.size < MAX_SHOWN_CODES) return;
    let oldest: [string, Issued] | null = null;
    for (const entry of family.issued)
        if (!entry[1].held && (!oldest || entry[1].seq < oldest[1].seq)) oldest = entry;
    if (!oldest) throw new CryptoError(TOO_MANY);
    family.issued.delete(oldest[0]);
}

function insert(family: JoinFamily, key: string, positions: [number, number], held: boolean) {
    family.seq += 1;
    family.issued.set(key, { positions, held, seq: family.seq });
}
export const codeKey = (mark: JoinMark) => `${mark.rosterVersion} ${mark.code.join(' ')}`;

/* One of 0 to 11 from 32-bit draws, without modulo bias; null when the draws run out. */
function position(next: () => number | undefined) {
    const limit = 2 ** 32 - (2 ** 32 % 12);
    for (;;) {
        const value = next();
        if (value === undefined) return null;
        if (value < limit) return value % 12;
    }
}

/* Two distinct positions for one showing, ascending; null when the draws run out. */
export function hiddenPositions(next: () => number | undefined): [number, number] | null {
    const first = position(next);
    if (first === null) return null;
    let second = position(next);
    while (second === first) second = position(next);
    if (second === null) return null;
    return first < second ? [first, second] : [second, first];
}

/* The positions `draws` give in order, or null when they run out first (the core's join_draw_positions). */
export function drawPositions(draws: readonly number[]) {
    let at = 0;
    return hiddenPositions(() => draws[at++]);
}

/* A 32-bit draw from the crypto RNG. */
export function randomUint32() {
    return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

/* One showing of `mark`: its positions, drawn only when the code was never shown. */
export function showCode(family: JoinFamily, mark: JoinMark, next: () => number): [number, number] {
    const key = codeKey(mark);
    const issued = family.issued.get(key);
    if (issued) return [...issued.positions];
    makeRoom(family);
    const positions = hiddenPositions(next)!;
    insert(family, key, positions, false);
    return [...positions];
}

/* Whether the family still holds `hidden` as `mark`'s positions: a showing of this session's, not a replaced one. */
export function stillShown(
    family: JoinFamily | undefined,
    mark: JoinMark,
    hidden: readonly number[],
) {
    const issued = family?.issued.get(codeKey(mark));
    return (
        issued !== undefined &&
        Array.isArray(hidden) &&
        hidden.length === 2 &&
        issued.positions[0] === hidden[0] &&
        issued.positions[1] === hidden[1]
    );
}

/* Two words, neither blank. */
export const typedComplete = (typed: readonly string[]) =>
    Array.isArray(typed) &&
    typed.length === 2 &&
    typed.every((word) => typeof word === 'string' && word.trim() !== '');

/*
 * The typed words against `mark` at the positions issued for it: 'match'
 * (the escalation cleared), or a wrong pair (held, and the family's wrong pair
 * set). A code never shown is refused.
 */
export function checkCode(
    family: JoinFamily,
    mark: JoinMark,
    typed: readonly string[],
): 'match' | 'wrong-words' | 'mismatch' {
    const issued = family.issued.get(codeKey(mark));
    if (!issued) throw new CryptoError(NOT_SHOWN);
    if (joinCheck(mark.code, issued.positions, typed) === 'match') {
        issued.held = false;
        family.tried = false;
        return 'match';
    }
    const again = issued.held || family.tried;
    issued.held = true;
    family.tried = true;
    return again ? 'mismatch' : 'wrong-words';
}

/* What the person is told after a wrong pair: the calm line, or the alarm's. The core's join_check_message says the same. */
export function joinCheckMessage(again: boolean, them: string) {
    return again
        ? `The join code doesn’t match what ${them} sees. HushOS may be showing you a different member list. Don’t use this family until you’ve sorted it out together.`
        : `One of the words doesn’t match. Ask ${them} to read them again. If they still don’t match, choose They don’t match.`;
}

export type HoldsValue = {
    v: 1;
    tried: boolean;
    held: { rosterVersion: number; code: string[]; positions: [number, number] }[];
};

/* The family's escalation as kept, sorted as the core sorts it, or null when nothing is held. */
export function holdsValue(family: JoinFamily | undefined): HoldsValue | null {
    if (!family) return null;
    const held = [...family.issued.entries()]
        .filter(([, issued]) => issued.held)
        .map(([key, issued]) => {
            const [version, ...code] = key.split(' ');
            return { rosterVersion: Number(version), code, positions: issued.positions };
        })
        .sort((a, b) =>
            a.rosterVersion !== b.rosterVersion
                ? a.rosterVersion - b.rosterVersion
                : compareLists(a.code, b.code),
        );
    if (!family.tried && held.length === 0) return null;
    return { v: 1, tried: family.tried, held };
}

/* Rust's ordering of string lists: element by element, by UTF-8 bytes (ASCII words here), then by length. */
function compareLists(a: string[], b: string[]) {
    for (let at = 0; at < Math.min(a.length, b.length); at++)
        if (a[at] !== b[at]) return a[at]! < b[at]! ? -1 : 1;
    return a.length - b.length;
}

const codeShape = (code: unknown): code is string[] =>
    Array.isArray(code) &&
    code.length === 12 &&
    code.every((word) => typeof word === 'string' && /^[a-z]{3,8}$/.test(word));

/*
 * Folds a kept escalation in: only ever more held. A code held here keeps its
 * positions; a code shown here but not held takes the kept positions, held
 * (showings of the old ones are then refused). Entries that do not read as a
 * roster version (1 to 2^53 - 1), a code and two positions are skipped, and
 * so is one with no room left.
 */
export function restoreHolds(family: JoinFamily, value: unknown) {
    if (typeof value !== 'object' || value === null) return;
    const kept = value as Record<string, unknown>;
    if (kept.v !== 1) return;
    if (kept.tried === true) family.tried = true;
    if (!Array.isArray(kept.held)) return;
    for (const entry of kept.held as unknown[]) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { rosterVersion, code, positions } = entry as Record<string, unknown>;
        if (
            !Number.isSafeInteger(rosterVersion) ||
            (rosterVersion as number) < 1 ||
            !codeShape(code) ||
            !Array.isArray(positions) ||
            positions.length !== 2 ||
            !positions.every((at) => Number.isInteger(at) && at >= 0 && at <= 0xffff_ffff) ||
            positions[0] >= positions[1] ||
            positions[1] > 11
        )
            continue;
        const key = codeKey({ rosterVersion: rosterVersion as number, code });
        const issued = family.issued.get(key);
        if (issued?.held) continue;
        if (issued) {
            issued.positions = [positions[0], positions[1]];
            issued.held = true;
            continue;
        }
        try {
            makeRoom(family);
        } catch {
            continue;
        }
        insert(family, key, [positions[0], positions[1]], true);
    }
}

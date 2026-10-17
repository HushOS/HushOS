import { FuzzedDataProvider } from '@jazzer.js/core';
import { decode, encode } from '../src/keys';
import { groups } from './fixtures';
import { verdict, type Target } from './verdicts';

/*
 * The Jazzer.js entry points, one per target (`jazzer <bundle> -f <target>`).
 * run.ts bundles this file with esbuild and runs it on Node: under Bun,
 * Jazzer.js starts but its instrumentation never loads, so it fuzzes blind.
 * The byte and JSON targets take the input as it is; `accept` and
 * `roster_build` build a structured input from it first, as the Rust
 * targets do with `arbitrary`.
 */

const plain = (target: Target) => async (data: Buffer) => {
    await verdict(target, new Uint8Array(data));
};

export const canonical = plain('canonical');
export const roster = plain('roster');
export const group_succession = plain('group_succession');
export const statements = plain('statements');
export const identity = plain('identity');
export const succession = plain('succession');
export const share_open = plain('share_open');
export const key_seal_open = plain('key_seal_open');
export const area_grant_open = plain('area_grant_open');
export const key_seal_context = plain('key_seal_context');
export const pins = plain('pins');
export const record_integrity = plain('record_integrity');
export const origin_open = plain('origin_open');
export const area_ledger = plain('area_ledger');

const USERS = [
    '00000001-abcd-4abc-8abc-abcdefabcdef',
    '00000002-abcd-4abc-8abc-abcdefabcdef',
    '00000003-abcd-4abc-8abc-abcdefabcdef',
    '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
    '80558a81-8dfc-8914-8447-0417b55e2ec5',
    'a0558a81-8dfc-4914-8447-0417b55e2ec5',
    'A0558A81-8DFC-4914-8447-0417B55E2EC5',
];
const KEYS = [
    'Jp8gVe3K0szz_dTbudu0BbceayT1uO8PysP6bjviOlA',
    'Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK8',
    'Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK9',
    'Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK8=',
    '',
];

/* A field drawn from well-formed values most of the time, anything otherwise (structured.rs's `plausible`). */
function plausible(p: FuzzedDataProvider, good: string[]) {
    return p.consumeIntegralInRange(0, 7) < 7 ? p.pickValue(good) : p.consumeString(16);
}

function version(p: FuzzedDataProvider) {
    switch (p.consumeIntegralInRange(0, 5)) {
        case 0:
            return 0;
        case 1:
            return 2 ** 53 - 1;
        case 2:
            return 2 ** 53;
        default:
            return p.consumeIntegralInRange(1, 6);
    }
}

/* A roster drawn mostly from well-formed fields, so the encoder's later checks run. */
export function rosterDocument(data: Buffer) {
    const p = new FuzzedDataProvider(data);
    const kind = plausible(p, ['family', 'org', 'Family']);
    const members = Array.from({ length: p.consumeIntegralInRange(0, 4) }, () => ({
        userId: plausible(p, USERS),
        keyVersion: version(p),
        encryptionPublicKey: plausible(p, KEYS),
        signingPublicKey: plausible(p, KEYS),
        mlDsaPublicKeyDigest: plausible(p, KEYS),
        kemPublicKeyDigest: plausible(p, KEYS),
        status: plausible(p, ['active', 'left', 'gone']),
        roles: Array.from({ length: p.consumeIntegralInRange(0, 3) }, () =>
            plausible(p, ['billing', 'data_admin', 'guardian', 'members', 'recovery', 'owner']),
        ),
        sinceVersion: version(p),
    }));
    // Format 1 rows, format 2 key rows with a root commitment, and tombstones (design 2.10).
    const areas = Array.from({ length: p.consumeIntegralInRange(0, 3) }, () => {
        const row: Record<string, unknown> = {
            workspaceId: plausible(p, USERS),
            workspaceKeyVersion: version(p),
            commitment: p.consumeIntegralInRange(0, 3) === 0 ? '' : plausible(p, KEYS),
        };
        const form = p.consumeIntegralInRange(0, 2);
        if (form === 1) row.rootCommitment = plausible(p, KEYS);
        if (form === 2) row.retired = p.consumeIntegralInRange(0, 3) !== 0;
        return row;
    });
    const format = p.consumeIntegralInRange(0, 3);
    const rosterVersion = version(p);
    const roster = {
        groupId: plausible(p, USERS),
        kind,
        rosterVersion,
        previousRosterDigest: p.consumeBoolean() ? '' : plausible(p, KEYS),
        groupKeyVersion: version(p),
        signerUserId: plausible(p, USERS),
        members,
        areas,
        format,
    };
    return new TextEncoder().encode(JSON.stringify(roster));
}

export async function roster_build(data: Buffer) {
    await verdict('roster_build', rosterDocument(data));
}

type Input = Record<string, unknown> & {
    rosters: Record<string, unknown>[];
    successions: Record<string, unknown>[];
    pins: Record<string, unknown>[];
    mlDsaKeys: Record<string, string>;
    cache: Record<string, unknown> | null;
};

function caseInput(p: FuzzedDataProvider): Input {
    const cases = groups().cases as { input: Input }[];
    return structuredClone(cases[p.consumeIntegralInRange(0, cases.length - 1)]!.input);
}

function index(p: FuzzedDataProvider, length: number) {
    return length > 0 ? p.consumeIntegralInRange(0, length - 1) : -1;
}

function flip(value: string, p: FuzzedDataProvider) {
    const bytes = decode(value);
    if (bytes.length === 0) return value;
    bytes[p.consumeIntegralInRange(0, bytes.length - 1)]! ^= p.consumeIntegralInRange(1, 255);
    return encode(bytes);
}

/*
 * A fixture history changed by up to sixteen operations, as structured.rs's
 * `History` changes one: signed parts dropped, repeated, reordered, borrowed
 * from other cases or flipped; pins, cache, keys and join marks swapped.
 */
export function acceptDocument(data: Buffer) {
    const p = new FuzzedDataProvider(data);
    const input = caseInput(p);
    for (let step = 0; step < 16 && p.remainingBytes > 0; step++) {
        const rosters = input.rosters;
        const successions = input.successions;
        const cache = input.cache;
        switch (p.consumeIntegralInRange(0, 17)) {
            case 0: {
                const i = index(p, rosters.length);
                if (i >= 0) rosters.splice(i, 1);
                break;
            }
            case 1: {
                const i = index(p, rosters.length);
                if (i >= 0) rosters.splice(i, 0, structuredClone(rosters[i]!));
                break;
            }
            case 2: {
                const [a, b] = [index(p, rosters.length), index(p, rosters.length)];
                if (a >= 0) [rosters[a], rosters[b]] = [rosters[b]!, rosters[a]!];
                break;
            }
            case 3: {
                const theirs = caseInput(p).rosters;
                const i = index(p, theirs.length);
                if (i >= 0) rosters.push(theirs[i]!);
                break;
            }
            case 4: {
                const i = index(p, successions.length);
                if (i >= 0) successions.splice(i, 1);
                break;
            }
            case 5: {
                const theirs = caseInput(p).successions;
                const i = index(p, theirs.length);
                if (i >= 0) successions.push(theirs[i]!);
                break;
            }
            case 6:
                input.pins = caseInput(p).pins;
                break;
            case 7: {
                const i = index(p, input.pins.length);
                const key = p.consumeBoolean() ? 'rosterVersion' : 'keyVersion';
                if (i >= 0)
                    input.pins[i]![key] = Math.max(
                        0,
                        (input.pins[i]![key] as number) + p.consumeIntegralInRange(-2, 2),
                    );
                break;
            }
            case 8:
                input.cache = caseInput(p).cache;
                break;
            case 9:
                input.cache = null;
                break;
            case 10:
                if (cache && Array.isArray(cache.rosterDigests))
                    cache.rosterDigests = cache.rosterDigests.slice(
                        0,
                        p.consumeIntegralInRange(0, cache.rosterDigests.length),
                    );
                break;
            case 11:
                if (cache && typeof cache.droppedHolder === 'boolean')
                    cache.droppedHolder = !cache.droppedHolder;
                break;
            case 12:
                if (cache && Array.isArray(cache.groupKeys))
                    cache.groupKeys = cache.groupKeys.slice(
                        0,
                        p.consumeIntegralInRange(0, cache.groupKeys.length),
                    );
                break;
            case 13:
                input.firstKeysChecked = !input.firstKeysChecked;
                break;
            case 14:
                input.firstKeys = caseInput(p).firstKeys;
                break;
            case 15:
                input.me = caseInput(p).me;
                break;
            case 16: {
                const keys = Object.keys(input.mlDsaKeys);
                const i = index(p, keys.length);
                if (i >= 0) delete input.mlDsaKeys[keys[i]!];
                break;
            }
            default: {
                const list = p.consumeBoolean() ? rosters : successions;
                const i = index(p, list.length);
                if (i < 0) break;
                const item = list[i] as {
                    statement: string;
                    signature: { ed25519: string; mlDsa: string };
                    signerSignature: string;
                };
                switch (p.consumeIntegralInRange(0, 3)) {
                    case 0:
                        item.statement = flip(item.statement, p);
                        break;
                    case 1:
                        item.signature.ed25519 = flip(item.signature.ed25519, p);
                        break;
                    case 2:
                        item.signature.mlDsa = flip(item.signature.mlDsa, p);
                        break;
                    default:
                        item.signerSignature = flip(item.signerSignature, p);
                }
            }
        }
    }
    return new TextEncoder().encode(JSON.stringify(input));
}

export async function accept(data: Buffer) {
    await verdict('accept', acceptDocument(data));
}

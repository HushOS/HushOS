import fc from 'fast-check';
import { acceptDocument, rosterDocument } from './jazzer';
import { documents } from './seeds';
import type { Target } from './verdicts';

/*
 * fast-check inputs for the differential: each target's seed documents with
 * a few edits, so most inputs stay near the valid ones (where the twins'
 * checks have the most to disagree about) and some are far off. Strings are
 * well formed (no lone surrogates), since serde_json cannot read one and
 * that is the harness's limit, not the core's.
 */

/* Values an edit puts in place of a field: the shapes the protocol uses, the edges of its rules, and noise. */
const value: fc.Arbitrary<unknown> = fc.oneof(
    fc.constantFrom(
        '',
        'A',
        'AA',
        'AAA=',
        'Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK8',
        'Il2SxfIo1S4PS06zLGBCauJ8YSWSafkxQzIRzFlKTK9',
        '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a',
        '0A0A0A0A-0A0A-4A0A-8A0A-0A0A0A0A0A0A',
        '00000001-abcd-4abc-8abc-abcdefabcdef',
        // Letters whose lowercase differs between Unicode versions or by context.
        'İ',
        'ẞ',
        'ΑΣ',
        'Σ',
        'ǅ',
        'K',
        'Ⅻ',
        'Ꭰ',
        '\u{10400}',
        '\u{1E900}',
        '2026-10-15T00:00:00.000Z',
        '2026-02-31T23:59:59.999Z',
        'family',
        'org',
        'members',
        'old',
        'new',
    ),
    fc.string({ unit: 'binary', maxLength: 12 }),
    fc.string({ unit: 'grapheme-ascii', maxLength: 48 }),
    fc.constantFrom(
        0,
        1,
        2,
        3,
        2 ** 32 - 1,
        2 ** 32,
        2 ** 53 - 1,
        2 ** 53,
        2 ** 53 + 2,
        2 ** 60,
        2 ** 63,
    ),
    fc.nat(8),
    fc.constant(null),
    fc.boolean(),
);

type Path = (string | number)[];

/* Every leaf (and every list and object) of a document, by its path. */
function paths(node: unknown, at: Path = [], out: Path[] = []): Path[] {
    if (at.length) out.push(at);
    if (Array.isArray(node)) node.forEach((item, i) => paths(item, [...at, i], out));
    else if (typeof node === 'object' && node !== null)
        for (const [key, item] of Object.entries(node)) paths(item, [...at, key], out);
    return out;
}

function get(node: unknown, path: Path) {
    return path.reduce<unknown>((at, key) => (at as Record<string | number, unknown>)[key], node);
}

function set(node: unknown, path: Path, next: unknown) {
    const parent = get(node, path.slice(0, -1)) as Record<string | number, unknown>;
    const key = path.at(-1)!;
    if (next === undefined) {
        if (Array.isArray(parent)) parent.splice(key as number, 1);
        else delete parent[key];
    } else parent[key] = next;
}

/* One edit at a path: a new value, the value changed slightly, or the field gone. */
type Edit = { at: number; kind: number; value: unknown; position: number };
const edit = fc.record({
    at: fc.nat(),
    kind: fc.nat(15),
    value,
    position: fc.nat(),
});

/*
 * Most edits keep the field's type (a string stays a string, a number a
 * number), so both twins read the document and judge it; one in sixteen puts
 * any value there and one in sixteen drops the field, which both skip.
 */
function applyEdit(document: unknown, { at, kind, value: replacement, position }: Edit) {
    const all = paths(document);
    if (!all.length) return;
    const path = all[at % all.length]!;
    const current = get(document, path);
    const sameType = typeof replacement === typeof current ? replacement : undefined;
    let next: unknown;
    if (kind === 0) next = replacement;
    else if (kind === 1) next = undefined;
    else if (typeof current === 'string') {
        const i = current.length ? position % current.length : 0;
        next = [
            current.toUpperCase(),
            current.toLowerCase(),
            current.slice(0, i) + (current[i] === 'A' ? 'B' : 'A') + current.slice(i + 1),
            current.slice(0, -1),
            `${current}=`,
            '',
        ][kind % 6]!;
        if (kind >= 12 && typeof sameType === 'string') next = sameType;
    } else if (typeof current === 'number') {
        next = current + [1, -1, 2 ** 53, 0][kind % 4]!;
        if (kind >= 12 && typeof sameType === 'number') next = sameType;
        // A number only JSON can spell (1.5, a negative) is the one-in-sixteen case, not every number edit.
        if (!Number.isInteger(next) || (next as number) < 0) next = current;
    } else if (Array.isArray(current) && current.length) {
        // A list loses or repeats an item.
        next = kind % 2 ? current.slice(1) : [...current, current[0]];
    } else next = current;
    set(document, path, next);
}

const utf8 = (text: string) => new TextEncoder().encode(text);

function parsed(seed: Uint8Array) {
    try {
        return JSON.parse(new TextDecoder().decode(seed)) as unknown;
    } catch {
        return undefined;
    }
}

/* A seed document with up to three edits; JSON documents stay compact JSON. */
function edited(target: Target, all: Uint8Array[]) {
    // Some seeds are junk on purpose (a case's planted statement): only JSON ones are edited as JSON.
    const seeds = all.filter((seed) => parsed(seed) !== undefined);
    return (
        fc
            .record({ seed: fc.nat(seeds.length - 1), edits: fc.array(edit, { maxLength: 3 }) })
            .map(({ seed, edits }) => {
                const document = parsed(seeds[seed]!);
                for (const e of edits) applyEdit(document, e);
                return utf8(JSON.stringify(document));
            })
            // JSON.stringify writes a lone surrogate (an edit can split a pair) as an escape serde_json refuses.
            .filter((bytes) => !/\\ud[89a-f]/i.test(new TextDecoder().decode(bytes)))
            .map((data) => ({ target, data }))
    );
}

/* Bytes near a seed: flipped, cut short, or grown. */
function flipped(target: Target, seeds: Uint8Array[]) {
    return fc
        .record({
            seed: fc.nat(seeds.length - 1),
            flips: fc.array(fc.tuple(fc.nat(), fc.integer({ min: 1, max: 255 })), { maxLength: 3 }),
            cut: fc.option(fc.nat(), { nil: undefined }),
            extra: fc.uint8Array({ maxLength: 4 }),
        })
        .map(({ seed, flips, cut, extra }) => {
            const bytes = Uint8Array.from(seeds[seed]!);
            for (const [at, mask] of flips) bytes[at % bytes.length]! ^= mask;
            const kept = cut === undefined ? bytes : bytes.subarray(0, cut % (bytes.length + 1));
            return { target, data: Uint8Array.from([...kept, ...extra]) };
        });
}

/* Statements in the grammar's neighbourhood: compact JSON of nested lists, then respelled. */
const statementPart: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
    part: fc.oneof(
        { depthSize: 'small' },
        fc.string({ unit: 'binary', maxLength: 6 }),
        fc.string({ unit: 'grapheme-ascii', maxLength: 6 }),
        fc.constantFrom(0, 1, 2 ** 53 - 1, 2 ** 53, -1, 1.5, 1e21),
        fc.array(tie('part'), { maxLength: 3 }),
    ),
})).part;

const respell = fc.constantFrom<(text: string) => string>(
    (t) => t,
    (t) => t.replace(',', ', '),
    (t) => ` ${t}`,
    (t) => `﻿${t}`,
    (t) => t.replace(/"([^"]*)"/, '"\\u0041$1"'),
    (t) => t.replace(/(\d+)/, '$1.0'),
    (t) => t.replace(/(\d+)/, '$1e0'),
    (t) => t.replace(/(\d+)/, '-0'),
    (t) => t.replace(/\]$/, ',]'),
);

const canonicalStatements = fc
    .tuple(fc.array(statementPart, { maxLength: 5 }), respell)
    .map(([parts, change]) => ({
        target: 'canonical' as Target,
        data: utf8(change(JSON.stringify(parts))),
    }));

/* The structured targets' documents from bytes, exactly as their Jazzer.js entry points build them. */
const structured = (target: 'accept' | 'roster_build') =>
    fc.uint8Array({ minLength: 1, maxLength: 96 }).map((bytes) => ({
        target,
        data: (target === 'accept' ? acceptDocument : rosterDocument)(Buffer.from(bytes)),
    }));

/*
 * Step sequences for the family write rules, drawn from the vocabulary both
 * twins read (area-ledger-testkit.ts): chains, area keys, listings under
 * named and made keys, writes, walks and their batches, in any order.
 */
const ledgerNode = fc.constantFrom('ROOT', 'A', 'B', 'C', 'D');
const ledgerParent = fc.constantFrom('WS', 'ROOT', 'A', 'B', 'C');
const ledgerEpoch = fc.integer({ min: 0, max: 4 });
const ledgerKey = fc.oneof(
    fc.constantFrom(
        'area:1',
        'area:2',
        'area:3',
        'root:1',
        'root:2',
        'root:3',
        'k:1',
        'k:2',
        'k:3',
    ),
    fc.tuple(ledgerNode, ledgerEpoch).map(([node, epoch]) => `made:${node}@${epoch}`),
);
const ledgerWrapped = fc.record({
    key: ledgerKey,
    under: ledgerKey,
    parentKeyEpoch: ledgerEpoch,
    keyEpoch: ledgerEpoch,
    label: fc.constantFrom('node', 'node', 'previous-root'),
});
const ledgerStep = fc.oneof(
    fc.record({
        op: fc.constant('commit'),
        chain: fc.constantFrom(
            'f2-v1',
            'f2-v2',
            'f2-v3',
            'f1-v1',
            'f1-v2',
            'f1-to-f2',
            'f2-retired',
        ),
    }),
    fc.constantFrom(
        { op: 'uncommit' },
        { op: 'forget' },
        { op: 'requireWritable' },
        { op: 'state' },
    ),
    fc.record({ op: fc.constant('openArea'), version: ledgerEpoch, served: ledgerEpoch }),
    fc
        .tuple(
            ledgerNode,
            ledgerParent,
            ledgerWrapped,
            fc.option(ledgerWrapped, { nil: undefined }),
        )
        .map(([node, parent, envelope, prev]) => ({
            op: 'list',
            node,
            parent,
            ...envelope,
            ...(prev ? { prev } : {}),
        })),
    fc.record({
        op: fc.constantFrom('create', 'rewrap'),
        node: ledgerNode,
        parent: ledgerParent,
        parentKeyEpoch: ledgerEpoch,
        keyEpoch: ledgerEpoch,
    }),
    fc.record({ op: fc.constant('writable'), node: ledgerNode }),
    fc.record({ op: fc.constant('keyAt'), node: ledgerNode, epoch: ledgerEpoch }),
    fc.record({
        op: fc.constant('rotate'),
        node: ledgerNode,
        parent: ledgerParent,
        parentKeyEpoch: ledgerEpoch,
        target: ledgerEpoch,
        served: ledgerWrapped.map((w) => ({ ...w, label: 'node' })),
    }),
    fc.record({
        op: fc.constantFrom('commitPending', 'dropPending'),
        nodes: fc.array(ledgerNode, { maxLength: 3 }),
    }),
);
const ledgerSteps = fc
    .array(ledgerStep, { minLength: 1, maxLength: 24 })
    .map((steps) => ({ target: 'area_ledger' as Target, data: utf8(JSON.stringify({ steps })) }));

export function inputs(target: Target): fc.Arbitrary<{ target: Target; data: Uint8Array }> {
    const seeds = documents(target);
    switch (target) {
        case 'canonical':
            return fc.oneof(
                canonicalStatements,
                flipped(target, seeds),
                fc.uint8Array().map((data) => ({ target, data })),
            );
        case 'roster':
        case 'group_succession':
            // A statement is a JSON list: edit it as JSON (fields, kinds, order), or as bytes.
            return fc.oneof(edited(target, seeds), flipped(target, seeds));
        case 'share_open':
        case 'key_seal_open':
        case 'area_grant_open':
        case 'origin_open':
            return flipped(target, seeds);
        case 'accept':
            // Histories only as the entry point builds them: an edit could break the shape the
            // case readers of both twins assume (they read fixtures, not hostile JSON).
            return structured(target);
        case 'roster_build':
            return fc.oneof(structured(target), edited(target, seeds));
        case 'area_ledger':
            return fc.oneof(ledgerSteps, edited(target, seeds));
        default:
            return edited(target, seeds);
    }
}

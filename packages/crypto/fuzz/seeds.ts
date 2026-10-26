import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GROUP } from '../src/group-testkit';
import { parseRoster } from '../src/groups';
import {
    core,
    coreJoin,
    coreLedger,
    coreRosterCalls,
    rosterCallSessions,
    settingsAreaCases,
    groups,
    joinCheckCases,
    joinSessionScenarios,
    ledgerScenarios,
    repository,
    web,
    webGroups,
    webJoin,
    webLedger,
    type Json,
} from './fixtures';
import { TARGETS, type Target } from './verdicts';

/*
 * Seed inputs for every target, from the fixtures both twins already share:
 * valid statements, envelopes, links and histories, so the fuzzers start past
 * the first checks and the verify paths that only a real signature reaches.
 * `documents` are what a target's verdict reads (and what the differential
 * replays); `fuzzerSeeds` are what each fuzzer's entry point consumes, the
 * same except for `accept` and `roster_build`, whose entry points build their
 * document from structured bytes. Run directly, this writes the seeds into
 * both corpora (gitignored): crates/hushos-core/fuzz/corpus/<target> and
 * packages/crypto/fuzz/corpus/<target>.
 */

const utf8 = (text: string) => new TextEncoder().encode(text);
const json = (value: unknown) => utf8(JSON.stringify(value));
const bytes = (base64url: string) => new Uint8Array(Buffer.from(base64url, 'base64url'));
const withoutSignature = (base64url: string) =>
    Buffer.from(bytes(base64url).subarray(0, -3373)).toString('base64url');
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest();

function unique(list: Uint8Array[]) {
    const seen = new Set<string>();
    return list.filter((item) => {
        const key = Buffer.from(item).toString('base64');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/* A roster statement in format 2 (design 2.10): root commitments and tombstones. */
const isFormat2 = (statement: Uint8Array) =>
    new TextDecoder().decode(statement).startsWith('["hushos/group/roster",2,');

function statementsOf(served: Json[]) {
    return served.map((s: Json) => bytes(s.statement));
}

export function documents(target: Target): Uint8Array[] {
    const c = core();
    const g = groups();
    const w = web();
    const wg = webGroups();
    const caseRosters = g.cases.flatMap((k: Json) => statementsOf(k.input.rosters));
    const caseSuccessions = g.cases.flatMap((k: Json) => statementsOf(k.input.successions));
    switch (target) {
        case 'canonical':
            return unique([
                ...statementsOf(g.rosters),
                ...statementsOf(g.successions),
                ...statementsOf(wg.rosters),
                ...g.statementCases.map((k: Json) => bytes(k.statement)),
                bytes(c.keys.statement),
                bytes(c.succession.statement),
                bytes(c.deviceSession.statement),
                bytes(w.keys.statement),
                bytes(w.succession.statement),
                bytes(w.deviceSession.statement),
            ]);
        case 'roster':
            // Format 2 rosters (design 2.10) first, so the cut keeps them.
            return unique([
                ...caseRosters.filter(isFormat2),
                ...statementsOf(g.rosters),
                ...statementsOf(wg.rosters),
                ...caseRosters,
            ]).slice(0, 200);
        case 'group_succession':
            return unique([
                ...statementsOf(g.successions),
                ...statementsOf(wg.successions),
                ...caseSuccessions,
            ]);
        case 'roster_build':
            return [
                ...g.rosters.map((r: Json) => json(r.roster)),
                // Format 2 rosters (design 2.10), key rows and tombstones, as parseRoster reads them.
                ...caseRosters
                    .filter(isFormat2)
                    .slice(0, 8)
                    .map((statement: Uint8Array) => json(parseRoster(statement))),
            ];
        case 'statements': {
            const link = c.succession.link;
            const consentLinks = g.chainCases.flatMap((k: Json) =>
                k.links
                    .filter((l: Json) => l.consent)
                    .map((l: Json) => ({ userId: k.userId, link: l })),
            );
            return [
                json({ kind: 'share', ctx: c.share.ctx, sealed: withoutSignature(c.share.signed) }),
                json({ kind: 'keys', userId: c.keys.userId, ...c.keys.identity }),
                json({ kind: 'succession', userId: c.succession.userId, link }),
                ...consentLinks
                    .slice(0, 2)
                    .flatMap((l: Json) =>
                        ['old', 'new'].map((role) => json({ kind: 'consent', ...l, role })),
                    ),
                json({
                    kind: 'device',
                    userId: c.deviceSession.userId,
                    deviceId: c.deviceSession.deviceId,
                    attemptToken: c.deviceSession.attemptToken,
                    publicKey: c.deviceSession.publicKey,
                    signature: c.deviceSession.signature,
                }),
                json({
                    kind: 'keySeal',
                    ctx: g.seals.keySeal.ctx,
                    sealed: withoutSignature(g.seals.keySeal.envelope),
                }),
                json({
                    kind: 'areaGrant',
                    ctx: g.seals.areaGrant.ctx,
                    sealed: withoutSignature(g.seals.areaGrant.envelope),
                }),
                // Drive record statements in all four forms, from both twins' signed records.
                ...[c, w].flatMap((f: Json) =>
                    (['metadata', 'version'] as const).flatMap((kind) => {
                        const signed = f.signatures[kind];
                        const rekeyed = f.rekeyed[kind];
                        return [
                            ...(['ordinary', 'saved', 'resealed'] as const).map((form) =>
                                json({
                                    kind,
                                    form,
                                    statement: signed.statement,
                                    envelope: signed.envelope,
                                    publicKey: f.signatures.signingPublicKey,
                                    signature:
                                        form === 'ordinary' ? signed.signature : signed[form],
                                }),
                            ),
                            json({
                                kind,
                                form: 'rekeyed',
                                statement: rekeyed.statement,
                                envelope: rekeyed.envelope,
                                keyEpoch: rekeyed.keyEpoch,
                                origin: {
                                    envelope: rekeyed.origin.envelope,
                                    signerId: rekeyed.origin.signerId,
                                    signature: rekeyed.origin.signature,
                                    keyEnvelope: rekeyed.origin.keyEnvelope,
                                },
                                publicKey: f.rekeyed.rekeyer.signingPublicKey,
                                signature: rekeyed.rekeySignature,
                            }),
                        ];
                    }),
                ),
            ];
        }
        case 'identity':
            return [
                json({ userId: c.identity.userId, envelope: c.identity.envelope }),
                // The web's, with the account keys they open under.
                json({
                    userId: w.succession.userId,
                    envelope: w.succession.identity,
                    accountKey: w.succession.accountKey,
                }),
                json({
                    userId: w.upgrade.userId,
                    envelope: w.upgrade.legacy,
                    accountKey: w.upgrade.accountKey,
                }),
                json({
                    userId: w.upgrade.userId,
                    envelope: w.upgrade.upgraded,
                    accountKey: w.upgrade.accountKey,
                }),
                json({
                    userId: w.upgrade.userId,
                    envelope: w.upgrade.upgradedNoKem,
                    accountKey: w.upgrade.accountKey,
                }),
                json({ userId: w.keys.userId, public: w.keys.identity }),
                json({ userId: c.succession.userId, envelope: c.succession.identity }),
                json({ userId: c.upgrade.userId, envelope: c.upgrade.legacy }),
                json({ userId: c.upgrade.userId, envelope: c.upgrade.upgraded }),
                json({ userId: c.keys.userId, public: c.keys.identity }),
                ...g.people.map((p: Json) => json({ userId: p.userId, public: p.served })),
            ];
        case 'succession': {
            const { chain, link, userId } = c.succession;
            const signer = {
                signingPublicKey: link.oldSigningPublicKey,
                mlDsaPublicKey: link.oldMlDsaPublicKey,
            };
            const theirs = w.succession;
            return [
                json({ userId, link, signer, ...chain }),
                json({
                    userId: theirs.userId,
                    link: theirs.link,
                    signer: {
                        signingPublicKey: theirs.link.oldSigningPublicKey,
                        mlDsaPublicKey: theirs.link.oldMlDsaPublicKey,
                    },
                    ...theirs.chain,
                }),
                ...g.chainCases.map((k: Json) =>
                    json({
                        userId: k.userId,
                        link: k.links[0],
                        pinned: k.pinned,
                        served: k.served,
                        links: k.links,
                    }),
                ),
                // Each twin's account: the links needing consent, and consent signed or refused.
                ...[coreJoin(), webJoin()].flatMap(({ consents: d }: Json) => {
                    const keys = (name: string) => {
                        const e = d.identities[name];
                        return {
                            keyVersion: e.keyVersion,
                            encryptionPublicKey: e.encryptionPublicKey,
                            signingPublicKey: e.signingPublicKey,
                            mlDsaPublicKey: e.mlDsa.publicKey,
                            kemPublicKey: e.kem.publicKey,
                        };
                    };
                    return [
                        ...d.due.map((k: Json) =>
                            json({
                                kind: 'consent_due',
                                links: k.links.map((name: string) => d.links[name]),
                                identities: k.identities.map((name: string) => d.identities[name]),
                            }),
                        ),
                        ...d.signs.map((k: Json) =>
                            json({
                                kind: 'consent_sign',
                                old: d.identities[k.old],
                                next: d.identities[k.next],
                                link: d.links[k.link],
                                me: k.me.map(keys),
                            }),
                        ),
                    ];
                }),
            ];
        }
        case 'share_open':
            // The web's share is sealed to someone else: as a seed it reaches the signature check.
            return [bytes(c.share.signed), bytes(w.share.signed)];
        case 'key_seal_open':
            return [bytes(g.seals.keySeal.envelope)];
        case 'area_grant_open':
            return [bytes(g.seals.areaGrant.envelope)];
        case 'key_seal_context':
            // Its own context for its holder (opens), for another person, and the grant's context.
            return [
                json({ ctx: g.seals.keySeal.ctx, reader: 0 }),
                json({ ctx: g.seals.keySeal.ctx, reader: 1 }),
                json({
                    ctx: {
                        ...g.seals.keySeal.ctx,
                        holderUserId: g.seals.areaGrant.ctx.granteeUserId,
                    },
                    reader: 1,
                }),
            ];
        case 'pins': {
            const keys = c.keys.identity;
            const mlDsaHash = sha256(bytes(keys.mlDsaPublicKey));
            const kemHash = sha256(bytes(keys.kemPublicKey));
            const digest = g.rosters[0].roster.members[0].mlDsaPublicKeyDigest as string;
            const hex = Buffer.from(bytes(digest)).toString('hex');
            const casePins = g.cases.flatMap((k: Json) => k.input.pins).slice(0, 8);
            return [
                json({
                    kind: 'pin',
                    encryptionPublicKey: keys.encryptionPublicKey,
                    signingPublicKey: keys.signingPublicKey,
                    mlDsaPublicKeyHash: mlDsaHash.toString('hex'),
                    kemPublicKeyHash: kemHash.toString('hex'),
                    fingerprint: c.fingerprints.identity,
                }),
                ...casePins.map((pin: Json) => json({ kind: 'groupPin', groupId: GROUP, pin })),
                json({ kind: 'digestHex', value: digest }),
                json({ kind: 'digestBase64url', value: hex }),
                json({ kind: 'sameKeyDigest', hex, base64url: digest }),
                json({
                    kind: 'fingerprint',
                    keys: [
                        keys.encryptionPublicKey,
                        keys.signingPublicKey,
                        mlDsaHash.toString('base64url'),
                        kemHash.toString('base64url'),
                    ],
                }),
                json({
                    kind: 'fingerprintOfKeys',
                    keys: [
                        keys.encryptionPublicKey,
                        keys.signingPublicKey,
                        keys.mlDsaPublicKey,
                        keys.kemPublicKey,
                    ],
                }),
                json({ kind: 'groupFingerprint', groupId: GROUP, key: g.groupKeys[0] }),
                // Settings documents read as the ledger reads them (Core 6): a verified pin filed
                // and probed in every case, misfiled, short of a key, a group's word, junk members,
                // the family pins at roster 2 and junk, and documents of other shapes.
                ...(() => {
                    const user = c.keys.userId as string;
                    const verifiedPin = {
                        userId: user,
                        encryptionPublicKey: keys.encryptionPublicKey,
                        signingPublicKey: keys.signingPublicKey,
                        mlDsaPublicKeyHash: mlDsaHash.toString('hex'),
                        kemPublicKeyHash: kemHash.toString('hex'),
                        fingerprint: c.fingerprints.identity,
                        keyVersion: 1,
                    };
                    const other = '00000002-abcd-4abc-8abc-abcdefabcdef';
                    const familyPin = g.cases.flatMap((k: Json) => k.input.pins)[0];
                    const pairWords = coreRosterCalls().pairCodes[0].outcome.code;
                    const probe = {
                        users: [user, user.toUpperCase(), other],
                        groups: [GROUP, other],
                    };
                    const text = (doc: Json) => JSON.stringify(doc);
                    return [
                        {
                            version: 2,
                            contacts: { [user]: verifiedPin },
                            groups: { [GROUP]: familyPin },
                        },
                        { version: 1, contacts: { [user.toUpperCase()]: verifiedPin } },
                        {
                            version: 2,
                            contacts: {
                                [other]: verifiedPin,
                                [user]: { ...verifiedPin, trustedVia: GROUP },
                            },
                        },
                        {
                            version: 2,
                            contacts: { [user]: { ...verifiedPin, mlDsaPublicKeyHash: null } },
                        },
                        {
                            version: 2,
                            contacts: { [user]: 'junk', [other]: { userId: 7 } },
                            groups: { [GROUP]: { junk: 1 } },
                        },
                        { version: 2, contacts: null, groups: [familyPin] },
                        // Family check records (docs/optional-verification.md 3.4): a pair mark, the
                        // migration's `before`, malformed ones, an array, and checks of another shape.
                        {
                            version: 2,
                            contacts: {},
                            groups: { [GROUP]: familyPin },
                            familyChecks: {
                                [GROUP]: {
                                    rosterVersion: 2,
                                    with: other,
                                    code: pairWords,
                                    checkedAt: '2026-10-18T12:00:00.000Z',
                                },
                                [other]: { how: 'before', rosterVersion: 2 },
                            },
                        },
                        {
                            version: 2,
                            contacts: {},
                            familyChecks: {
                                [GROUP]: { rosterVersion: 2, with: 'someone', code: 'words' },
                                [other]: [],
                            },
                        },
                        {
                            version: 2,
                            contacts: {},
                            familyChecks: {
                                [GROUP]: { rosterVersion: 0, with: other, code: pairWords },
                                [other]: null,
                            },
                        },
                        { version: 2, contacts: {}, familyChecks: [{ rosterVersion: 2 }] },
                        { version: 2.0, contacts: [] },
                        { version: 3, contacts: {} },
                        { version: 2 },
                    ]
                        .map((doc) => json({ kind: 'settings', text: text(doc), ...probe }))
                        .concat([
                            json({
                                kind: 'settings',
                                text: `{"version":2,"contacts":{"${user}":1,"${user}":${text(verifiedPin)}}}`,
                                ...probe,
                            }),
                            json({
                                kind: 'settings',
                                text: '\ufeff{"version":2,"contacts":{}}',
                                ...probe,
                            }),
                            json({ kind: 'settings', text: 'not json', ...probe }),
                        ]);
                })(),
                // Family folders opened from route 25 (Core 6): every area case of the core's fixture, its own self-grant.
                ...(coreRosterCalls().areaOpens as Json[]).map((open: Json) => {
                    const spec = settingsAreaCases().areas.find((k: Json) => k.name === open.name);
                    return json({
                        kind: 'area_open',
                        area: spec.area,
                        served: spec.served,
                        grant: spec.grant,
                        selfGrant: open.selfGrant,
                    });
                }),
                // A grant offered for a folder nobody may grant (cargo-fuzz's first find): refused alike.
                json({
                    kind: 'area_open',
                    area: 'A2',
                    served: 1,
                    grant: { key: [0, 1] },
                    selfGrant: null,
                }),
                json({
                    kind: 'area_open',
                    area: 'foreign',
                    served: 1,
                    grant: { key: [0, 1] },
                    selfGrant: null,
                }),
                // Pair codes: every pair of the roster-call documents, swapped ids, one member with
                // themselves, a device holding another's keys, someone never admitted, and the bare
                // code over each roster of that family.
                ...(() => {
                    const d = coreRosterCalls();
                    const ids = [
                        '00000001-abcd-4abc-8abc-abcdefabcdef',
                        '00000002-abcd-4abc-8abc-abcdefabcdef',
                    ];
                    return [
                        ...d.pairCodes.map((k: Json) =>
                            json({ kind: 'pair_code', me: k.me, other: k.other }),
                        ),
                        json({ kind: 'pair_code', me: 1, other: 2, as: 2 }),
                        json({ kind: 'pair_code', me: 2, other: 3, as: 1 }),
                        json({ kind: 'pair_code', me: 2, other: 2 }),
                        json({ kind: 'pair_code', me: 5, other: 1 }),
                        ...(d.family.rosters as Json[]).flatMap((roster: Json, at: number) =>
                            [ids, [ids[1], ids[0]], [ids[0], ids[0]]].map(([userId, otherUserId]) =>
                                json({
                                    kind: 'pair_code',
                                    rosterDigest: sha256(bytes(roster.statement)).toString(
                                        'base64url',
                                    ),
                                    groupKey: d.family.firstKeys,
                                    groupKeyVersion: at + 1,
                                    userId,
                                    otherUserId,
                                }),
                            ),
                        ),
                    ];
                })(),
                // Joins records sealed as the join fixtures' person 2 keeps them: a first use at
                // roster 2 and a join mark there, read back over histories that hold them and ones
                // that do not, both at once, a first use that is no object, other versions and families.
                ...(() => {
                    const d = coreJoin().joinPreviews;
                    const at = '2026-10-18T12:00:00.000Z';
                    const code = d.cases.find((k: Json) => k.name === 'admitted-at-roster-2')
                        .expected.code;
                    const joinMark = { rosterVersion: 2, code };
                    const firstUse = d.pinMain2;
                    const records = [
                        { v: 4, groupId: GROUP, firstUse },
                        { v: 3, groupId: GROUP, joinMark, checkedAt: at },
                        { v: 4, groupId: GROUP, joinMark, checkedAt: at },
                        { v: 4, groupId: GROUP, firstUse, joinMark, checkedAt: at },
                        { v: 4, groupId: GROUP, firstUse: [], joinMark, checkedAt: at },
                        { v: 3, groupId: GROUP, firstUse },
                        { v: 4, groupId: GROUP, firstUse: { ...firstUse, rosterVersion: 3 } },
                        { v: 5, groupId: GROUP, firstUse },
                        { v: 4, groupId: '00000002-abcd-4abc-8abc-abcdefabcdef', firstUse },
                        null,
                    ];
                    const served = [
                        { history: 'main', through: 2 },
                        { history: 'main', through: 5 },
                        { history: 'madeUp', through: 3 },
                        { history: 'other', through: 3 },
                    ];
                    return records.flatMap((record, i) =>
                        (i < 2 ? served : served.slice(1, 2)).map((where) =>
                            json({ kind: 'joins_record', record, served: where }),
                        ),
                    );
                })(),
                // Each twin's chain records as the device record cases hold them, and no record.
                ...[coreLedger(), webLedger()].flatMap((f: Json) =>
                    f.deviceRecords.cases
                        .filter((k: Json) => k.recordValue !== null)
                        .map((k: Json) =>
                            json({
                                kind: 'device_record',
                                record: k.recordValue,
                                settings: k.settingsPin !== null,
                                start: k.start,
                            }),
                        ),
                ),
                json({ kind: 'device_record', settings: true, start: 0 }),
                // The shared typed-words cases, and each twin's join previews (records as JSON).
                ...joinCheckCases().cases.map((k: Json) =>
                    json({
                        kind: 'join_check',
                        code: k.code ?? joinCheckCases().code,
                        hidden: k.hidden,
                        typed: k.typed,
                    }),
                ),
                // Draws at the rejection boundary (2^32 - 4 and up), just below it, and the fixtures' own.
                json({ kind: 'join_draws', draws: [0xffff_fffc, 0xffff_fffb, 0xffff_fffa] }),
                json({ kind: 'join_draws', draws: [0xffff_fffd, 0xffff_ffff, 5, 5, 17] }),
                json({ kind: 'join_draws', draws: [0xffff_fffe] }),
                json({ kind: 'join_draws', draws: [0, 12, 24, 1] }),
                // Every shared session scenario but the one checking a showing from elsewhere.
                ...joinSessionScenarios()
                    .scenarios.filter((k: Json) =>
                        k.steps.every((step: Json) => step.session !== 'elsewhere'),
                    )
                    .map((k: Json) =>
                        json({
                            kind: 'join_session',
                            settings: k.settings,
                            steps: k.steps.map((step: Json) =>
                                Object.fromEntries(
                                    Object.entries(step).filter(([key]) => key !== 'expect'),
                                ),
                            ),
                        }),
                    ),
                // "They match" and the join on the same served chain, right and misheard.
                ...(
                    [
                        ['main', 2],
                        ['main', 5],
                        ['other', 3],
                        ['succ', 3],
                        ['madeUp', 3],
                    ] as const
                ).flatMap(([history, through]) =>
                    ['right', 'misheard'].map((words) =>
                        json({
                            kind: 'join_preview',
                            history,
                            through,
                            settings: 'none',
                            words,
                            join: words === 'right',
                        }),
                    ),
                ),
                json({
                    kind: 'join_preview',
                    history: 'main',
                    through: 5,
                    settings: 'pin-main-2',
                    words: 'right',
                    join: true,
                }),
                ...[coreJoin(), webJoin()].flatMap(({ joinPreviews: d }: Json) =>
                    d.cases
                        .filter((k: Json) => k.served.history !== 'dead')
                        .map((k: Json) => {
                            const value = k.record
                                ? d.recordValues[k.record.slice(0, 1)]
                                : undefined;
                            return json({
                                kind: 'join_preview',
                                ...k.served,
                                settings: k.settings,
                                held: k.held,
                                ...(value === undefined ? {} : { record: value }),
                            });
                        }),
                ),
                // Outbox entries as both twins keep them: sent, held for each reason, landed, superseded, lost.
                ...(() => {
                    const d = coreRosterCalls();
                    const admit = d.calls.find((k: Json) => k.name === 'admit-member').expected
                        .route;
                    const member = d.calls.find((k: Json) => k.name === 'grant-members').expected
                        .route;
                    const entry = (over: Json) => ({
                        v: 1,
                        id: 'b7a1c1d2-0000-4000-8000-000000000001',
                        groupId: d.family.groupId,
                        route: admit,
                        body: '{"expectedRevision":7}',
                        previousRosterDigest: 'head',
                        rosterDigest: 'own',
                        stagedEnvelope: '',
                        state: 'ready',
                        attempts: 0,
                        joinCode: null,
                        admits: { userId: admit.userId, fingerprint: 'print' },
                        ...over,
                    });
                    const pin = { userId: admit.userId, fingerprint: 'print' };
                    return [
                        json({ kind: 'outbox_entry', entry: entry({}), pin }),
                        json({
                            kind: 'outbox_entry',
                            entry: entry({ body: { expectedRevision: 7 } }),
                            pin,
                        }),
                        json({
                            kind: 'outbox_entry',
                            entry: entry({}),
                            pin: { ...pin, fingerprint: 'other' },
                        }),
                        json({
                            kind: 'outbox_entry',
                            entry: entry({}),
                            pin: null,
                            id: 'b7a1c1d2-0000-4000-8000-000000000002',
                        }),
                        json({
                            kind: 'outbox_entry',
                            entry: entry({ state: 'awaiting-check' }),
                            pin,
                        }),
                        json({
                            kind: 'outbox_entry',
                            entry: entry({ route: member, state: 'committed' }),
                        }),
                        json({
                            kind: 'outbox_entry',
                            entry: entry({ route: member }),
                            head: ['head'],
                        }),
                        json({
                            kind: 'outbox_entry',
                            entry: entry({ route: member }),
                            head: ['x', 'own'],
                        }),
                        json({
                            kind: 'outbox_entry',
                            entry: entry({ route: member }),
                            head: ['moved'],
                        }),
                        json({
                            kind: 'outbox_entry',
                            entry: entry({
                                route: {
                                    kind: 'rotation',
                                    workspaceId: d.family.areas[0].workspaceId,
                                },
                            }),
                        }),
                        json({ kind: 'outbox_entry', entry: entry({ v: 2 }), pin }),
                    ];
                })(),
                // The admin's join code over the roster-call family: each person, other keys, none, a roster left out, junk.
                ...[
                    { who: 2, keys: 2, rosters: [0, 1, 2, 3, 4, 5, 6] },
                    { who: 3, keys: 3, rosters: [0, 1, 2, 3, 4, 5, 6, 7] },
                    { who: 2, keys: 3, rosters: [0, 1, 2, 3, 4, 5, 6] },
                    { who: 2, keys: null, rosters: [0, 1, 2, 3, 4, 5, 6] },
                    { who: 6, keys: 4, rosters: [0, 1, 2, 3, 4, 5, 6] },
                    { who: 2, keys: 2, rosters: [0, 2, 3, 4, 5, 6] },
                ].map((k) => json({ kind: 'member_join_code', ...k })),
                // The shared session scenarios, cut to the kind's 12 steps.
                ...rosterCallSessions().scenarios.map((k: Json) =>
                    json({ kind: 'roster_call_session', steps: k.steps.slice(0, 12) }),
                ),
                // Every roster call both twins' fixtures make, and an admission with a planted key.
                ...coreRosterCalls().calls.map((k: Json) =>
                    json({ kind: 'roster_call', op: k.op }),
                ),
                json({
                    kind: 'roster_call',
                    op: {
                        kind: 'admit',
                        who: 4,
                        roles: [],
                        served: {
                            kemPublicKey: coreRosterCalls().calls[0].body.roster.signature.ed25519,
                        },
                    },
                }),
                // A chain committed first (the floor), and a server serving short of it or of the record.
                ...coreLedger()
                    .deviceRecords.cases.filter(
                        (k: Json) => k.recordValue !== null && k.recordVersion === 2,
                    )
                    .slice(0, 2)
                    .flatMap((k: Json) => [
                        json({
                            kind: 'device_record',
                            record: k.recordValue,
                            settings: false,
                            start: 2,
                            through: 2,
                            held: 3,
                        }),
                        json({
                            kind: 'device_record',
                            record: k.recordValue,
                            settings: false,
                            start: 0,
                            through: 3,
                            held: 2,
                        }),
                        json({
                            kind: 'device_record',
                            record: k.recordValue,
                            settings: true,
                            start: 0,
                            through: 1,
                        }),
                    ]),
            ];
        }
        case 'accept':
            return g.cases.map((k: Json) => json(k.input));
        case 'area_ledger':
            // Each scenario's steps, and its first half: a walk or a write cut short.
            return ledgerScenarios().scenarios.flatMap((k: Json) => [
                json({ steps: k.steps }),
                json({ steps: k.steps.slice(0, Math.ceil(k.steps.length / 2)) }),
            ]);
        case 'record_integrity':
            return [
                ...[c, w].flatMap((f: Json) => f.rekeyed.cases.map((k: Json) => json(k.input))),
                // Records each twin's walk re-keyed in a family folder, with the roster's trust.
                ...[coreLedger(), webLedger()].flatMap((f: Json) =>
                    f.rotations.flatMap((k: Json) => k.rekeyedInputs.map(json)),
                ),
            ];
        case 'origin_open': {
            const r = c.rekeyed.metadata;
            const theirs = w.rekeyed.metadata;
            // The core's opens; the web's is wrapped under another node key and reaches the AEAD check.
            return [
                new Uint8Array([...bytes(r.origin.keyEnvelope), ...bytes(r.origin.envelope)]),
                new Uint8Array([
                    ...bytes(theirs.origin.keyEnvelope),
                    ...bytes(theirs.origin.envelope),
                ]),
            ];
        }
    }
}

/* What each fuzzer's entry point for `target` consumes: the documents, or structured bytes. */
export function fuzzerSeeds(target: Target): Uint8Array[] {
    if (target === 'accept')
        // One byte picks the fixture case, both in structured.rs's History and jazzer.ts's provider.
        return Array.from({ length: groups().cases.length }, (_, i) => Uint8Array.of(i));
    if (target === 'roster_build')
        return Array.from({ length: 16 }, (_, i) =>
            Uint8Array.from({ length: 64 }, (_, j) => (i * 37 + j * 11) & 0xff),
        );
    return documents(target);
}

/* Writes every target's seeds into both corpora. */
export function writeSeeds(only?: Target) {
    const root = repository();
    for (const target of only ? [only] : TARGETS)
        for (const dir of [
            join(root, 'crates/hushos-core/fuzz/corpus', target),
            join(root, 'packages/crypto/fuzz/corpus', target),
        ]) {
            mkdirSync(dir, { recursive: true });
            for (const seed of fuzzerSeeds(target))
                writeFileSync(join(dir, createHash('sha1').update(seed).digest('hex')), seed);
        }
}

if (import.meta.main) writeSeeds();

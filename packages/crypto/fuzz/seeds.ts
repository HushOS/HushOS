import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GROUP } from '../src/group-testkit';
import { core, groups, repository, web, webGroups, type Json } from './fixtures';
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
            return unique([
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
            return g.rosters.map((r: Json) => json(r.roster));
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
            ];
        }
        case 'accept':
            return g.cases.map((k: Json) => json(k.input));
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

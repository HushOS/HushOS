import { describe, expect, test } from 'vitest';
import { areaKeyCommitment } from './area-keys';
import { encodeStatement } from './canonical';
import {
    companyCast,
    companyInput,
    companySeals,
    companyStart,
    rowOf,
    sealItemVerdict,
    withEntry,
} from './company-testkit';
import {
    CUSTODY_KEY_SEAL_BYTES,
    CUSTODY_PREVIOUS_BYTES,
    CUSTODY_SEAL_BYTES,
    KEY_ESCROW_BYTES,
    KIT_SEAL_BYTES,
    KIT_SEAL_PROOF_BYTES,
    PREVIOUS_NOTICE_SEED_BYTES,
    checkKitSeal,
    custodyFingerprint,
    custodyKeyPair,
    custodyKeySealStatement,
    custodyPreviousStatement,
    custodySealContext,
    custodySealStatement,
    custodyWords,
    keyEscrowStatement,
    kitKeys,
    kitSealProofStatement,
    kitSealStatement,
    noticeKeys,
    noticeSeed,
    openCustodyKey,
    openCustodyPrevious,
    openCustodySeal,
    openKeyEscrow,
    openKitSeal,
    openPreviousNoticeSeed,
    parseRecoveryRequest,
    recoveryRequestStatement,
    sealCustody,
    sealCustodyKey,
    sealCustodyPrevious,
    sealKeyEscrow,
    sealKit,
    signRecoveryRequest,
    verifyRecoveryRequest,
    wrapPreviousNoticeSeed,
    type CustodySealContext,
    type KitSealContext,
    type RecoveryRequest,
} from './custody';
import { CryptoError } from './errors';
import {
    AREA,
    GROUP,
    OTHER_GROUP,
    OWNER_ROLES,
    areaKeyAt,
    custodyAt,
    kitAt,
    pattern,
    type Person,
} from './group-testkit';
import { acceptRosters, type AcceptedRosters } from './group-trust';
import { verifyGroup, verifyKit } from './groups';
import { decode, encode } from './keys';
import {
    SEAL_COINS_BYTES,
    hybridSealedBytes,
    openHybrid,
    sealHybrid,
    sealWithCoins,
    sealedWithCoins,
    type HybridSealKind,
} from './sealing';
import { digest, signHybrid, verifyHybrid } from './signatures';

/*
 * The company key and everything sealed around it (docs/companies-design.md
 * 2.2, 3.7): each seal opens only as it was sealed and only from whoever the
 * chain entitles, a seal that lies about what it holds names its sealer, and
 * the kit and the notice keys derive as the design fixes them.
 */

const text = (value: Uint8Array) => new TextDecoder().decode(value);

/* A seal kind built outside custody.ts, as a hostile or broken client would seal: any payload under the real statement. */
async function kindFrom(
    statement: (sealed: Uint8Array) => Promise<Uint8Array>,
    info: string,
): Promise<HybridSealKind> {
    const parts = JSON.parse(text(await statement(new Uint8Array(0)))) as unknown[];
    return {
        info,
        associatedData: encodeStatement(parts.slice(0, -1)),
        statement,
        noun: 'x',
        invalid: 'x',
        unsigned: 'x',
    };
}

async function company() {
    const cast = await companyCast();
    const c = await companyStart(cast);
    const input = await companyInput(c.h, cast);
    const accept = async () => {
        const chain = await acceptRosters(await companyInput(c.h, cast));
        if (chain.status !== 'accepted') throw new Error('not accepted');
        return chain;
    };
    const chain = await accept();
    const key = await custodyAt(1);
    const kit = await kitAt(1);
    const at = (on: AcceptedRosters) => ({
        rosterVersion: on.roster.rosterVersion,
        rosterDigest: on.rosterDigest,
    });
    const opening = (on: AcceptedRosters, sealer: Person) => ({
        chain: on,
        sealerMlDsaPublicKey: decode(sealer.served.mlDsaPublicKey),
    });
    return { cast, c, input, accept, chain, key, kit, at, opening };
}

describe('folder keys sealed to the company key', () => {
    test('a data admin opens a folder’s key through the company key, and only as it was sealed', async () => {
        const { cast, chain, key, at, opening } = await company();
        const ctx: CustodySealContext = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            custodyKeyVersion: 1,
            sealerUserId: cast.owner.userId,
            ...at(chain),
        };
        const areaKey = areaKeyAt(AREA, 1);
        const envelope = await sealCustody(areaKey, ctx, {
            chain,
            custodyKemPublicKey: decode(key.publicKey.kemPublicKey),
            sealer: cast.owner.signer,
        });
        expect(envelope).toHaveLength(CUSTODY_SEAL_BYTES);
        expect(CUSTODY_SEAL_BYTES).toBe(4565);
        expect(text(await custodySealStatement(ctx, envelope.subarray(0, 1192)))).toBe(
            JSON.stringify([
                'hushos/group/custody-seal',
                1,
                GROUP,
                AREA,
                1,
                1,
                cast.owner.userId,
                2,
                chain.rosterDigest,
                await digest(envelope.subarray(0, 1192)),
            ]),
        );
        const open = (over: Partial<CustodySealContext> = {}, seed = key.seed) =>
            openCustodySeal(
                envelope,
                { ...ctx, ...over },
                {
                    ...opening(chain, cast.owner),
                    custodySeed: seed,
                },
            );
        expect(await open()).toEqual({ status: 'opened', value: areaKey });
        // Another company key version, area, area version, roster or sealer: each is refused.
        await expect(open({ custodyKeyVersion: 2 })).rejects.toThrow(CryptoError);
        await expect(open({ workspaceId: OTHER_GROUP })).rejects.toThrow(CryptoError);
        await expect(open({ workspaceKeyVersion: 2 })).rejects.toThrow(CryptoError);
        await expect(open({ rosterVersion: 1 })).rejects.toThrow(
            'This was sealed on a member list this device does not have.',
        );
        await expect(open({ rosterDigest: encode(pattern(32, 3)) })).rejects.toThrow(CryptoError);
        await expect(open({ sealerUserId: cast.second.userId })).rejects.toThrow(CryptoError);
        // A seed that is not the company's opens nothing, and one flipped byte is not a seal.
        await expect(open({}, (await custodyAt(2)).seed)).rejects.toThrow(
            'This is not the company’s published key.',
        );
        const flipped = envelope.slice();
        flipped[1150]! ^= 1;
        await expect(
            openCustodySeal(flipped, ctx, { ...opening(chain, cast.owner), custodySeed: key.seed }),
        ).rejects.toThrow(CryptoError);
    });

    test('a seal replayed for another area fails, and one that holds another key names its sealer', async () => {
        const { cast, c, accept, key, at, opening } = await company();
        // A second folder, listed by an Admin on roster 3.
        const second = await rowOf(1, 1);
        await c.h.roster(cast.admin, c.all, undefined, [second]);
        const chain = await accept();
        const base = {
            groupId: GROUP,
            custodyKeyVersion: 1,
            sealerUserId: cast.admin.userId,
            ...at(chain),
        };
        const ctx = { ...base, workspaceId: second.workspaceId, workspaceKeyVersion: 1 };
        const secondKey = pattern(32, 300 + 7 + 1);
        const envelope = await sealCustody(secondKey, ctx, {
            chain,
            custodyKemPublicKey: decode(key.publicKey.kemPublicKey),
            sealer: cast.admin.signer,
        });
        const open = (sealed: Uint8Array, over: Partial<CustodySealContext> = {}) =>
            openCustodySeal(
                sealed,
                { ...ctx, ...over },
                {
                    ...opening(chain, cast.admin),
                    custodySeed: key.seed,
                },
            );
        expect((await open(envelope)).status).toBe('opened');
        await expect(open(envelope, { workspaceId: AREA })).rejects.toThrow(CryptoError);
        // The Admin's own app seals another key under the row it listed: the statement holds,
        // the key is not the committed one, and the check says whose seal it is.
        const kind = await kindFrom(
            (sealed) => custodySealStatement(ctx, sealed),
            'hushos/group/custody-seal/v1',
        );
        expect(kind.associatedData).toEqual(custodySealContext(ctx));
        const recipient = {
            encryptionPublicKey: decode(key.publicKey.encryptionPublicKey),
            kemPublicKey: decode(key.publicKey.kemPublicKey),
        };
        const lying = await sealHybrid(pattern(32, 4), recipient, cast.admin.signer, kind);
        expect(await open(lying)).toEqual({ status: 'bad', sealerUserId: cast.admin.userId });
        // Sealed to another key than the company's: it does not open, and that too is the sealer's.
        const elsewhere = await sealHybrid(
            secondKey,
            {
                encryptionPublicKey: decode((await custodyAt(2)).publicKey.encryptionPublicKey),
                kemPublicKey: decode((await custodyAt(2)).publicKey.kemPublicKey),
            },
            cast.admin.signer,
            kind,
        );
        expect(await open(elsewhere)).toEqual({ status: 'bad', sealerUserId: cast.admin.userId });
    });

    test('only whoever made the key, or a data admin on the roster named, seals; personal keys never enter', async () => {
        const { cast, chain, key, at, opening } = await company();
        const kem = decode(key.publicKey.kemPublicKey);
        const ctx: CustodySealContext = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            custodyKeyVersion: 1,
            sealerUserId: cast.member.userId,
            ...at(chain),
        };
        const areaKey = areaKeyAt(AREA, 1);
        const seal = (over: Partial<CustodySealContext>, who: Person, workspaceKey = areaKey) =>
            sealCustody(
                workspaceKey,
                { ...ctx, ...over },
                {
                    chain,
                    custodyKemPublicKey: kem,
                    sealer: who.signer,
                },
            );
        // A Member, a Billing holder and a kit holder are no data admins.
        for (const who of [cast.member, cast.biller, cast.keeper])
            await expect(seal({ sealerUserId: who.userId }, who)).rejects.toThrow(
                'sealed to the company by whoever made it, or by a data admin',
            );
        // A workspace the chain does not list for this company, a key it does not commit to, a
        // version it never listed, an older company key, another's signing keys.
        const admin = { sealerUserId: cast.admin.userId };
        await expect(
            seal({ ...admin, workspaceId: 'c0000009-8dfc-4914-8447-0417b55e2ec5' }, cast.admin),
        ).rejects.toThrow('This area key is not the one the group’s member list names.');
        await expect(seal(admin, cast.admin, pattern(32, 1))).rejects.toThrow(
            'This area key is not the one the group’s member list names.',
        );
        await expect(seal({ ...admin, workspaceKeyVersion: 2 }, cast.admin)).rejects.toThrow(
            CryptoError,
        );
        await expect(seal({ ...admin, custodyKeyVersion: 2 }, cast.admin)).rejects.toThrow(
            CryptoError,
        );
        await expect(seal(admin, cast.second)).rejects.toThrow(
            'These are not the sealer’s keys on the group’s member list.',
        );
        await expect(seal({ ...admin, rosterVersion: 1 }, cast.admin)).rejects.toThrow(
            'A seal names the latest member list this device accepted.',
        );
        // A served ML-KEM key the roster's digest does not name is never sealed to.
        await expect(
            sealCustody(
                areaKey,
                { ...ctx, ...admin },
                {
                    chain,
                    custodyKemPublicKey: decode((await custodyAt(2)).publicKey.kemPublicKey),
                    sealer: cast.admin.signer,
                },
            ),
        ).rejects.toThrow(CryptoError);
        // A seal a Member's modified app made by hand, under the real statement, opens for nobody.
        const kind = await kindFrom(
            (sealed) => custodySealStatement(ctx, sealed),
            'hushos/group/custody-seal/v1',
        );
        const forged = await sealHybrid(
            areaKey,
            { encryptionPublicKey: decode(key.publicKey.encryptionPublicKey), kemPublicKey: kem },
            cast.member.signer,
            kind,
        );
        await expect(
            openCustodySeal(forged, ctx, { ...opening(chain, cast.member), custodySeed: key.seed }),
        ).rejects.toThrow('not sealed by whoever made it, or by a data admin');
        expect(await areaKeyCommitment(areaKey)).toBe(chain.areaKeys[AREA]![0]);
    });
});

describe('the company seed', () => {
    test('opens only for the holder and key version named, from a data admin, and only to the chain’s key', async () => {
        const { cast, chain, key, at, opening } = await company();
        const ctx = {
            groupId: GROUP,
            custodyKeyVersion: 1,
            holderUserId: cast.admin.userId,
            holderKeyVersion: 1,
            sealerUserId: cast.owner.userId,
            ...at(chain),
        };
        const sealing = {
            chain,
            holderKemPublicKey: cast.admin.kemPublicKey,
            sealer: cast.owner.signer,
        };
        const envelope = await sealCustodyKey(key.seed, ctx, sealing);
        expect(envelope).toHaveLength(CUSTODY_KEY_SEAL_BYTES);
        expect(CUSTODY_KEY_SEAL_BYTES).toBe(4629);
        expect(
            JSON.parse(text(await custodyKeySealStatement(ctx, new Uint8Array(0)))).slice(0, 9),
        ).toEqual([
            'hushos/group/custody-key-seal',
            1,
            GROUP,
            1,
            cast.admin.userId,
            1,
            cast.owner.userId,
            2,
            chain.rosterDigest,
        ]);
        const open = (over: Partial<typeof ctx> = {}, reader = cast.admin) =>
            openCustodyKey(
                envelope,
                { ...ctx, ...over },
                {
                    ...opening(chain, cast.owner),
                    reader: { userId: reader.userId, keyVersion: 1 },
                    holder: reader.secrets,
                },
            );
        expect(await open()).toEqual(key.seed);
        await expect(open({}, cast.admin2)).rejects.toThrow(
            'This company key was not sealed to this account’s keys.',
        );
        await expect(open({ holderKeyVersion: 2 })).rejects.toThrow(CryptoError);
        await expect(open({ custodyKeyVersion: 2 })).rejects.toThrow(CryptoError);
        await expect(open({ sealerUserId: cast.member.userId })).rejects.toThrow(
            'This company key was not sealed by a data admin.',
        );
        // Sealing: only the chain's seed, only by and to data admins, at the entry's key version.
        await expect(sealCustodyKey((await custodyAt(2)).seed, ctx, sealing)).rejects.toThrow(
            'This is not the company’s published key.',
        );
        await expect(
            sealCustodyKey(
                key.seed,
                { ...ctx, sealerUserId: cast.member.userId },
                {
                    ...sealing,
                    sealer: cast.member.signer,
                },
            ),
        ).rejects.toThrow('The company key is sealed only by a data admin.');
        await expect(
            sealCustodyKey(
                key.seed,
                { ...ctx, holderUserId: cast.member.userId },
                {
                    ...sealing,
                    holderKemPublicKey: cast.member.kemPublicKey,
                },
            ),
        ).rejects.toThrow('The company key is sealed only to data admins.');
        await expect(
            sealCustodyKey(key.seed, { ...ctx, holderKeyVersion: 2 }, sealing),
        ).rejects.toThrow('The company key is sealed only to data admins.');
        // A data admin handed another seed under the real statement signs for nothing: refused.
        const kind = await kindFrom(
            (sealed) => custodyKeySealStatement(ctx, sealed),
            'hushos/group/custody-key-seal/v1',
        );
        const substitute = await sealHybrid(
            (await custodyAt(2)).seed,
            {
                encryptionPublicKey: decode(cast.admin.served.encryptionPublicKey),
                kemPublicKey: cast.admin.kemPublicKey,
            },
            cast.owner.signer,
            kind,
        );
        await expect(
            openCustodyKey(substitute, ctx, {
                ...opening(chain, cast.owner),
                reader: { userId: cast.admin.userId, keyVersion: 1 },
                holder: cast.admin.secrets,
            }),
        ).rejects.toThrow('This is not the company’s published key.');
    });
});

describe('the recovery kit', () => {
    test('its four key pairs come from its secret and the company’s id, and from nothing else', async () => {
        const kit = await kitAt(1);
        const again = await kitKeys(kit.secret, GROUP);
        expect(again.publicKeys).toEqual(kit.publicKeys);
        const other = await kitKeys(kit.secret, OTHER_GROUP);
        for (const name of [
            'encryptionPublicKey',
            'kemPublicKey',
            'signingPublicKey',
            'mlDsaPublicKey',
        ] as const)
            expect(other.publicKeys[name]).not.toBe(kit.publicKeys[name]);
        expect(decode(kit.publicKeys.kemPublicKey)).toHaveLength(1184);
        expect(decode(kit.publicKeys.mlDsaPublicKey)).toHaveLength(1952);
        await expect(kitKeys(new Uint8Array(31), GROUP)).rejects.toThrow('Invalid recovery kit.');
        await expect(kitKeys(kit.secret, GROUP.toUpperCase())).rejects.toThrow(CryptoError);
        // The company key's pair is its seed's two halves: X25519 from the first 32 bytes alone.
        const key = await custodyAt(1);
        const swapped = key.seed.slice();
        swapped[40]! ^= 1;
        const moved = await custodyKeyPair(swapped);
        expect(moved.publicKey.encryptionPublicKey).toBe(key.publicKey.encryptionPublicKey);
        expect(moved.publicKey.kemPublicKey).not.toBe(key.publicKey.kemPublicKey);
        await expect(custodyKeyPair(new Uint8Array(95))).rejects.toThrow('Invalid company key.');
    });

    test('the kit seal opens with the kit, and its proof lets a data admin see that it will', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        // The seal is made on the roster that introduces the key: here, the company's first.
        const first = await acceptRosters({
            ...(await companyInput(c.h, cast)),
            rosters: [c.h.rosters[0]!],
        });
        if (first.status !== 'accepted') throw new Error('not accepted');
        const key = await custodyAt(1);
        const kit = await kitAt(1);
        const ctx: KitSealContext = {
            groupId: GROUP,
            custodyKeyVersion: 1,
            kitVersion: 1,
            sealerUserId: cast.owner.userId,
            rosterVersion: 1,
            rosterDigest: first.rosterDigest,
        };
        const sealing = {
            chain: first,
            kitKemPublicKey: decode(kit.publicKeys.kemPublicKey),
            custodyKemPublicKey: decode(key.publicKey.kemPublicKey),
            sealer: cast.owner.signer,
        };
        const { kitSeal, proof } = await sealKit(key.seed, ctx, sealing);
        expect([kitSeal.length, proof.length]).toEqual([KIT_SEAL_BYTES, KIT_SEAL_PROOF_BYTES]);
        expect([KIT_SEAL_BYTES, KIT_SEAL_PROOF_BYTES]).toEqual([4629, 4621]);
        expect(
            JSON.parse(text(await kitSealProofStatement(ctx, kitSeal, new Uint8Array(0)))),
        ).toEqual([
            'hushos/group/kit-seal-proof',
            1,
            GROUP,
            1,
            1,
            cast.owner.userId,
            1,
            first.rosterDigest,
            await digest(kitSeal),
            await digest(new Uint8Array(0)),
        ]);
        // Later, on the full chain, a data admin checks it and the kit opens it.
        const chain = await acceptRosters(await companyInput(c.h, cast));
        if (chain.status !== 'accepted') throw new Error('not accepted');
        const checking = {
            chain,
            sealerMlDsaPublicKey: decode(cast.owner.served.mlDsaPublicKey),
            kitKemPublicKey: decode(kit.publicKeys.kemPublicKey),
            custodySeed: key.seed,
        };
        expect(await checkKitSeal(kitSeal, proof, ctx, checking)).toEqual({
            status: 'opened',
            value: true,
        });
        const opening = {
            chain,
            sealerMlDsaPublicKey: decode(cast.owner.served.mlDsaPublicKey),
            kitSecret: kit.secret,
        };
        expect(await openKitSeal(kitSeal, ctx, opening)).toEqual(key.seed);
        // Another company's kit (the same secret under another id), or another secret, opens nothing.
        await expect(
            openKitSeal(kitSeal, ctx, { ...opening, kitSecret: (await kitAt(2)).secret }),
        ).rejects.toThrow('This is not the company’s recovery kit.');
        const foreign = await kitKeys(kit.secret, OTHER_GROUP);
        const kind = await kindFrom(
            (sealed) => kitSealStatement(ctx, sealed),
            'hushos/group/kit-seal/v1',
        );
        const owner = [
            {
                signingPublicKey: decode(cast.owner.served.signingPublicKey),
                mlDsaPublicKey: decode(cast.owner.served.mlDsaPublicKey),
            },
        ];
        await expect(openHybrid(kitSeal, 96, owner, foreign.secrets, kind)).rejects.toThrow(
            CryptoError,
        );
        expect(await openHybrid(kitSeal, 96, owner, (await kitAt(1)).secrets, kind)).toEqual(
            key.seed,
        );
        // A kit seal with junk in place of the seed, made with a proof of its own coins: the
        // check runs the seal again with the real seed, sees another seal, and names the sealer.
        const coins = pattern(SEAL_COINS_BYTES, 12);
        const toKit = {
            encryptionPublicKey: decode(kit.publicKeys.encryptionPublicKey),
            kemPublicKey: decode(kit.publicKeys.kemPublicKey),
        };
        const junk = await sealWithCoins(pattern(96, 13), toKit, cast.owner.signer, kind, coins);
        const junkProof = await sealHybrid(
            coins,
            {
                encryptionPublicKey: decode(key.publicKey.encryptionPublicKey),
                kemPublicKey: decode(key.publicKey.kemPublicKey),
            },
            cast.owner.signer,
            await kindFrom(
                (sealed) => kitSealProofStatement(ctx, junk, sealed),
                'hushos/group/kit-seal-proof/v1',
            ),
        );
        expect(await checkKitSeal(junk, junkProof, ctx, checking)).toEqual({
            status: 'bad',
            sealerUserId: cast.owner.userId,
        });
        // A proof for another kit seal is no proof of this one; nor is a seal with a byte moved.
        const twice = await sealKit(key.seed, ctx, sealing);
        await expect(checkKitSeal(kitSeal, twice.proof, ctx, checking)).rejects.toThrow(
            CryptoError,
        );
        await expect(checkKitSeal(twice.kitSeal, proof, ctx, checking)).rejects.toThrow(
            CryptoError,
        );
        expect(await checkKitSeal(twice.kitSeal, twice.proof, ctx, checking)).toMatchObject({
            status: 'opened',
        });
        // Only the Owner who introduced the key seals it to the kit, on that roster.
        await expect(
            sealKit(
                key.seed,
                { ...ctx, rosterVersion: 2, rosterDigest: chain.rosterDigest },
                {
                    ...sealing,
                    chain,
                },
            ),
        ).rejects.toThrow('by the owner who made the key');
        await expect(
            checkKitSeal(kitSeal, proof, { ...ctx, sealerUserId: cast.second.userId }, checking),
        ).rejects.toThrow('by the owner who made the key');
        await expect(sealKit(pattern(96, 14), ctx, sealing)).rejects.toThrow(
            'This is not the company’s published key.',
        );
    });

    test('sealWithCoins gives the same bytes from the same inputs, up to the signature', async () => {
        const cast = await companyCast();
        const key = await custodyAt(1);
        const recipient = {
            encryptionPublicKey: decode(key.publicKey.encryptionPublicKey),
            kemPublicKey: decode(key.publicKey.kemPublicKey),
        };
        const kind: HybridSealKind = {
            info: 'hushos/test/coins/v1',
            associatedData: pattern(20, 1),
            statement: async (sealed) => sealed.slice(0, 40),
            noun: 'x',
            invalid: 'x',
            unsigned: 'x',
        };
        const coins = pattern(SEAL_COINS_BYTES, 7);
        const payload = pattern(96, 8);
        const one = await sealWithCoins(payload, recipient, cast.owner.signer, kind, coins);
        const two = await sealWithCoins(payload, recipient, cast.owner.signer, kind, coins);
        const sealed = hybridSealedBytes(96);
        expect(sealed).toBe(1256);
        expect(one.subarray(0, sealed)).toEqual(two.subarray(0, sealed));
        expect(one.subarray(sealed)).not.toEqual(two.subarray(sealed));
        expect(await sealedWithCoins(payload, recipient, kind, coins)).toEqual(
            one.subarray(0, sealed),
        );
        // Each coin matters: the ephemeral key, the encapsulation and the nonce.
        // (Byte 0's low bits are clamped away by X25519, so another byte of the secret is moved.)
        for (const at of [5, 40, 70]) {
            const other = coins.slice();
            other[at]! ^= 1;
            expect(await sealedWithCoins(payload, recipient, kind, other)).not.toEqual(
                one.subarray(0, sealed),
            );
        }
        await expect(sealedWithCoins(payload, recipient, kind, coins.subarray(1))).rejects.toThrow(
            'Invalid seal randomness.',
        );
        // It is an ordinary seal: the recipient opens it.
        const signer = [
            {
                signingPublicKey: decode(cast.owner.served.signingPublicKey),
                mlDsaPublicKey: decode(cast.owner.served.mlDsaPublicKey),
            },
        ];
        expect(await openHybrid(one, 96, signer, key.secrets, kind)).toEqual(payload);
    });

    test('the kit’s signing keys are no group key and no person’s: its signature verifies as neither', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        const promoted = withEntry(c, { ...c.e.keeper, roles: [...OWNER_ROLES] });
        const signed = await c.h.roster(cast.keeper, promoted, undefined, [], { kit: 1 });
        const kit = (await kitAt(1)).publicKeys;
        const keys = {
            signingPublicKey: decode(kit.signingPublicKey),
            mlDsaPublicKey: decode(kit.mlDsaPublicKey),
        };
        const kitSignature = signed.kitSignature!;
        // It is over the recovery-roster statement, never over the roster itself.
        expect(await verifyKit(signed.statement, kitSignature, keys)).toBe(false);
        expect(await verifyHybrid(signed.statement, kitSignature, keys)).toBe(false);
        // A person's signature by the kit's own keys (another ML-DSA context) is no kit signature,
        // and a group signature repacked as one is not either.
        const asPerson = await signHybrid(signed.statement, (await kitAt(1)).signer);
        expect(await verifyKit(signed.statement, asPerson, keys)).toBe(false);
        const repacked = new Uint8Array(3373);
        repacked.set(signed.signature.ed25519);
        repacked.set(signed.signature.mlDsa, 64);
        const groupKey = c.h.keys[0]!.publicKey;
        expect(
            await verifyKit(signed.statement, repacked, {
                signingPublicKey: decode(groupKey.ed25519PublicKey),
                mlDsaPublicKey: decode(groupKey.mlDsaPublicKey),
            }),
        ).toBe(false);
        expect(
            await verifyGroup(
                signed.statement,
                { ed25519: kitSignature.subarray(0, 64), mlDsa: kitSignature.subarray(64) },
                { ed25519PublicKey: kit.signingPublicKey, mlDsaPublicKey: kit.mlDsaPublicKey },
            ),
        ).toBe(false);
    });
});

describe('the escrow and previousEnvelope', () => {
    test('the escrow opens to the group seed under the company key it names, and a wrong seed names its sealer', async () => {
        const { cast, chain, key, at, opening } = await company();
        const groupSeed = pattern(64, 91);
        const ctx = {
            groupId: GROUP,
            groupKeyVersion: 1,
            custodyKeyVersion: 1,
            sealerUserId: cast.owner.userId,
            ...at(chain),
        };
        const sealing = {
            chain,
            custodyKemPublicKey: decode(key.publicKey.kemPublicKey),
            sealer: cast.owner.signer,
        };
        const envelope = await sealKeyEscrow(groupSeed, ctx, sealing);
        expect(envelope).toHaveLength(KEY_ESCROW_BYTES);
        expect(KEY_ESCROW_BYTES).toBe(4597);
        expect(
            JSON.parse(text(await keyEscrowStatement(ctx, new Uint8Array(0)))).slice(0, 8),
        ).toEqual([
            'hushos/group/key-escrow',
            1,
            GROUP,
            1,
            1,
            cast.owner.userId,
            2,
            chain.rosterDigest,
        ]);
        const open = (sealed: Uint8Array, over: Partial<typeof ctx> = {}, seed = key.seed) =>
            openKeyEscrow(
                sealed,
                { ...ctx, ...over },
                {
                    ...opening(chain, cast.owner),
                    custodySeed: seed,
                },
            );
        expect(await open(envelope)).toEqual({ status: 'opened', value: groupSeed });
        await expect(open(envelope, { custodyKeyVersion: 2 })).rejects.toThrow(CryptoError);
        await expect(open(envelope, { groupKeyVersion: 2 })).rejects.toThrow(CryptoError);
        await expect(open(envelope, {}, (await custodyAt(2)).seed)).rejects.toThrow(
            'This is not the company’s published key.',
        );
        // Only whoever made the group key or the company key seals it; an Admin does not.
        await expect(
            sealKeyEscrow(
                groupSeed,
                { ...ctx, sealerUserId: cast.admin.userId },
                {
                    ...sealing,
                    sealer: cast.admin.signer,
                },
            ),
        ).rejects.toThrow('by the owner who made either');
        await expect(open(envelope, { sealerUserId: cast.admin.userId })).rejects.toThrow(
            'by the owner who made either',
        );
        await expect(sealKeyEscrow(pattern(64, 92), ctx, sealing)).rejects.toThrow(
            'This group key is not the group’s published key.',
        );
        // The Owner's app escrows another seed: it opens, is not the chain's group key, and
        // every data admin's check says so, naming the Owner.
        const lying = await sealHybrid(
            pattern(64, 92),
            {
                encryptionPublicKey: decode(key.publicKey.encryptionPublicKey),
                kemPublicKey: decode(key.publicKey.kemPublicKey),
            },
            cast.owner.signer,
            await kindFrom(
                (sealed) => keyEscrowStatement(ctx, sealed),
                'hushos/group/key-escrow/v1',
            ),
        );
        expect(await open(lying)).toEqual({ status: 'bad', sealerUserId: cast.owner.userId });
    });

    test('previousEnvelope chains back: a data admin at version 3 opens what versions 1 and 2 hold, and version 1 alone opens nothing of 2', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        const accept = async () => {
            const chain = await acceptRosters(await companyInput(c.h, cast));
            if (chain.status !== 'accepted') throw new Error('not accepted');
            return chain;
        };
        const [one, two, three] = [await custodyAt(1), await custodyAt(2), await custodyAt(3)];
        const two0 = await accept();
        // A folder's key sealed to version 1, while it is the company key.
        const sealCtx: CustodySealContext = {
            groupId: GROUP,
            workspaceId: AREA,
            workspaceKeyVersion: 1,
            custodyKeyVersion: 1,
            sealerUserId: cast.owner.userId,
            rosterVersion: 2,
            rosterDigest: two0.rosterDigest,
        };
        const folderSeal = await sealCustody(areaKeyAt(AREA, 1), sealCtx, {
            chain: two0,
            custodyKemPublicKey: decode(one.publicKey.kemPublicKey),
            sealer: cast.owner.signer,
        });
        // Roster 3: the Owner replaces the key (1 to 2). Roster 4: the second Owner (2 to 3).
        await c.h.roster(cast.owner, c.all, undefined, undefined, { custodyVersion: 2 });
        const at3 = await accept();
        const ctx2 = {
            groupId: GROUP,
            custodyKeyVersion: 2,
            previousVersion: 1,
            sealerUserId: cast.owner.userId,
            rosterVersion: 3,
            rosterDigest: at3.rosterDigest,
        };
        const previous2 = await sealCustodyPrevious(one.seed, ctx2, {
            chain: at3,
            custodyKemPublicKey: decode(two.publicKey.kemPublicKey),
            sealer: cast.owner.signer,
        });
        expect(previous2).toHaveLength(CUSTODY_PREVIOUS_BYTES);
        expect(
            JSON.parse(text(await custodyPreviousStatement(ctx2, new Uint8Array(0)))).slice(0, 8),
        ).toEqual([
            'hushos/group/custody-previous',
            1,
            GROUP,
            2,
            1,
            cast.owner.userId,
            3,
            at3.rosterDigest,
        ]);
        await c.h.roster(cast.second, c.all, undefined, undefined, { custodyVersion: 3 });
        const chain = await accept();
        const ctx3 = {
            groupId: GROUP,
            custodyKeyVersion: 3,
            previousVersion: 2,
            sealerUserId: cast.second.userId,
            rosterVersion: 4,
            rosterDigest: chain.rosterDigest,
        };
        const previous3 = await sealCustodyPrevious(two.seed, ctx3, {
            chain,
            custodyKemPublicKey: decode(three.publicKey.kemPublicKey),
            sealer: cast.second.signer,
        });
        const by = (who: Person) => ({
            chain,
            sealerMlDsaPublicKey: decode(who.served.mlDsaPublicKey),
        });
        // From the seed of version 3, back to 2, back to 1, and into the folder sealed to 1.
        const back2 = await openCustodyPrevious(previous3, ctx3, {
            ...by(cast.second),
            custodySeed: three.seed,
        });
        expect(back2).toEqual({ status: 'opened', value: two.seed });
        const back1 = await openCustodyPrevious(previous2, ctx2, {
            ...by(cast.owner),
            custodySeed: two.seed,
        });
        expect(back1).toEqual({ status: 'opened', value: one.seed });
        expect(
            await openCustodySeal(folderSeal, sealCtx, {
                ...by(cast.owner),
                custodySeed: one.seed,
            }),
        ).toEqual({ status: 'opened', value: areaKeyAt(AREA, 1) });
        // Someone who held only version 1 opens nothing of 2: not through the API, not by hand.
        await expect(
            openCustodyPrevious(previous3, ctx3, { ...by(cast.second), custodySeed: one.seed }),
        ).rejects.toThrow('This is not the company’s published key.');
        const kind = await kindFrom(
            (sealed) => custodyPreviousStatement(ctx3, sealed),
            'hushos/group/custody-previous/v1',
        );
        await expect(
            openHybrid(
                previous3,
                96,
                [
                    {
                        signingPublicKey: decode(cast.second.served.signingPublicKey),
                        mlDsaPublicKey: decode(cast.second.served.mlDsaPublicKey),
                    },
                ],
                one.secrets,
                kind,
            ),
        ).rejects.toThrow(CryptoError);
        // Only the replacing Owner makes it, on the roster that introduced the key, of the seed
        // before; a seed that is not the chain's earlier key names its sealer when opened.
        const sealing = {
            chain,
            custodyKemPublicKey: decode(three.publicKey.kemPublicKey),
            sealer: cast.second.signer,
        };
        await expect(sealCustodyPrevious(one.seed, ctx3, sealing)).rejects.toThrow(
            'This is not the company’s published key.',
        );
        await expect(
            sealCustodyPrevious(
                two.seed,
                { ...ctx3, sealerUserId: cast.owner.userId },
                {
                    ...sealing,
                    sealer: cast.owner.signer,
                },
            ),
        ).rejects.toThrow('by the owner who replaced it');
        await expect(
            sealCustodyPrevious(two.seed, { ...ctx3, previousVersion: 1 }, sealing),
        ).rejects.toThrow('Invalid company key version.');
        const lying = await sealHybrid(
            one.seed,
            {
                encryptionPublicKey: decode(three.publicKey.encryptionPublicKey),
                kemPublicKey: decode(three.publicKey.kemPublicKey),
            },
            cast.second.signer,
            kind,
        );
        expect(
            await openCustodyPrevious(lying, ctx3, { ...by(cast.second), custodySeed: three.seed }),
        ).toEqual({ status: 'bad', sealerUserId: cast.second.userId });
    });

    test('an old kit opens nothing after the roster that replaced it', async () => {
        const cast = await companyCast();
        const c = await companyStart(cast);
        // The Owner takes "can use the kit" from its holder: a new kit and a new company key.
        const taken = withEntry(c, { ...c.e.keeper, roles: [] });
        await c.h.roster(cast.owner, taken, undefined, undefined, {
            custodyVersion: 2,
            kitVersion: 2,
        });
        const chain = await acceptRosters(await companyInput(c.h, cast));
        if (chain.status !== 'accepted') throw new Error('not accepted');
        const [key2, kit1, kit2] = [await custodyAt(2), await kitAt(1), await kitAt(2)];
        const ctx: KitSealContext = {
            groupId: GROUP,
            custodyKeyVersion: 2,
            kitVersion: 2,
            sealerUserId: cast.owner.userId,
            rosterVersion: 3,
            rosterDigest: chain.rosterDigest,
        };
        // What the server stores from that roster on: the new seed sealed to the new kit.
        const { kitSeal } = await sealKit(key2.seed, ctx, {
            chain,
            kitKemPublicKey: decode(kit2.publicKeys.kemPublicKey),
            custodyKemPublicKey: decode(key2.publicKey.kemPublicKey),
            sealer: cast.owner.signer,
        });
        const opening = {
            chain,
            sealerMlDsaPublicKey: decode(cast.owner.served.mlDsaPublicKey),
        };
        expect(await openKitSeal(kitSeal, ctx, { ...opening, kitSecret: kit2.secret })).toEqual(
            key2.seed,
        );
        // The old kit: refused as the kit of version 2, refused as "kit 1" for the new key, and
        // by hand its keys open nothing.
        await expect(
            openKitSeal(kitSeal, ctx, { ...opening, kitSecret: kit1.secret }),
        ).rejects.toThrow('This is not the company’s recovery kit.');
        await expect(
            openKitSeal(kitSeal, { ...ctx, kitVersion: 1 }, { ...opening, kitSecret: kit1.secret }),
        ).rejects.toThrow(CryptoError);
        const kind = await kindFrom(
            (sealed) => kitSealStatement(ctx, sealed),
            'hushos/group/kit-seal/v1',
        );
        await expect(
            openHybrid(
                kitSeal,
                96,
                [
                    {
                        signingPublicKey: decode(cast.owner.served.signingPublicKey),
                        mlDsaPublicKey: decode(cast.owner.served.mlDsaPublicKey),
                    },
                ],
                kit1.secrets,
                kind,
            ),
        ).rejects.toThrow(CryptoError);
        // The new key is never sealed to the old kit: the chain names kit 2 for it.
        await expect(
            sealKit(
                key2.seed,
                { ...ctx, kitVersion: 1 },
                {
                    chain,
                    kitKemPublicKey: decode(kit1.publicKeys.kemPublicKey),
                    custodyKemPublicKey: decode(key2.publicKey.kemPublicKey),
                    sealer: cast.owner.signer,
                },
            ),
        ).rejects.toThrow(CryptoError);
    });
});

describe('asking to use the kit', () => {
    test('a request verifies only from an entry that holds `recovery`, for the kit and company key now', async () => {
        const { cast, c, accept, chain, at } = await company();
        const request: RecoveryRequest = {
            groupId: GROUP,
            requesterUserId: cast.keeper.userId,
            requesterKeyVersion: 1,
            kitVersion: 1,
            custodyKeyVersion: 1,
            ...at(chain),
            requestedAt: '2026-11-03T09:00:00.000Z',
        };
        const signed = await signRecoveryRequest(request, { chain, signer: cast.keeper.signer });
        expect(text(signed.statement)).toBe(
            JSON.stringify([
                'hushos/group/recovery-request',
                1,
                GROUP,
                cast.keeper.userId,
                1,
                1,
                1,
                2,
                chain.rosterDigest,
                '2026-11-03T09:00:00.000Z',
            ]),
        );
        expect(parseRecoveryRequest(signed.statement)).toEqual(request);
        const verify = (
            statement: Uint8Array,
            signature: Uint8Array,
            on = chain,
            who = cast.keeper,
        ) =>
            verifyRecoveryRequest(statement, signature, {
                chain: on,
                requesterMlDsaPublicKey: decode(who.served.mlDsaPublicKey),
            });
        expect(await verify(signed.statement, signed.signature)).toEqual(request);
        // A byte of the signature, another member's signature, another served key.
        const flipped = signed.signature.slice();
        flipped[10]! ^= 1;
        await expect(verify(signed.statement, flipped)).rejects.toThrow(CryptoError);
        await expect(
            verify(signed.statement, await signHybrid(signed.statement, cast.admin.signer)),
        ).rejects.toThrow('This request is not signed by the member it names.');
        await expect(verify(signed.statement, signed.signature, chain, cast.admin)).rejects.toThrow(
            CryptoError,
        );
        // Nobody without `recovery` asks: an Admin cannot sign one, and one signed by hand is refused.
        const fromAdmin = { ...request, requesterUserId: cast.admin.userId };
        await expect(
            signRecoveryRequest(fromAdmin, { chain, signer: cast.admin.signer }),
        ).rejects.toThrow('Only someone who can use the recovery kit asks to use it.');
        const byHand = recoveryRequestStatement(fromAdmin);
        await expect(
            verify(byHand, await signHybrid(byHand, cast.admin.signer), chain, cast.admin),
        ).rejects.toThrow('Only someone who can use the recovery kit asks to use it.');
        // For another kit or company key version, another key version of theirs, a time out of form.
        for (const over of [
            { kitVersion: 2 },
            { custodyKeyVersion: 2 },
            { requesterKeyVersion: 2 },
        ])
            await expect(
                signRecoveryRequest({ ...request, ...over }, { chain, signer: cast.keeper.signer }),
            ).rejects.toThrow(CryptoError);
        expect(() => recoveryRequestStatement({ ...request, requestedAt: '3 November' })).toThrow(
            'Invalid recovery request.',
        );
        // Once the kit is replaced, the request for the old one is no longer one.
        await c.h.roster(cast.owner, c.all, undefined, undefined, {
            custodyVersion: 2,
            kitVersion: 2,
        });
        const later = await accept();
        await expect(verify(signed.statement, signed.signature, later)).rejects.toThrow(
            'Only someone who can use the recovery kit asks to use it.',
        );
        // And a family has no kit to ask for.
        expect(later.org).not.toBeNull();
    });
});

describe('the company key’s words, and a folder’s notice keys', () => {
    test('the fingerprint binds the company, the version and both public keys', async () => {
        const key = (await custodyAt(1)).publicKey;
        const words = await custodyWords(GROUP, 1, key);
        expect(words).toHaveLength(12);
        expect(await custodyFingerprint(GROUP, 1, key)).toMatch(/^([0-9a-f]{4} ){9}[0-9a-f]{4}$/);
        const others = [
            await custodyWords(OTHER_GROUP, 1, key),
            await custodyWords(GROUP, 2, key),
            await custodyWords(GROUP, 1, {
                ...key,
                kemPublicKey: (await custodyAt(2)).publicKey.kemPublicKey,
            }),
            await custodyWords(GROUP, 1, {
                ...key,
                encryptionPublicKey: (await custodyAt(2)).publicKey.encryptionPublicKey,
            }),
        ];
        for (const other of others) expect(other.join(' ')).not.toBe(words.join(' '));
        await expect(
            custodyFingerprint(GROUP, 1, { ...key, kemPublicKey: key.encryptionPublicKey }),
        ).rejects.toThrow('Invalid company key.');
    });

    test('everyone who holds the folder key derives the same notice keys, and nobody else does', async () => {
        const areaKey = areaKeyAt(AREA, 1);
        const seed = await noticeSeed(areaKey, GROUP, AREA);
        expect(seed).toHaveLength(96);
        expect(await noticeSeed(areaKey, GROUP, AREA)).toEqual(seed);
        const keys = await noticeKeys(seed);
        expect(decode(keys.publicKey.kemPublicKey)).toHaveLength(1184);
        for (const other of [
            await noticeSeed(areaKeyAt(AREA, 2), GROUP, AREA),
            await noticeSeed(areaKey, OTHER_GROUP, AREA),
            await noticeSeed(areaKey, GROUP, 'c0000001-8dfc-4914-8447-0417b55e2ec5'),
        ])
            expect((await noticeKeys(other)).publicKey).not.toEqual(keys.publicKey);
        await expect(noticeSeed(new Uint8Array(31), GROUP, AREA)).rejects.toThrow(CryptoError);
    });

    test('the previous notice seed opens under the new one, in its own context, and holds no folder key', async () => {
        const [before, after] = [
            await noticeSeed(areaKeyAt(AREA, 1), GROUP, AREA),
            await noticeSeed(areaKeyAt(AREA, 2), GROUP, AREA),
        ];
        const ctx = { groupId: GROUP, workspaceId: AREA, toVersion: 2, fromVersion: 1 };
        const wrapped = await wrapPreviousNoticeSeed(before, after, ctx);
        expect(wrapped).toHaveLength(PREVIOUS_NOTICE_SEED_BYTES);
        expect(PREVIOUS_NOTICE_SEED_BYTES).toBe(136);
        const opened = await openPreviousNoticeSeed(wrapped, after, ctx);
        expect(opened).toEqual(before);
        // What comes out is the notice seed, a one-way derivative: never the folder key itself.
        expect(encode(opened)).not.toContain(encode(areaKeyAt(AREA, 1)).slice(0, 20));
        // Under the old seed, another version pair, another folder or company, or with a byte moved.
        await expect(openPreviousNoticeSeed(wrapped, before, ctx)).rejects.toThrow(CryptoError);
        for (const over of [
            { toVersion: 3, fromVersion: 2 },
            { workspaceId: 'c0000001-8dfc-4914-8447-0417b55e2ec5' },
            { groupId: OTHER_GROUP },
        ])
            await expect(
                openPreviousNoticeSeed(wrapped, after, { ...ctx, ...over }),
            ).rejects.toThrow(CryptoError);
        await expect(
            openPreviousNoticeSeed(wrapped, after, { ...ctx, fromVersion: 2 }),
        ).rejects.toThrow('Invalid workspace key version.');
        const flipped = wrapped.slice();
        flipped[60]! ^= 1;
        await expect(openPreviousNoticeSeed(flipped, after, ctx)).rejects.toThrow(CryptoError);
        await expect(openPreviousNoticeSeed(wrapped.subarray(1), after, ctx)).rejects.toThrow(
            'Invalid notice seed.',
        );
    });
});

describe('the seals of a company’s life, as the shared fixtures carry them', () => {
    test('each opens, is unattributed, names its sealer, is refused or is made as declared', async () => {
        const { items, chainAt } = await companySeals();
        const said = new Map<string, unknown>();
        for (const item of items) {
            const verdict = await sealItemVerdict(item, chainAt);
            said.set(item.name, verdict);
            expect(verdict, item.name).toEqual(item.expected);
        }
        // What an opener is told when a seal's sealer has since moved to keys with no link to
        // the ones that signed it (an Owner who started over and was let back in): the seal
        // still opens to what the chain commits to, and is nobody's word any more.
        const before = said.get('folder-key-at-creation') as string;
        const after = said.get('folder-key-at-creation-after-the-sealers-keys-changed') as string;
        expect(before.startsWith('opened:')).toBe(true);
        expect(after).toBe(before.replace('opened:', 'unattributed:'));
        expect(said.get('previous-envelope-2-after-the-sealers-keys-changed')).toBe(
            (said.get('previous-envelope-2') as string).replace('opened:', 'unattributed:'),
        );
        // And blame for a bad one stops at the keys: nobody the list names now signed it.
        expect(said.get('kit-seal-of-junk-after-the-sealers-keys-changed')).toMatchObject({
            check: 'bad:',
        });
        // Signed under keys the entry did not name at the roster the seal names: no seal at all.
        for (const name of [
            'folder-key-signed-under-keys-the-entry-took-later',
            'folder-key-signed-under-keys-the-entry-had-left',
            'folder-key-resealed-before-joining',
            'folder-key-resealed-on-the-roster-that-took-the-role',
        ])
            expect(said.get(name), name).toBe('refused');
        // The sealing side refuses more than it makes, and makes what it should.
        const sealing = items.filter((item) => item.kind === 'sealing');
        expect(sealing.filter((item) => item.expected === 'sealed')).toHaveLength(3);
        expect(sealing.filter((item) => item.expected === 'refused').length).toBeGreaterThan(10);
    }, 120_000);
});

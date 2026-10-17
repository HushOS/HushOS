import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acceptRosters, type AcceptedRosters } from '../src/group-trust';
import type { SignedGroupStatement } from '../src/groups';
import { READER, mlDsaKeysOf, person, GROUP, type Person } from '../src/group-testkit';
import {
    openIdentityEncryptionKey,
    openIdentityKemKey,
    type IdentityEnvelope,
} from '../src/identity';
import { decode } from '../src/keys';
import type { GranteeSecrets } from '../src/shares';

/*
 * The fixture documents both twins share, read once per process from the
 * repository (crates/hushos-core/fuzz/src/fixtures.rs reads the same files):
 * the records the open targets start from and the histories the acceptance
 * target mutates. Read at run time rather than imported, so a Jazzer.js
 * bundle stays small and is not instrumented over 14 MB of JSON.
 */

/* Fixture documents are plain JSON; the targets read the fields they need. */
export type Json = any;

/* The repository root: HUSHOS_ROOT, or the first directory up from here that holds the fixtures. */
export function repository() {
    const fixture = join('packages', 'crypto', 'src', '__fixtures__', 'core.json');
    if (process.env.HUSHOS_ROOT) return process.env.HUSHOS_ROOT;
    for (let at = process.cwd(); ; at = dirname(at)) {
        if (existsSync(join(at, fixture))) return at;
        if (dirname(at) === at) throw new Error('Run from inside the HushOS repository.');
    }
}

const cached = new Map<string, Json>();
function read(relative: string): Json {
    if (!cached.has(relative))
        cached.set(relative, JSON.parse(readFileSync(join(repository(), relative), 'utf8')));
    return cached.get(relative);
}

/* packages/crypto/src/__fixtures__/core.json: records the Rust core sealed. */
export const core = () => read('packages/crypto/src/__fixtures__/core.json');
/* crates/hushos-core/fixtures/web.json: records this twin sealed. */
export const web = () => read('crates/hushos-core/fixtures/web.json');
/* packages/crypto/src/__fixtures__/core-groups.json: the group history, seals and cases. */
export const groups = () => read('packages/crypto/src/__fixtures__/core-groups.json');
/* crates/hushos-core/fixtures/web-groups.json: the same history as this twin signed it. */
export const webGroups = () => read('crates/hushos-core/fixtures/web-groups.json');

type Served = {
    statement: string;
    signature: { ed25519: string; mlDsa: string };
    signerSignature: string;
};
export const signed = (value: Served): SignedGroupStatement => ({
    statement: decode(value.statement),
    signature: { ed25519: decode(value.signature.ed25519), mlDsa: decode(value.signature.mlDsa) },
    signerSignature: decode(value.signerSignature),
});

function once<T>(make: () => Promise<T>) {
    let made: Promise<T> | undefined;
    return () => (made ??= make());
}

/* The four people of the group fixtures, from the shared seeds. */
export const people = once(
    async () => (await Promise.all([1, 2, 3, 4].map((n) => person(n)))) as Person[],
);

/* The fixture history, accepted as group-fixtures.test.ts accepts it. */
export const chain = once(async () => {
    const fixture = groups();
    const accepted = await acceptRosters({
        groupId: GROUP,
        firstKeys: {
            ed25519PublicKey: fixture.groupKeys[0].ed25519PublicKey,
            mlDsaPublicKey: fixture.groupKeys[0].mlDsaPublicKey,
        },
        rosters: fixture.rosters.map(signed),
        successions: fixture.successions.map(signed),
        ...READER,
        mlDsaKeys: mlDsaKeysOf(...(await people())),
    });
    if (accepted.status !== 'accepted') throw new Error('the fixture history forked');
    return accepted as AcceptedRosters;
});

/* The grantee of core.json's share: this twin's identity, opened under its account key. */
export const shareGrantee = once(async (): Promise<GranteeSecrets> => {
    const fixture = web();
    const root = decode(fixture.account.accountKey, 32);
    const identity = fixture.share.identity as IdentityEnvelope;
    const privateKey = await openIdentityEncryptionKey(root, fixture.account.userId, identity);
    const kem = await openIdentityKemKey(root, fixture.account.userId, identity);
    return { privateKey, kemSecretKey: kem!.secretKey };
});

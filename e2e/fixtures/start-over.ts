#!/usr/bin/env bun
/*
 * Gives an account brand-new keys in the database of the server under test,
 * with no succession from the old ones: what a server swapping someone's keys,
 * or an account started over without its old keys, looks like to everyone who
 * shares with them (docs/optional-verification.md 2.4). The keys statement is
 * genuine (signed by the new keys, over the account id), so only the missing
 * chain gives it away. The new private keys are thrown away: the account's own
 * devices can no longer open its identity, which the spec using this does not
 * need. Test databases only.
 *
 *   DATABASE_URL=<the server's database> bun e2e/fixtures/start-over.ts <email>
 */
import { SQL } from 'bun';
import { createIdentity } from '../../packages/crypto/src/identity';

const email = process.argv[2];
const url = process.env.DATABASE_URL;
if (!email || !url) throw new Error('Usage: DATABASE_URL=… bun e2e/fixtures/start-over.ts <email>');
if (decodeURIComponent(new URL(url).pathname.slice(1)) === 'hushos')
    throw new Error('Refusing to change keys in the hushos database.');

const sql = new SQL(url);
try {
    const [user] = await sql`
        select u.id, i.key_version
        from users u join account_identities i on i.user_id = u.id
        where u.normalized_email = ${email.toLowerCase()}`;
    if (!user) throw new Error(`No account with an identity for ${email}.`);
    const root = crypto.getRandomValues(new Uint8Array(32));
    const fresh = await createIdentity(root, user.id, user.key_version);
    const bytes = (value: string) => Buffer.from(value, 'base64url');
    await sql`
        update account_identities set
            version = 2,
            wrapping_salt = ${bytes(fresh.wrappingSalt)},
            encryption_public_key = ${bytes(fresh.encryptionPublicKey)},
            encryption_private_key_nonce = ${bytes(fresh.encryptionPrivateKeyNonce)},
            encrypted_encryption_private_key = ${bytes(fresh.encryptedEncryptionPrivateKey)},
            signing_public_key = ${bytes(fresh.signingPublicKey)},
            signing_seed_nonce = ${bytes(fresh.signingSeedNonce)},
            encrypted_signing_seed = ${bytes(fresh.encryptedSigningSeed)},
            kem_public_key = ${bytes(fresh.kem.publicKey)},
            kem_seed_nonce = ${bytes(fresh.kem.seedNonce)},
            encrypted_kem_seed = ${bytes(fresh.kem.encryptedSeed)},
            kem_signature = null,
            ml_dsa_public_key = ${bytes(fresh.mlDsa.publicKey)},
            ml_dsa_seed_nonce = ${bytes(fresh.mlDsa.seedNonce)},
            encrypted_ml_dsa_seed = ${bytes(fresh.mlDsa.encryptedSeed)},
            keys_signature = ${bytes(fresh.keysSignature)}
        where user_id = ${user.id}`;
    console.log(fresh.encryptionPublicKey);
} finally {
    await sql.close();
}

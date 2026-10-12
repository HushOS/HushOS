import { opaqueEnv } from '@hushos/env/opaque';
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';

/*
 * The key every server-side hash of an address, an email or an account id is
 * made under: rate-limit buckets and an anonymous reporter's address. Keyed,
 * because a plain hash of a guessable value is no protection: the 2^32 IPv4
 * addresses, or a list of emails, are checked against a dump in seconds. The
 * key is never in the database. With OPAQUE_SERVER_SETUP in the environment it
 * is derived from that, so every process and every restart agree; without it,
 * it is made at random for this process alone, and rate limits and the check
 * for an anonymous reporter's duplicate report then count per process and
 * start over when it restarts.
 */
const INFO = 'hushos/server/hash-key/v1';

let key: Buffer | undefined;
export function serverHashKey() {
    key ??= opaqueEnv.OPAQUE_SERVER_SETUP
        ? Buffer.from(
              hkdfSync(
                  'sha256',
                  Buffer.from(opaqueEnv.OPAQUE_SERVER_SETUP, 'base64url'),
                  Buffer.alloc(0),
                  INFO,
                  32,
              ),
          )
        : randomBytes(32);
    return key;
}

/* HMAC-SHA-256 under the server hash key. */
export function keyedHash(value: string | Buffer) {
    return createHmac('sha256', serverHashKey()).update(value).digest();
}

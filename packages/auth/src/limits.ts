/*
 * What a security change may send. A master-key rotation carries the current
 * identity and every earlier one, re-wrapped; each version 2 envelope is about
 * 9.6 KB of JSON, since it holds ML-DSA and ML-KEM public keys and a 3373-byte
 * keys statement. Everything else in the body (envelope, recovery, settings
 * key, up to 200 workspace keys) comes to under 75 KB.
 */
export const SECURITY_CHANGE_IDENTITY_BYTES = 12 * 1024;
export const SECURITY_CHANGE_REST_BYTES = 256 * 1024;

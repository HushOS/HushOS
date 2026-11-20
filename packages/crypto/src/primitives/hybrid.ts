/*
 * The body key of a hybrid envelope: the X25519 agreement and the ML-KEM
 * shared secret through HKDF-SHA-256, salted with the KEM ciphertext, so the
 * envelope opens only for someone who holds both private halves and stays
 * shut unless both problems fall. `info` names the envelope kind.
 */
export async function hybridKey(
    pair: Uint8Array<ArrayBuffer>,
    kemSecret: Uint8Array<ArrayBuffer>,
    kemCiphertext: Uint8Array,
    info: string,
) {
    return hybridKeyWithSalt(pair, kemSecret, kemCiphertext.slice(), info);
}

/* The same derivation with a salt of the caller's choosing (share suite 3 salts with a digest). */
export async function hybridKeyWithSalt(
    pair: Uint8Array,
    kemSecret: Uint8Array,
    salt: Uint8Array<ArrayBuffer>,
    info: string,
) {
    const material = new Uint8Array(pair.length + kemSecret.length);
    material.set(pair);
    material.set(kemSecret, pair.length);
    try {
        const key = await crypto.subtle.importKey('raw', material, 'HKDF', false, ['deriveBits']);
        return new Uint8Array(
            await crypto.subtle.deriveBits(
                {
                    name: 'HKDF',
                    hash: 'SHA-256',
                    salt,
                    info: new TextEncoder().encode(info),
                },
                key,
                256,
            ),
        ) as Uint8Array<ArrayBuffer>;
    } finally {
        material.fill(0);
    }
}

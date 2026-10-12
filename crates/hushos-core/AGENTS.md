# hushos-core

The client side of the HushOS protocol in Rust, shared by every app that is not the web: OPAQUE, the account key and its device memory, workspace grants, Drive node, metadata and version envelopes, content chunks and thumbnails. `packages/crypto` is the TypeScript twin the web runs; the two must seal and open each other's records byte for byte. The repository's root `AGENTS.md` applies here too.

## Rules

- `#![forbid(unsafe_code)]`. The C ABI that once lived here is gone; Swift and Kotlin come from UniFFI (`#[uniffi::export]`, `derive(uniffi::Record)`) behind the `uniffi` feature, which is on by default and off for a WebAssembly build.
- No I/O. The crate seals and opens; the apps fetch and store. Keep it that way so the same crate serves the iOS app, the File Provider extension, the Android app and the DocumentsProvider without a runtime.
- The HushOS OPAQUE profile (server identifier, argon2id parameters) is built in. Do not add parameters for another profile.
- Every context string is the compact JSON array the web builds with `JSON.stringify`. When the web changes a context, this crate changes with it, and the fixtures below catch the drift.
- Doc comments carry a runnable example for anything an app calls; unit tests sit in the same file. A test must fail on a real defect (a flipped byte, a wrong context, a wrong length), never assert what the code trivially does.

## Fixtures, both directions

`bun run fixtures` at the root regenerates both files:

- `fixtures/web.json`, sealed by `packages/crypto/scripts/core-fixtures.ts`, opened by `tests/web_fixtures.rs`.
- `packages/crypto/src/__fixtures__/core.json`, sealed by `examples/fixtures.rs`, opened by `packages/crypto/src/core-fixtures.test.ts`.

Run `bun run core:check` (fmt, clippy with warnings denied, tests) before declaring a change done.

## Bindings

- Apple: `bun run core:apple` builds device and simulator slices, generates Swift, and assembles `apps/ios/Packages/HushOSCore` (xcframework and generated source are not committed).
- Android: `bun run core:android` builds arm64-v8a and x86_64 with cargo-ndk and generates Kotlin into `apps/android/core`.
- On this Mac cargo's index fetch stalls unless `CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_SSL_VERSION=tlsv1.2` are set; the scripts set them.

## Added on 2026-09-22 (evening)

- `identity.rs` also rewraps the identity for a master-key rotation; `shares.rs` seals as well as opens (suite 2 when the grantee's ML-KEM key is given); `links.rs` (argon2id + BLAKE2b link keys, the owner's sealed copy, `link_url`/`link_parse`); `reports.rs` (libsodium sealed box by hand over XSalsa20-Poly1305 for suite 1, hybrid suite 2, `kem_binding_verify`); `recovery.rs` (BIP-39 English list embedded from `bip39-english.txt`, `recovery_create/open/phrase`); `contacts.rs` (fingerprint, key digest, the settings document under HKDF of the identity's X25519 private key). `drive.rs` gained `workspace_grant_rewrap`.
- Every one of these has a fixture in both directions; `bun run fixtures` then `cargo test -p hushos-core` and `bun run --cwd packages/crypto test src/core-fixtures.test.ts` prove the web opens what the core sealed and vice versa (sealed box, argon2id, BIP-39, settings, shares, rewraps).
- `crypto_secretbox` is used only through `encrypt_in_place_detached`, so the tag is placed first by hand as libsodium does; do not switch to `encrypt`, whose tag position is the crate's choice.

## Added on 2026-10-12 (integrity)

- Content suite 3 (`drive.rs`): `content_layout`, `chunk_range` and `thumbnail_range` take the suite; `chunk_encrypt` takes the file's bytes for the index and pads, `chunk_decrypt` returns the file's bytes only; `padded_length` is Padmé; `version_seal` writes suite 3 (`content_suite()`).
- `signatures.rs`: metadata and version statements, sign with `IdentityKeys::signing_seed`, `*_verify` and `*_integrity` (`Integrity`). The statement bytes are pinned against the server's builder in `packages/db/src/signatures.ts`.
- `shares.rs` seals suite 3 only (`share_seal` takes the granter's `IdentityKeys`); `share_open` takes a `ShareGranter` (signing key for suite 3, X25519 for 1 and 2).
- `identity.rs`: `identity_create`, `identity_succeed`, `succession_verify`, `succession_chain_verify` (continuity by keys, not version numbers); `identity_rewrap` keeps the identity's key version.
- `contacts.rs`: settings key (`settings_key_create/open/rewrap`), settings envelope version 2 (`settings_seal(user_id, settings_key, …)`); `settings_open` reads 1 and 2.

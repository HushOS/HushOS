# hushos-core

The client side of the HushOS protocol in Rust. Every app that is not the web uses it.

- It covers OPAQUE, the account key and its device memory, workspace grants, Drive node, metadata and version envelopes, content chunks and thumbnails, identities, shares, links, reports and families.
- `packages/crypto` is the TypeScript twin the web runs. The two must seal and open each other's records byte for byte.
- The repository's root `AGENTS.md` applies here too.

## Rules

- `#![forbid(unsafe_code)]`.
- Swift and Kotlin come from UniFFI (`#[uniffi::export]`, `derive(uniffi::Record)`) behind the `uniffi` feature.
    - The feature is on by default and off for a WebAssembly build.
    - The C ABI that once lived here is gone.
- No I/O. The crate seals and opens; the apps fetch and store.
    - Keep it that way, so the same crate serves the iOS app, the File Provider extension, the Android app and the DocumentsProvider without a runtime.
- The HushOS OPAQUE profile (server identifier, argon2id parameters) is built in. Do not add parameters for another profile.
- Every context string is the compact JSON array the web builds with `JSON.stringify`.
    - When the web changes a context, this crate changes with it.
    - The fixtures catch the drift.
- Doc comments carry a runnable example for anything an app calls.
- Unit tests sit in the same file.
- A test must fail on a real defect (a flipped byte, a wrong context, a wrong length). Never assert what the code trivially does.
- No exported parameter may be named after a C keyword (`signed`, `char`, `default`…).
    - The Swift bindings go through a C header, and `ios:build` fails on it.
- Do not move the ML-DSA library (`ml-dsa`) or its TypeScript twin without the ACVP vectors (see [Identity](#identity-identityrs-pqrs)).

## Commands

Run these from the repository root.

| Command                                                                        | What it does                                                                                                                                 |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run core:check`                                                           | fmt, clippy with warnings denied, tests. Also lints the `fuzzing` feature and formats and lints `fuzz/`. Run before declaring a change done. |
| `bun run fixtures`                                                             | Regenerates `fixtures/web.json` and `packages/crypto/src/__fixtures__/core.json`.                                                            |
| `bun run fixtures:groups`                                                      | Rebuilds the group fixtures and the area-ledger fixtures.                                                                                    |
| `cargo test -p hushos-core`                                                    | The crate's tests, fixtures from the web included.                                                                                           |
| `bun run --cwd packages/crypto test src/core-fixtures.test.ts`                 | The web opening what the core sealed.                                                                                                        |
| `bun run core:apple`                                                           | Builds device and simulator slices, generates Swift, and assembles `apps/ios/Packages/HushOSCore`.                                           |
| `bun run core:android`                                                         | Builds arm64-v8a and x86_64 with cargo-ndk and generates Kotlin into `apps/android/core`.                                                    |
| `bun run fuzz:diff`                                                            | Holds the Rust and TypeScript fuzz verdicts to each other through `fuzz/examples/verdicts.rs`.                                               |
| `cargo test --manifest-path crates/hushos-core/fuzz/Cargo.toml --lib --locked` | The fuzz crate's lib tests. CI's Rust core job runs this on stable, from the root.                                                           |

- The xcframework and the generated Swift source are not committed.
- On this Mac, cargo's index fetch stalls unless `CARGO_HTTP_MULTIPLEXING=false CARGO_HTTP_SSL_VERSION=tlsv1.2` are set. The scripts set them.
- Fuzzing is run and triaged as CONTRIBUTING.md (Fuzzing) says.

## Fixtures

Every module with a TypeScript twin is held to it by fixtures in both directions.

- The web seals a `fixtures/web*.json`, and a Rust test opens it.
- An `examples/*.rs` seals a `packages/crypto/src/__fixtures__/core*.json`, and a TypeScript test opens it.
- Hand-written scenario files in `fixtures/` carry stated outcomes. Both twins run them through a shared testkit.
- Each twin must reproduce the other's full verdict, not only pass or fail.

| Area         | Web to core                                                                                                                                          | Core to web                                                                                                                                                                         | Shared                                                                                                                                                                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Base         | `fixtures/web.json`, sealed by `packages/crypto/scripts/core-fixtures.ts`, opened by `tests/web_fixtures.rs`                                         | `packages/crypto/src/__fixtures__/core.json`, sealed by `examples/fixtures.rs`, opened by `packages/crypto/src/core-fixtures.test.ts`                                               | `tests/common/rekeyed.rs`, `packages/crypto/src/rekeyed-testkit.ts`                                                                                                                                                                                                                                                |
| Groups       | `fixtures/web-groups.json`, from `packages/crypto/scripts/group-fixtures.ts`, read by `tests/web_group_fixtures.rs`                                  | `packages/crypto/src/__fixtures__/core-groups.json`, from `examples/group_fixtures.rs`, read by `packages/crypto/src/group-fixtures.test.ts`                                        | `tests/common/groups.rs`, `group-testkit.ts`                                                                                                                                                                                                                                                                       |
| Area ledger  | `fixtures/web-area-ledger.json`, from `packages/crypto/scripts/area-ledger-fixtures.ts`, read by `tests/area_ledger_fixtures.rs`                     | `packages/crypto/src/__fixtures__/core-area-ledger.json`, from `examples/area_ledger_fixtures.rs`, read by `packages/crypto/src/area-ledger-fixtures.test.ts`                       | `fixtures/area-ledger-scenarios.json`, `fixtures/merge-pin-cases.json`, `tests/common/area_ledger.rs`, `packages/crypto/src/area-ledger-testkit.ts`, `tests/common/rotations.rs`, `packages/crypto/src/rotation-testkit.ts`, `tests/common/device_records.rs`, `packages/crypto/src/device-record-testkit.ts`      |
| Joining      | `fixtures/web-join.json`, from `packages/crypto/scripts/join-fixtures.ts`, read by `tests/join_fixtures.rs`                                          | `packages/crypto/src/__fixtures__/core-join.json`, from `examples/join_fixtures.rs`, read by `join-fixtures.test.ts` and (for consent) `packages/db/src/auth.consent.test.ts`       | `fixtures/join-check-cases.json`, `fixtures/join-session-scenarios.json`, `tests/common/join.rs`, `join-testkit.ts`                                                                                                                                                                                                |
| Roster calls | `fixtures/web-roster-calls.json`, from `packages/crypto/scripts/roster-call-fixtures.ts`, read by `tests/roster_call_fixtures.rs`                    | `packages/crypto/src/__fixtures__/core-roster-calls.json`, from `examples/roster_call_fixtures.rs`, read by `roster-call-fixtures.test.ts` and `packages/groups/src/server.test.ts` | `fixtures/outbox-steps.json`, `fixtures/roster-call-sessions.json`, `fixtures/settings-area-cases.json`, `tests/common/roster_calls.rs`, `roster-calls-testkit.ts`, `tests/common/removal_calls.rs`, `removal-calls-testkit.ts`, `tests/common/settings_areas.rs`, `packages/crypto/src/settings-areas-testkit.ts` |
| Pins         | `fixtures/pin-cases.json` (hand-stated outcomes, written by `packages/crypto/scripts/pin-cases.ts`)                                                  | Read by `tests/pin_cases.rs` and `packages/drive/src/pin-cases.test.ts`                                                                                                             | Chain cases are unit tests in each twin: `first_seen/tests.rs`, `packages/crypto/src/first-seen.test.ts`                                                                                                                                                                                                           |
| ML-DSA       | `fixtures/ml-dsa-65-acvp.json`, a subset of NIST's ACVP-Server vectors (commit and file hashes inside)                                               | Passed by `pq.rs`'s tests and `packages/crypto/src/ml-dsa-acvp.test.ts`                                                                                                             |                                                                                                                                                                                                                                                                                                                    |
| Old apps     | `fixtures/v0.10.0/planted-join.json`, made by the core at the tag `v0.10.0` with `fixtures/v0.10.0/planted_join.rs` (how to run it is in its header) | Read by `tests/planted_join.rs` and `packages/crypto/src/planted-join.test.ts`                                                                                                      |                                                                                                                                                                                                                                                                                                                    |

- The base files cover the sealed box, argon2id, BIP-39, settings, shares, rewraps, `ids`, `rekeyed`, `node.attributed`, the area self-grant, the device session proof and the recovery phrase's answer to a second step (`twoStepPhrase`).
- `bun run fixtures:groups` rebuilds the group and area-ledger files.
- The case lists for each area are under that area below.

## Module map

| Module                    | Twin in TypeScript                                                                                                  | Holds                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `bytes.rs`                |                                                                                                                     | `SecretBytes`, encoding helpers                                              |
| `envelope.rs`             |                                                                                                                     | Contexts, seals, the re-keying primitives                                    |
| `ids.rs`                  |                                                                                                                     | Scoped ids                                                                   |
| `drive.rs`                | `packages/crypto/src/drive.ts`                                                                                      | Node, metadata and version envelopes, content suites, node keys, origin keys |
| `identity.rs`             |                                                                                                                     | Identity envelopes, upgrades, successions                                    |
| `pq.rs`                   |                                                                                                                     | ML-DSA-65                                                                    |
| `signatures.rs`           | `packages/db/src/signatures.ts` (statement bytes)                                                                   | Hybrid signatures, record statements and integrity verdicts                  |
| `shares.rs`               |                                                                                                                     | Share suite 4, `seal_hybrid`/`open_hybrid`                                   |
| `links.rs`                |                                                                                                                     | Link keys                                                                    |
| `reports.rs`              | `packages/crypto/src/reports.ts`                                                                                    | Report seals, `pair_key`                                                     |
| `recovery.rs`             |                                                                                                                     | Recovery phrases                                                             |
| `two_step.rs`             | `packages/crypto/src/two-step.ts`, `packages/auth/src/login-reply.ts`                                               | The phrase's answer to a second step, reading a sign-in's reply, passkeys    |
| `device_approval.rs`      | `packages/crypto/src/device-approval.ts`, `packages/auth/src/device-step.ts`                                        | Approving on another device: the commitment, the code, the statement         |
| `contacts.rs`             | `packages/crypto/src/contacts.ts`                                                                                   | Fingerprints, key digests, pins, the settings document                       |
| `first_seen.rs`           | `packages/drive` (`comparePin`), `packages/crypto/src/first-seen.test.ts`                                           | First-seen pins and the guard's rule                                         |
| `canonical.rs`            |                                                                                                                     | The group statement grammar                                                  |
| `groups.rs`               |                                                                                                                     | Group keys, rosters, area rows, group seals                                  |
| `group_trust.rs`          |                                                                                                                     | Accepting a roster chain, writer trust, group verdicts                       |
| `succession_path.rs`      | `packages/crypto/src/succession-path.ts`                                                                            | The group core's walk along a member's links (crate-private)                 |
| `area_ledger.rs`          | `packages/crypto/src/area-ledger.ts` (the worker's Drive key store and family write rules)                          | `AreaLedger`, one per unlocked session                                       |
| `rotation_records.rs`     | `rekeyRecord`/`rekeyNode` in `packages/crypto/src/rotation-records.ts`                                              | Re-keyed walks                                                               |
| `group_verdicts.rs`       | `recordVerdicts`/`judgeWith` in `packages/crypto/src/group-verdicts.ts`                                             | Record verdicts in family folders                                            |
| `device_record.rs`        | The worker's device store and `accept` (`session-groups.ts`), `record-acceptance.ts`, `packages/crypto/src/pins.ts` | The chain record, the floor, the guard                                       |
| `join.rs`                 | The worker's join (`session-groups.ts`), `packages/crypto/src/join-session.ts`                                      | Joining a family, pair codes, first use                                      |
| `consent.rs`              | `consent-due.ts`, the worker's `identityConsent`                                                                    | Successor consent                                                            |
| `roster_calls.rs`         | The worker's `groupStage`, `groupOpenSeal`, `groupGrants`, `groupJoinCode`; `packages/crypto/src/outbox.ts`         | Staged roster calls and the outbox                                           |
| `roster_calls/removal.rs` | `groupStage` kinds `remove`, `markLeft`, `rotate`, `retire`; `groupRestage`; `groupPreviousRoot`                    | Calls that rotate folders                                                    |
| `ledger_settings.rs`      | `settingsOpenFor` in `packages/crypto/src/settings-marks.ts`                                                        | Settings and family checks in the ledger                                     |
| `area_open.rs`            | The worker's `groupOpenArea`, `grantAreaKey`/`openAreaSelfGrant`, `rewrapAreaSelfGrant`                             | Opening a family folder, self-grants                                         |

## Primitives

### Secrets in memory

- `SecretBytes` (`bytes.rs`) wipes itself on drop and crosses UniFFI as bytes.
- These hold their secrets in it: `IdentityKeys`, `ContentKey`, `Content`, `CreatedSettingsKey`, `LinkSecret`, `DeviceMemory`, `LoginStart`/`LoginFinish`/`RegistrationStart`/`RegistrationFinish`.
- Records cannot implement `Drop`, because UniFFI moves fields out. So the field type does the wiping.

### Secretbox

- `crypto_secretbox` is used only through `encrypt_in_place_detached`.
- The tag is placed first by hand, as libsodium does.
- Do not switch to `encrypt`: its tag position is the crate's choice.

### Re-keying primitives (`envelope.rs`)

- `rekey`: a raw re-seal, never parsed.
- `opening_key`: HChaCha20 of the key and the nonce's first 16 bytes.
    - It comes from `chacha20` 0.9's `hchacha`. This is the only use of that crate.
- `open_with_opening_key`: ChaCha20-Poly1305 IETF with `0⁴ ‖ nonce[16..24]`.

### Scoped ids (`ids.rs`)

- `derive_id(kind: IdKind, scope_id, seed) -> String`.
- `new_id(kind, scope_id) -> NewId { id, seed }`.
- The seed is base64url (16 bytes) both ways, as the API carries it: `idSeed`, `versionIdSeed`, `objectIdSeed`, `linkIdSeed`, `reportIdSeed`.
- The scope is the workspace the item is created in. For a report, it is the reported item's.
- `IdKind::Group` is scoped to the creating account.
- `IdKind::Workspace` is an area, scoped to its group.
- `check_id` checks an id against its scope and seed.
- Known answers in the unit tests come from a third implementation.
- `ids` in both fixture files pins the twins to each other.

## Drive records (`drive.rs`)

### Content suite 3

- `content_layout`, `chunk_range` and `thumbnail_range` take the suite.
- `chunk_encrypt` takes the file's bytes for the index and pads.
- `chunk_decrypt` returns the file's bytes only.
- `padded_length` is Padmé.
- `version_seal` writes suite 3 (`content_suite()`).

### Contexts

- `metadata_context`, `version_context` and `origin_key_context` validate as `drive.ts` does, and return `CoreResult`.
    - Lowercase UUIDs.
    - Epochs and versions 1..2^53−1.
    - A readable suite.
- `metadata_seal`/`open` and `version_*` refuse such fields with `Input`.

### Node keys

- `node_wrap`/`node_open` keep their unchecked context for the shipped apps.
- `node_wrap_checked` and `node_open_checked` are the crate-private checked node-key context.
    - Lowercase UUIDs and epochs 1..2^53−1, as the web refuses them.
- `previous_root_key_wrap`/`previous_root_key_open`: option A's `hushos/drive/previous-root-key`, for the root only.
- `workspace_grant_rewrap` rewraps a workspace grant for a master-key rotation. It refuses a family self-grant (see [Self-grants in a master-key rotation](#self-grants-in-a-master-key-rotation)).
- In a family folder, apps never use `node_wrap`, `node_open` or `previous_root_key_open` for writes. See [The area ledger](#the-area-ledger-area_ledgerrs).

### Re-keyed records

- Design: docs/integrity-design.md, "Re-keyed records".
- `metadata_rekey` and `version_rekey` re-key a record raw.
- `origin_opening_key` gives the origin's opening key.
- `origin_key_wrap`/`origin_key_open` work under `["hushos/drive/origin-key", 1, ws, node, "metadata"|"version", metadataVersion|versionId, keyEpoch, sha256(origin)]`.
    - Types: `OriginKeyContext`, `OriginRecord`.
- The statements and verdicts are in [Signatures](#signatures-and-integrity-signaturesrs).

### Node attributes

- `NodeMetadata.attributes: HashMap<String, String>`.
    - `[String: String]` in Swift, `Map<String, String>` in Kotlin.
    - No default: every construction says what it carries.
- Keys match `^[a-z][a-z0-9_-]{0,31}$`. At most 32 keys.
- The whole plaintext stays within 4096 bytes.
- `metadata_seal` refuses a bad record (`Input`). `metadata_open` refuses one (`Sealed`). Neither trims.
- Empty is written as no field (`skip_serializing_if`).
- Keys are sorted (`sorted_attributes`), so the plaintext is the web's byte for byte.
- `Debug` prints the keys only.
- A client re-sealing a record builds it from the opened one.
- `metadata_rekey` keeps the attributes untouched.
- Fixtures: `node.attributed` in both files. Its `plaintext` is compared with what the other twin writes.

## Identity (`identity.rs`, `pq.rs`)

Design: docs/identity-pq-design.md.

### ML-DSA-65 (`pq.rs`)

- From `ml-dsa = "=0.1.1"`: pure FIPS 204.
- Keys come from the 32-byte ξ.
- Signing is hedged, through `sign_internal` over `0 || len(ctx) || ctx || M`.
- `fixtures/ml-dsa-65-acvp.json` is a subset of NIST's ACVP-Server vectors (commit and file hashes inside).
    - `pq.rs`'s tests and `packages/crypto/src/ml-dsa-acvp.test.ts` both pass it.
    - Do not move either library without them.

### Identity envelopes

- Envelopes are version 2 (`ml_dsa`, `keys_signature`).
- `IdentityKem.signature` is version 1 only.
- `identity_create` writes version 2.
- `identity_upgrade` keeps a version 1 identity's keys and key version, and adds ML-DSA (and ML-KEM if missing).
- `identity_open` refuses a version 2 identity whose keys statement does not hold.
- `identity_rewrap` rewraps the identity for a master-key rotation. It keeps the identity's key version.
- `PinnedKeys` carries `ml_dsa_public_key_hash`.

### Successions

- `identity_succeed` needs version 2 and signs hybrid.
    - It also co-signs the successor consent and returns it as `IdentitySuccession.consent`.
- `succession_verify(user, link, signer)` verifies under the keys the reader trusts, never the link's.
- `succession_chain_verify` (`identity::succession_chain_verify`) checks continuity by keys, not version numbers.
    - It is the shipped strict verifier. Personal pins, Drive, iOS and Android rely on its contiguous-in-served-order chain.
    - Never route group logic through it or change it for groups. Groups use `succession_path` (see [Succession paths](#succession-paths-succession_pathrs)).
- `succession_verify` and `succession_chain_verify` ignore `consent` and never read the walk's cache.

### Successor consent

- `SuccessionLink.consent` is optional (uniffi default `None`).
- It is two hybrid signatures:
    - The old identity's over `["hushos/identity/succession-consent",1,"old",…]`.
    - Then the new one's over the same with `"new"`.
    - Built by `signatures::succession_consent_statement(user_id, link, ConsentRole)`.
- `SUCCESSION_CONSENT_BYTES` = 6746.
- `succession_consent_verify` checks each half under the keys the link names, in its role.
- The server and apps do not store or upload `consent` yet. That comes with groups 1c, with a backfill of earlier links. Until then only pre-entry history is affected.
- Signing consent for an app is `AreaLedger::succession_consent_sign` (see [Successor consent signing](#successor-consent-signing-consentrs)).

## Signatures and integrity (`signatures.rs`)

### Hybrid signatures

- `hybrid_sign`/`hybrid_verify`: Ed25519 (64 bytes) || ML-DSA-65 (3309 bytes).
- Context `hushos/identity/v1`.
- Both halves are required. A signature is never chosen by length.
- `keys_statement` and `succession_statement` (version 2).
- Identity key versions are bounded to 1..2^53−1.
- `check_envelope` mirrors the web: key version 1..2^53−1, non-empty keys signature.

### Record statements

- Metadata and version statements are signed with `IdentityKeys::signing_seed`.
- The statement bytes are pinned against the server's builder in `packages/db/src/signatures.ts`.
- Record statements refuse empty ids and metadata versions above 2^53−1.
- There are four forms:

| Form      | Sign and verify                                                  | Domain                                                          | Used for                                                      |
| --------- | ---------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| Ordinary  | `*_sign`, `*_verify`, `*_integrity`                              |                                                                 | A record its writer sealed                                    |
| Re-sealed | `metadata_resealed_sign/verify`, `version_resealed_sign/verify`  | `hushos/drive/sig/{metadata,version}-resealed`                  | Renames, copies and rotations of a record that did not verify |
| Saved     | `metadata_saved_sign/verify`, `version_saved_sign/verify`        | `hushos/drive/sig/{metadata,version}-saved`, ending in `"link"` | A copy saved from a link                                      |
| Re-keyed  | `metadata_rekeyed_statement`, `*_rekey_sign`, `*_rekeyed_verify` |                                                                 | A record re-keyed in a walk, carrying its origin              |

### Integrity verdicts

- `*_integrity` return `Integrity`.
- They take `Option<TrustedKeys>`.
    - `current` verifies.
    - `retired` only ever gives `RetiredKey`.
    - `TrustedKeys { seen: true }` (default false over UniFFI) gives `Seen` when the signature holds.
- The order of checks: ordinary, then saved (`Integrity::SavedFromLink`), then re-sealed.
- Variants beyond `Verified`:
    - `Resealed`.
    - `SavedFromLink`.
    - `RetiredKey`.
    - `Seen`.
    - `Unchecked`: never returned by the ordinary checks; apps use it when a check cannot run.
- `group_integrity` returns `Unsigned` before consulting any trust.
- Both apps handle `Seen` themselves, as unmarked (Android `Integrity.kt`, iOS `Integrity.swift`).

### Signing a changed record

- `metadata_reseal_sign`/`version_reseal_sign` (rotation, rename):
    - Sign ordinary only when the prior verdict is `Verified` (or `Seen`, treated as `Verified`).
    - Keep `SavedFromLink` as saved.
    - Re-seal anything else that did not verify.
    - Refuse `Unchecked`.
    - `*_reseal_sign` is still used for renames, copies, and rotations until the apps move.
- `metadata_copy_sign`/`version_copy_sign(seed, prior, from_link, …)` sign a copy by its source:
    - `from_link`: saved, whatever `prior`.
    - Otherwise as a reseal.
- `*_compat_sign(seed, prior, own_record, …)` is the honest legacy form. It never refuses.

### Re-keyed verdicts

- `metadata_rekeyed_integrity`/`version_rekeyed_integrity(node_key, trust, record) -> RekeyedVerdict { origin, rekeyer, bound: Option<bool> }`.
- `RecordOrigin` carries the wrapped key. The statement covers its digest.
- A `None` node key or trust is `Unchecked`: the core does return it here.
- `bound`:
    - `Some(false)` only for bytes that differ, or a wrap or origin that fails under a verified re-key signature.
    - `None` for whatever a server alone could cause.
    - A missing or bad re-key signature never sets it.
- A `Seen` re-keyer attests.
- `*_origin_carry(old_key, new_key, target_epoch, record) -> CoreResult<Option<Vec<u8>>>` is the next rotation's bound check before re-wrapping.
    - `None` means: drop the origin and sign legacy re-sealed.
    - An error stops the rotation. It comes from a malformed new key or epoch, refused served ids, or a current envelope that `old_key` does not open.
- Fixtures: `rekeyed` in both base files.
    - `tests/common/rekeyed.rs` and `packages/crypto/src/rekeyed-testkit.ts` read the same JSON.
    - They build the same 50 cases, each with whether the next rotation carries its origin, with the same declared verdicts.
    - Each generator checks its own verdicts before writing.

## Shares, links, reports and recovery

### Shares (`shares.rs`)

- Suite 4 only (4565 bytes). Suite 3 is refused.
- `share_seal` takes the granter's `IdentityKeys`.
- `share_open(envelope, HybridPublicKey, grantee, ctx)`.
- `seal_hybrid`/`open_hybrid` are the suite 4 construction, with the payload, `info`, associated data and statement as parameters.
    - Shares and the group seals all go through them. Do not fork it.
    - `open_hybrid` takes a slice of signers.

### Links (`links.rs`)

- argon2id + BLAKE2b link keys.
- The owner's sealed copy.
- `link_url`/`link_parse`.

### Reports (`reports.rs`)

- Suite 1: a libsodium sealed box, done by hand over XSalsa20-Poly1305.
- Suite 2: hybrid.
- `pair_key` lives here, its only user.
- `OperatorKeys` carries `ml_dsa_public_key`, `kem_public_key`, `keys_signature`.
- `report_seal_key`:
    - Checks a version 2 operator's keys statement.
    - Seals a version 1 operator to the served KEM key unchecked. Nobody pins operator keys.
    - Refuses only an operator with no KEM key.
- The old KEM binding (`kem_binding_verify`, `OperatorKem`) is gone.

### Recovery (`recovery.rs`)

- The BIP-39 English list is embedded from `bip39-english.txt`.
- `recovery_create/open/phrase`.

### Two-step sign-in (`two_step.rs`)

`docs/two-step-design.md` 3 to 6 and 12. Codes are checked on the server; nothing here makes or checks one, and a passkey's ceremony is the platform's: this crate only moves its fields.

- `two_step_phrase_statement(user_id, token_digest)` is `["hushos/two-step/phrase",1,userId,sha256(stepToken)]`, the id lowercased, the digest base64url (`step_token_digest`).
- `two_step_phrase_sign(phrase, wrapping_salt, user_id, step_token)` derives the recovery signing key (`recovery_signing_seed`, the same HKDF a phrase reset uses) and signs. It compares nothing with an envelope: the server's check says whether the phrase is the account's.
- `sign_in_reply_read(status, body) -> StepReply` decides what `login/finish` or `login/two-step` answered, from the reply alone:
    - `Done` only for a whole session (the account, its envelope, its device);
    - `Step` for `twoStep` with a token, a list and an end, and no `user` beside it;
    - `Refused { refusal, message }` for a refusal in the server's words, by its `code` (`step-unavailable` is `Unavailable`; a 429 without a code is `Busy`, the address's own limit);
    - `Lost` for anything else, a 5xx without `step-unavailable` included. Never a sign-in, never a refusal.
- `step_challenge_reply_read` and `step_change_reply_read` read `two-step/challenge` and the changes that carry a step.
- A challenge's `methods` are in the server's order (the account's usual way first). A method this build does not know is left out; so is the phrase without what it signs with, and a key without its challenge and a key to ask. `default_unavailable` is true when the server said so, or when what it listed first was left out here; `withheld` is the server's word that it left out a kind this build did not name.
- `step_answer_json(token, proof)` writes the body both phones send. A key's proof is its assertion, cut down to what the server checks.
- Passkeys and security keys:
    - `key_request_json(StepKeyRequest)` and `key_creation_json(KeyCreation)` are what a platform's sheet is asked (WebAuthn's JSON option forms; Android's Credential Manager takes them as they are, iOS reads the same fields). No attestation, resident key or user verification is ever asked, whatever a reply said.
    - `key_assertion_read` and `key_registration_read` take the JSON a platform hands back and keep only what the server checks.
    - `key_options_reply_read`, `key_registration_json` and `key_added_reply_read` are the two routes that add a key. Only the server's own answer says a key was added.
    - `step_methods_named(passkeys)` is what the app sends as `twoStepMethods`; `step_methods_shown()` is what it asks settings to list; `step_methods_advertised(body)` reads `login/start`'s word that the server takes the field, and `step_methods_refused(status)` says when to ask once more without it (422, or this server's 400).
    - `fixtures/two-step-keys.json` is hand-stated and read by `tests/two_step_keys.rs` and by the web (`apps/web/src/lib/api/two-step-keys-fixture.test.ts`), which sends its replies through the server's response schemas and its requests through the routes' body schemas: a phone and a browser ask a key the same thing and send the same answer.
- `backup_code_normalize` reads a typed code as the server does.
- Approving on another device (`device_approval.rs`, `docs/two-step-design.md` 12):
    - `device_step_commitment`, `device_step_code` and `device_step_statement` build the three values exactly as section 12 writes them; `device_step_sign` signs the statement with the device key's seed.
    - `approval_code_expected` is what an approving phone calls: it gives the code only when what was revealed is the commitment the phone saw first, and errors otherwise (the app then ends the request as `mismatch`).
    - `approval_qr` and `approval_qr_read` are the QR text; `approval_code_normalize` and `approval_words` read a typed code and complete its word; `approval_prompts_allowed` is the phone's own five-a-day limit per class.
    - The replies of the approval routes are read in `two_step.rs` (`approval_start_reply_read`, `approval_status_reply_read`, `approvals_reply_read`, `approval_ack_reply_read`, `device_enrolment_reply_read`, `device_confirmed_reply_read`), as every other step reply is, and `approval_asks` words the prompt.
    - Fixtures of their own, in both directions, every value derived from a label so a run changes nothing unless the construction did: `fixtures/web-device-approval.json` (made by `packages/crypto/scripts/device-approval-fixtures.ts`, read by `tests/device_approval_fixtures.rs`) and `packages/crypto/src/__fixtures__/core-device-approval.json` (made by `examples/device_approval_fixtures.rs`, read by `packages/crypto/src/device-approval.test.ts`). The server's copy (`packages/db/src/signatures.ts`) is held to both. Regenerate with `bun run fixtures:device-approval`.
- Fixtures: `twoStepPhrase` in both base files (the web's statement and signature made here byte for byte, and this crate's verified by the web's `verifyTwoStepPhrase`).

## Contacts, pins and settings (`contacts.rs`, `first_seen.rs`)

### Fingerprints and digests

- Fingerprint version 3 covers X25519, Ed25519 and the SHA-256 of the ML-DSA and ML-KEM keys.
- `identity_fingerprint` takes the digests. `identity_fingerprint_of_keys` takes the keys.
- `key_digest` gives a key digest.
- `digest_hex`, `digest_base64url` and `same_key_digest` convert key digests between contact pins (hex) and group statements (base64url).

### Pins

- `pin_verified` checks a words-checked pin. A first-seen pin never passes it, on any client.
- `PinKeys`, `pin_trust`: `Verified` / `Seen` / `Legacy` / `Invalid`.
    - `Seen` is `fingerprint` exactly `""` with every key field canonical.
- `key_commitment` is the version 3 fingerprint over the four keys, verified or not.
- Keys are compared by `key_commitment`, never by a pin's `fingerprint`: every first-seen pin holds `""`.
- Design: docs/optional-verification.md.

### First-seen pins (`first_seen.rs`)

- `compare_pin`: twin of packages/drive's `comparePin`.
    - A first-seen pin is held like a verified one, so `Succession` is allowed from it.
- `pin_of_served`: a verified or first-seen pin.
- `pin_first_seen_of_legacy` (design 2.5): the pin's classical keys are the served ones and `identity_verify_keys` holds.
- The guard's rule (design 2.8):
    - `GuardEntry`, `GuardState`. `Absent` is first use; `Unreadable` never is.
    - `guard_agrees` checks the chain from the guard's own keys with `succession_chain_verify`, never from the pin's or a link's.
    - `guard_entry_next`.
    - The guard's store is the app's.
- Fixtures: `fixtures/pin-cases.json` covers trust and commitment, comparisons, pins of served keys, guards without a chain, kept admissions, and the 0.10.0 apps' pin readers by their JSON shapes. No fuzz kind yet.

### Settings document

- Settings key: `settings_key_create/open/rewrap`.
- Settings envelope version 2: `settings_seal(user_id, settings_key, …)`.
- Version 1 documents were sealed under HKDF of the identity's X25519 private key.
- `settings_open(user_id, settings_key, envelope) -> Option<String>`: `None` for a version 1 envelope.
- Settings documents read as 1 or 2 and are always sealed as 2.
- The ledger reads settings itself: see [Settings in the ledger](#settings-in-the-ledger-ledger_settingsrs).

## Families

Design: docs/groups-design.md and docs/groups-mobile-plan.md.

- Guardian seals (docs/groups-design.md 2.9) were removed for milestone 1. Child accounts are a later milestone. Do not reintroduce them without the design's review.

### Statement grammar (`canonical.rs`)

- Group statements use lowercase UUIDs only, base64url digests and strictly ascending lists.
- Statement fields are integers 1..=2^53-1.
- One grammar serves `encode_statement` and `parse_statement`:
    - At most 4 MiB.
    - Arrays at most four deep, of plain ASCII strings and integers 0..2^53−1.
    - No escapes.
    - Exactly the compact encoding.
- Every parser ends with the re-encode check.
- `bytes_of` refuses empty strings. The general `decode` keeps its behaviour.
- Pins' `checked_at` must be the canonical ISO form.
- Chain indices go through `version_index`.

### Group keys and statements (`groups.rs`)

- The group key is a 64-byte seed: Ed25519, then the ML-DSA-65 ξ.
- `group_public_key`, `group_sign`, `group_verify`. Context `hushos/group/v1`.
- `group_fingerprint`.
- Roster statements: `roster_statement`/`roster_parse`/`roster_sign`.
- Succession statements: `group_succession_*`.
- Members sign through a roster.
    - `roster_member_signer` uses the served ML-DSA key only when its digest is the entry's.
- `MAX_ROSTER_MEMBERS` is 10,000.

### Group seals

- `group_key_seal`/`_open` and `area_grant_seal`/`_open` all take `Arc<AcceptedRosters>`.
- `GroupKeySealContext` and `AreaGrantContext` carry `roster_version` and `roster_digest`.
    - The sealer must name their latest accepted roster.
    - An opener must have it on its chain.
- Area grants take the area's id seed. They refuse a workspace not derived under the group.
- The seal functions take no history.
    - The sealer's Ed25519 and ML-DSA keys (derived from the seeds) must be their entry's (`sealer_holds`).
    - So a member seals only after their identity is folded in.
- `group_key_seal` refuses a sealer who is not an active `Members` holder.
    - The creator may seal key 1 only while active.
- `area_grant_seal`:
    - Refuses a granter who is not active.
    - Grants only a listed key.
    - Refuses a retired area.
- `group_key_open` checks the reader is the holder. It takes the creator's key 1 seal only while the creator is active.
- The openers take an optional `SignerHistory { served, links }` for the sealer or granter.
    - They then also accept the keys on the signer's verified path, from their first `key_history` set up to and including their entry's keys, never past them (`groups::signers_through`).
    - A seal from before a fold-in opens.
    - A seal under the entry's keys after the member moved on opens.
    - A seal under keys no roster has folded in does not.
    - A forked identity lends nothing beyond the entry's own keys.
- `area_grant_open`:
    - Refuses a version above the latest roster's, one never listed, or an opened key whose commitment differs.
    - Has no `highest_key_version` floor.
    - Is not uniffi-exported. Apps open a family folder through `AreaLedger::open_family_area`, and its key never leaves the ledger.

### Areas on the roster

- Rosters carry `areas` as `RosterArea` rows (uniffi default `[]`).
- Rows are deltas: only areas the roster creates or rotates.
    - `MAX_ROSTER_AREA_ROWS` is 1,024.
    - Rows are folded into `area_keys` (`fold_areas`).
- `area_key_commitment(&key)` is HKDF of the key alone under `hushos/group/area-key/v2`.
    - It is not uniffi-exported.
- `AcceptedRosters::area_keys` (cached) holds every version's commitment.
- The area rules live in `check_entries`/`roster_rules`, with `check_areas` holding:
    - An area stays at its version with the same commitment, or steps one.
    - New areas, and roster 1's, start at 1.
    - A family removal rotates every live area.
    - No admission on a roster that drops a holder.
    - No commitment already on the chain (a `HashSet` in `State`, folded with the rows), and none repeated in one roster.
    - At most `MAX_FAMILY_AREAS` (1,024) live areas: `check_areas` refuses a family's 1,025th. So a family removal always fits.
- Area retirement must come before deletion.
- `areas_to_rotate` names what a family removal must rotate. It skips retired areas.
- `next_area_key` refuses an earlier key.
- `check_cache` checks only the last roster's rows (and roster 1's full set). Earlier commitments are trusted as stored.
- `area_write_version` gives an area's write version (none for a retired area).

### Roster format 2

Design 2.10, F14 and F11.

- `Roster.format` (1 or 2, uniffi default 1) is the statement's version.
- Format 2 area rows:
    - `[ws, v, "key", commitment, rootCommitment]`.
    - `[ws, v, "retired"]`, a tombstone.
    - Fields: `RosterArea.root_commitment`, `RosterArea.retired`. The commitment is empty on a tombstone.
- `area_root_commitment` is HKDF of the root's node key under `hushos/group/area-root/v1`. It is not exported to apps.
- `check_areas` also holds (with `AreaLedger` counting):
    - The format never goes down.
    - No root commitment twice.
    - Tombstones only at an existing area's next version.
    - Nothing after a tombstone.
    - Removals rotate live areas only.
    - The 1,024 limit counts live areas.
- `AcceptedRosters::area_roots` and `retired_areas` are cached as `GroupChainCache.area_roots` and `retired_areas`.
    - A cache without them reads as none.
- `GroupChainCache.cache_version` (uniffi default 1; this core writes 2) says whether a cache carries `area_roots`/`retired_areas`.
    - A version 2 cache with roots emptied is refused, never read as uncommitted.
- `area_root_check(chain, ws, version, root_key) -> bool`.
    - `false` for a format 1 version, and only for an explicit `None`.
    - It refuses a version with no root entry at all.
- `area_write_version` is none for a retired area.
- `AreaKey.root_key` is required in format 2.
- `next_area_key(.., root_key)`.

### Building rosters

- `roster_first(group_id, kind, creator, area_keys, format)` builds roster version 1.
    - The creator is the only entry and signer, roles sorted, `since_version` 1.
    - Rows at version 1 are computed from the keys by `groups::rows_after` (the crate-private `area_rows` wraps it).
    - It runs the version 1 `roster_rules`, signatures aside, with a placeholder key in the state. So a creator never signs a first roster that acceptance refuses.
    - Twin of the web's `firstRoster`.
- `roster_entry_own(user_id, identity, roles)` makes the creator's roster version 1 entry (`since_version` 1), for nothing else.
    - It is built from their own identity, whose keys statement must hold.
    - The roster's signer signature, checked under the entry's keys, proves the entry and the signer are the same identity.
    - That the identity is the newest is the creating client's check (design 3.1).
    - Twin of the web's `ownRosterEntry`.
- `roster_next(.., area_keys: Option<Vec<AreaKey>>, retire_areas, format)` applies acceptance's rules (signatures aside) before a holder signs.
    - It computes the rows (`area_rows`), one HKDF per key, keeping only commitments, the keys zeroized.
    - It refuses any key equal to any earlier commitment of any area.
    - The format is the chain's by default, never lower.
- `roster_entry_new` takes a verified or first-seen pin, never a `trusted_via` one.
    - It is not uniffi-exported.
- `roster_first` and `roster_entry_own` are uniffi-exported for the phones.

### Accepting a roster chain (`group_trust.rs`)

The model: every device verifies the roster chain from version 1, or continues from its own cache.

- Entry points:
    - `accept_rosters(group_id, first_keys, anchor: Option<GroupAnchor>, pins, rosters, successions, ml_dsa_keys, me, cache)`.
    - `accept_rosters_joining(.., join_mark, pair_marks: Vec<PairMark>)`. `accept_rosters` is it with neither.
- Verify first, decide second.
    - The chain is the one ending at the latest roster served, linked by `previous_roster_digest` to version 1 (or the cache's last roster).
    - The chain is verified in full before any mark is compared. So a server alone gets refusals, never the warning.
- Refusals:
    - Two rosters at the latest version.
    - A link that does not reach.
    - Rosters after the cache that do not continue it ("fetch it again from version 1").
    - A chain short of a mark (rollback).
    - A succession whose new key is the old one or any earlier group key.
- Any other served roster is a dead branch.
    - Ignored and listed in `dead_branches()` (version, claimed signer).
    - Never a warning.
- `AcceptedRosters` is a `uniffi::Object` with getters and no constructor.
    - Swift and Kotlin can read one but not write one out.
    - The web freezes it and keeps a registry of accepted chains, and every seal function checks it.
- `AcceptedRosters::own_entry_behind_at` is a soft note, not cached.
- `AcceptedRosters::checked()` (`FamilyChecked { how: Created | Join | Compared, roster_version }`) is worked out by acceptance. It is never passed in and not cached.

#### Marks

- The person's marks:
    - `pins`: every pin they hold, settings and device.
    - `cache` (`AcceptedRosters::cache`): the device's own record. Roster digests, last statement, group keys, successions with tie, digest and signer, creator, `key_history`, wrong own entries.
    - A join mark, and pair marks (below).
- Marks that disagree with each other, or with the verified chain, are `RosterChain::Fork { of: Roster | GroupKey, version, sides }`.
    - Each `MarkSide` is a digest, where it came from (`Pin`, `Cache`, `Served`, `Join`, `Pair` as `MarkSource`), and the signer only for a verified statement.
    - No side is ever the culprit.
- Version 1 keys other than a pin's or the cache's, with a chain verified under them, are a `GroupKey` fork at version 1.
    - Its sides are the SHA-256 of the Ed25519 key and the ML-DSA digest.
- A group key mark no valid succession meets waits. Rivals are kept in `waiting` with their keys.
    - It is the warning only if a roster needing the next key holds under a rival key, signed by a `Members` holder, and the departure rules hold.
    - A roster under the real (withheld) key, with only rivals served, is refused (`NO_SUCCESSION`).
    - A mark still unmet at the end is a rollback, refused.

#### Anchors (first use)

- `anchor` replaced `first_keys_checked`. Values: `Created`, `Join`, `FirstUse`.
- With any mark, an anchor vouches for nothing and the marks decide.
- `FirstUse` vouches only with no pin, no cache and no pair mark.
    - And only for a reader whose entry is active at the head (`NOT_LET_IN` otherwise).
- A join mark comes with `Join`, or with no anchor beside marks.
- With no pin, no cache and no anchor, nothing is accepted.

#### Join marks and pair marks

- `JoinMark` is `{ roster_version, code }`.
    - The code is twelve words from `join_code`: SHA-256 over a `hushos/group/join-code/v1` prefix, the roster digest, the group key digest and the u64be key version, read as fingerprint words.
    - A mismatch is a `Roster` fork, side `MarkSource::Join`.
- A `PairMark` is a family check.
    - The chain must hold a roster at its version over which `pair_code_of(…, reader, with)` is its code. Otherwise the fork, with a side `MarkSource::Pair`.
    - Beyond the head: refused.
- `pair_code_of` is the raw code: `hushos/group/pair-code/v1` over the roster digest, the group key digest and version, and the two lowercase ids sorted.

#### The pass along the chain

- Acceptance runs in four steps:
    1. Marks against marks, and the served version 1 keys against the marks (before anything served).
    2. Link.
    3. Verify.
    4. Marks against the chain.
- Each roster is checked under the key current at its version.
    - It is signed by a `Members` holder of the roster before it.
    - One copy carries both signatures. Other copies of the same statement may fail.
    - The entry rules hold.
    - The succession a dropped holder made due is present.
- `roster_rules` refuses a signer not active on their own roster, and a roster with no active `Members` holder.
- Successions:
    - Each is taken as soon as the roster it is tied to is held.
    - One that does not hold is ignored.
    - Two that hold are refused, unless a group key mark chooses.
    - Candidate successions' signatures are checked once per statement (`State::signatures`).
- The entry rules are only these:
    - Entries never disappear.
    - `since_version` is the version an entry last changed at.
- Key versions are a holder's claim.
    - Chains are followed from an entry's keys with no key-version floor (`pinned_of` has `key_version: None`).
- `links_loaded` false (served identity or links not loaded) turns `BadSignature` into `Unchecked`.

#### Checking the next statement

- `roster_check_next(chain, roster, ml_dsa_keys, identities)` and `group_succession_check_next(chain, succession, ml_dsa_keys)` are acceptance itself, extending the chain's cache by one statement.
    - Both return `()`. There is no server role in Rust.
    - With `identities`, a new or changed entry must be one of its member's identities, with its keys statement holding.
- The server runs both (in the TypeScript twin) before storing.
- Clients run the succession check before signing.
- The web also has `acceptStoredChain` (server-only, TypeScript only).

### Succession paths (`succession_path.rs`)

- `succession_path` is crate-private, the twin of `packages/crypto/src/succession-path.ts`.
- It is the group core's own walk along a member's links.
    - Each link is verified once (memoized per call site) by its successor consent (`succession_consent_verify`).
    - The verified links form a graph, followed from a start key set.
    - Two verified links leaving one key set to different keys are an identity fork (`SuccessionPath::Fork`), whatever the served order.
- It takes a proof:
    - With `consent_until` (the entry's keys): every link before them needs consent, and every link after them its version 2 signature. Used for the walk from the first keys in writer trust, and `signers_through`.
    - Without it: the version 2 signature. Used for the lag, a personal pin's walk, and `roster_entry_fold_in`.
- It takes `member_keys` and counts only links that could join the chain toward the 64 cap (`TooMany`).
- It says `Stale` when the start itself is the served identity and a link leaves it.
- The group walk returns `Stale` when a verified link leaves the served keys (readers: unchecked). It never reads the served key version.
- It remembers verifications under a typed key (member, proof, link).
- `VerifiedLinks` is a bounded LRU (4,096) keyed by SHA-256.
    - An internal mutex is held only for lookups and stores.
    - `SuccessionCache` holds one. `SuccessionCache::new()` is a uniffi object.

### Writer trust

- `group_writer_trust(group_id, areas, reading, workspace_id, writer_user_id, pinned: Option<WriterPin>, served, links, cache: Option<Arc<SuccessionCache>>)`.
- `WriterPin` carries the keys and `trusted_via` together.
    - An empty `trusted_via` reads `Unchecked`.
    - A pin that agrees returns its `trusted_via` as `via`.
    - Consent is asked on the pin walk exactly when `trusted_via` is set.
- `VerifiedPin.trusted_via` has no binding default. It is set by `trust_as_group_does`.
    - `roster_entry_new` refuses it.
    - iOS `ContactPin.trustedVia` and Android `ContactPin.trustedVia` exist. A words check clears it; a followed pin keeps it.
- Keys are retired only along the links `succession_path` verified, never a link served beside them.
    - Unpinned: from the entry's keys and the member's first `key_history` set (the words-checked one), never a later set.
    - Pinned: from the pin. Plus the keys before the pin on the path from the entry's or first keys, when the pin is at a later identity (`retired_before`).
- The first keys' walk retires keys only up to the entry's (`up_to`).
    - It never sets the fork verdict. Only its own retirement is voided.
- An identity fork anywhere on those walks is `Unchecked`.
- `TooMany` on the lag or pin walk reads as links not loaded, not a fork.
- Own entries naming a replaced identity of the reader are in `own_entry_wrong_at` too.
- Re-keyed records in families: `group_metadata_rekeyed_integrity`/`group_version_rekeyed_integrity(node_key, GroupRekeyedTrust, record) -> GroupRekeyedVerdict`.
    - The origin is judged under the origin signer's `GroupWriterTrust`, the re-keyer under theirs.
- `GroupVerdict::Seen` is given as `Integrity::Seen` is.

### Group fixtures

- Both twins derive every person and group key from the same seeds (`tests/common/groups.rs`, `group-testkit.ts`).
- Each twin must reproduce the other's full verdict: cache, key history, dead branches, own entries, record and next-statement verdicts, seal payloads.
- They build, in the same order:
    - 150 `cases`: dead branches, marks and forks with their sides, refusals, the cache and its binding, the entry rules, the group's kind, succession ties and order, the next roster and succession checks, the reviews' probes, records read through the chain.
        - 23 format 2 cases at the end, root probes in `CaseInput.root`.
        - The first-use cases `anchor-*`, `pair-*`, `join-*-as-*`, `first-use-pin-*`, with verdicts that include `checked`.
    - 28 `sealCases`: the two openers, sealer histories up to the entry and never past it, a planted entry lending no history, planted keys, a forked sealer identity, a creator who left, seals bound to the sealer's roster, planted first keys with and without the member's consent, an earlier area version re-delivered after a rotation.
    - 12 `sealerCases`: who may seal or grant, with which keys, at which roster, which area key. Includes `granter-retired-area`.
    - 4 `foldIns`: a forged or one-sided link folds nothing in.
    - 7 `chainCases`, for the strict personal-pin verifier: one-sided links held, junk after the chain, links out of order, another ML-DSA key at the start, a version beyond 2^53−1 refused.
    - 18 `statementCases`: raw bytes against the statement grammar.
    - 11 `firstRosterCases`: `roster_first` to the same statement bytes, or refused alike.
    - 7 `ownEntryCases`: `roster_entry_own`, or refused alike.
    - `foldedSealer`.
- Unit tests: `groups.rs` `format_2_*`.
- The fixture decoder returns an error for a malformed cache (`raw_cache`, judged refused).

### The area ledger (`area_ledger.rs`)

- `AreaLedger` is a `uniffi::Object`, one per unlocked session.
    - The app, the File Provider extension and the DocumentsProvider each fill theirs from listings.
- It is the twin of the web worker's Drive key store and family write rules in `packages/crypto/src/area-ledger.ts`. `session.ts` and `session-groups.ts` call it.
- It holds:
    - Every workspace and node key, each node key with the area version its path is rooted at.
    - A walk's pending keys.
    - The committed chains.
    - The areas each family opened.
    - Per (family, area): the write version, block reason, root-seen version and root node.
- It decides these exactly as the worker does, with the same messages: `KEY_CHANGE_PENDING`, `NOT_CARRIED`, `AREA_ROOT`, `KEYS_CHANGED`, `NOT_CHECKED_KEYS`, `NOT_COMMITTED_ROOT`, `OLDER_CHAIN`.

#### Apps write family folders only through `AreaLedger`

- `node_wrap`, `node_open` and `previous_root_key_open` stay exported, for personal folders, shares and the shipped apps.
- They check none of the family write rules. A wrap made with them in a family folder skips rooting, the write version and every refusal above.
- In a family folder:
    - Wrap, re-wrap, create and walk with `new_node_key`, `rewrap_node` and `rotate_node`.
    - Take keys for writes from `writable_node_key` only.

#### Area state is per (family, area), never per area

- An area resolves only through the family `open_area` derived its id under (`check_id`).
- Another family's listing of it is ignored and reported (`foreign_listings`), never a lock.
- So is any family's listing of the account's own workspace.
    - Apps call `open_personal_workspace` when they open the personal grant, before any family sync.
- An area no family opened resolves through none.
- `commit`, `uncommit` and `forget_group` touch only their own family's areas.
    - `forget_group` drops the keys of the areas that family opened, nothing another family's chain merely lists.
- Why: keyed by area alone, a removed member who manages another family the victim is in could list the area at an old version and, with the server, get writes under the old top-level key.
- `open_area` is not in the exported impl. No exported function hands out a family folder's key.

#### Committing chains

- `commit` refuses:
    - A chain older than the one held (`OLDER_CHAIN`). The app re-reads.
    - Another chain at the version held (`SPLIT_CHAIN`). The app shows it as the fork.
    - On either, the app writes nothing of that acceptance: no record, no pin.
- Background walks need this.
- `commit` is not exported. Apps commit only through `accept_served`, and the join and creation paths.
- The committed chain is passed to acceptance as a mark (`pin_after` of it) by `accept_served`, so the split view is the fork before the ledger sees it.
- While a family that opened a folder has no committed chain (after the last attempt's refusal, or a fork), it is held back (`State::held_back`, the worker's `heldBack`):
    - `open_listed_node` and `writable_node_key` refuse with `NO_CHAIN`.
    - `node_key` and `prev_node_key` (so `key_at_epoch`) give none.
    - `parent_key_and_root` is reached only behind those gates or `require_writable`.
    - Keys stay held for the next commit. `forget_group` drops them.
    - A forked family's folders do not read from keys already held.

#### Roots

- A top-level row at the area's write version, whose key holds, pins the area's root node.
- An old-version top node never does.
- Any other top-level node is refused without touching what was seen.
- A root served at an older version never lowers `root_seen_at`.

#### Walks

- A walk goes node by node through `rotate_node(workspace_id, node, target_epoch, signing_seed)`. Details in [Re-keyed walks](#re-keyed-walks-rotation_recordsrs).
    - It runs `require_writable` first (as `driveRotateNodes`).
    - It makes the fresh key, re-keys the node's records with it, and only then marks it pending, as the worker's `rotateKey` does.
    - A node whose records do not re-key leaves nothing pending.
- `rotate_drop` drops a refused batch.
- `rotate_drop_all(workspace_id)` drops one the app lost track of.
- `rotate_key` (the key half alone) is `#[doc(hidden)]` and not exported.
    - The shared scenarios and the fuzz target call it.
    - Apps never see a walk's keys.

#### Area ledger fixtures

- `fixtures/area-ledger-scenarios.json`: hand-written scenarios with stated outcomes, two-family ones included.
    - Both twins run them through `tests/common/area_ledger.rs` and `packages/crypto/src/area-ledger-testkit.ts`, which calls the worker's own ledger functions.
    - One scenario: a refusal never lowers the floor.
- `fixtures/web-area-ledger.json` and `core-area-ledger.json`:
    - Every step's outcome must match.
    - Every key envelope the other twin made or served (option A's label included) must open to the key it says.
- Two rule oracles hold on every run:
    - Each successful create, re-wrap or walk key went under a parent rooted at the write version.
    - Each node a write made is writable at once.
- Fuzz target `area_ledger` takes `{steps}` in the same vocabulary and asserts the oracles.
- The differential's fast-check side also draws random step sequences.

### Re-keyed walks (`rotation_records.rs`)

- `AreaLedger::rotate_node(workspace_id, node, target_epoch, signing_seed)` returns `RotatedNode`.
    - The key envelope at the target.
    - Metadata and each version as `RotatedRecord`, re-keyed raw under the fresh key.
- A record that already carries an origin (`ServedRekey`):
    - Carries it after `*_origin_carry`'s bound check.
    - Or is re-sealed with `drop_origin` when the origin does not bind (a wrap at another epoch or for another version included), its writer is gone, or it names a writer with no signature.
- A signed record becomes its own origin.
- An unsigned record (no signature, or a writer served as nobody) is re-sealed as the walker's (decision D6).
    - The residual, planted unsigned content reading "Re-locked by" the walker, is in docs/integrity-design.md.
- No legacy signature beside a re-key (decision D3).
- A node already at the target is only re-wrapped.
- Refused:
    - A seed that is not the unlocked account's (`open_account`; `NOT_THIS_ACCOUNT`, `NO_ACCOUNT`).
    - A workspace that is no family folder (`NOT_A_FAMILY_FOLDER`). The web's personal `legacyRecord` is not ported.
    - A node with shares or links (`SHARED_IN_FAMILY`). Sharing is hidden in family folders (design 3.4), so any share is one the server listed. The web's `rekeyNode` refuses them too.
    - The top level (`AREA_ROOT`).
    - A second walk of a node to a target it is pending at (`ITEM_CHANGED`, both twins).
- Keys and seeds go through borrowed-slice internals (`*_with`) and are wiped.
- Fixtures: `rotations` in both area-ledger fixture files (`tests/common/rotations.rs`, `packages/crypto/src/rotation-testkit.ts`).
    - Eleven cases on a family whose roster 2 removed person 3:
        - A removal's walk keeping every writer's record.
        - A second walk carrying bound origins, and dropping a gone writer's and an unbound one.
        - Carried origins wrapped at another epoch, for another version, or naming a writer with no signature: dropped.
        - The walker reading its own walk.
        - A re-wrap at the target.
        - A folder whose two children are wrapped under its pending key while their records are re-keyed, with a child under its old key left unwritable.
        - A three-version file with one writer since gone.
        - A planted signer read back as a bad signature in its name.
        - An unsigned record under the replaced key, re-sealed as the walker's and read as re-locked.
        - A shared and a linked node both twins refuse with the same message.
    - Each twin walks each case's nodes in order, checks its declared shapes, writes and verdicts (or the refusal), and writes the walked nodes.
    - The other reads them on a fresh member's ledger with its own verdicts (`bound: true`, the origin's verdict kept, the removed member's file `former-member`).
    - It also walks the other's input nodes to the same shapes and writes.
    - Each re-keyed record is a `record_integrity` seed (`rekeyedInputs`).

### Record verdicts (`group_verdicts.rs`)

- `AreaLedger::record_verdict(group_id, reader, writers, record, cache) -> CoreResult<RecordVerdict>`.
    - This account's records are judged by its own keys.
    - Everyone else's by `group_writer_trust`, against the ledger's committed chain and the areas the family opened.
    - A re-keyed record with the node key at its epoch from the ledger. Unchecked without one.
- The family is the one the folder was opened under. Otherwise `NOT_THIS_FAMILYS`, as the web's `groupVerify` checks.
- The fork comes from the ledger: `uncommit(group_id, fork)`, cleared on commit and forget.
- `reader` must be the account `open_account` named.
- `AreaLedger::copy_form(...) -> Integrity` gives the prior a `*_copy_sign` call takes.
    - `Verified`, `SavedFromLink`, else `Resealed`.
    - A former member's or key conflict's record, and an unbound origin: `Resealed`.
    - Unchecked is refused, a re-keyed record without its epoch included, in both twins.
- Personal keys come from `GroupWriter::personal`. The web's copy uses its Drive trust set instead.

### Device record, floor and guard (`device_record.rs`)

Twin of the worker's device store and `accept` (`session-groups.ts`), the data layer's order (`packages/crypto/src/record-acceptance.ts`, `acceptFromRecord`, which `apps/web/src/lib/groups/sync.ts` calls) and `mergePin`/`pinAhead` (in `packages/crypto/src/pins.ts`).

#### Opening the account

- `AreaLedger::open_account(user_id, signing_public_key, account_key)` derives and holds the device store key.
    - HKDF-SHA-256 of the root, salt 32 zeros, info `hushos/group/device-store/v1`.
    - A root of another length is an `Input` error.
    - `clear` wipes it.
- Opening another user than the one open clears everything first: keys, chains, floors, settings.
    - As the web's unlock of another user forgets the Drive keys and the families.
    - The same user keeps them.
- `clear` and a switch of user bump a generation that survives `clear`.
    - An acceptance commits, uncommits or marks a fork only under the session it began in (`NOT_THIS_ACCOUNT`, checked under the lock).
    - It seals its record under the key held at commit.

#### Device stores

- Device records are sealed with XChaCha20-Poly1305.
    - AD `["hushos/group/device-store",1,userId,groupId,store]`.
    - Envelope: base64url of `[1][nonce][ct]`. JSON text in and out.
- `chains`, `joins`, `holds` and `outbox` are all the core's.
    - The chain record is sealed and opened only inside `accept_served`.
- `AreaLedger::group_device_record_seal`/`_open(group_id, store, value)` and `DeviceStore` (`Outbox` only) are fixtures-only.
- `CoreError::Sealed` means the envelope did not open: delete it.
- Anything else (no account, a malformed id) is `Input`, and the record stays.
- `chain_record_seal_value`, `chain_record_open_value` and `opened_area` are `#[doc(hidden)]`, not exported, for the fixtures and the fuzz target.

#### The chain record

- `{"v":1,"cache":…,"pin":…}`.
- The cache is written as the web writes it (`cache_json`, `cacheVersion` 2, `areaRoots`, `retiredAreas`).
- It is read as `marksOf` reads it (`chain_record_read`):
    - Not version 1 is unreadable.
    - A falsy cache is none.
    - A cache the worker refuses by shape is refused (`RecordCache::Refused`), keeping only what a list `rosterDigests` counts. Bad shapes: not an object, any `origin`, a field of the wrong JSON kind, `areaRoots`/`retiredAreas` present but null, a version 2 cache without them.
    - A pin of the wrong JSON kind refuses acceptance on every path.
    - Numbers read as `JSON.parse` reads them.
- A record's pin is checked as the web's `checkGroupPin` checks the raw JSON (`pin_of`): field by field, in its order and words.
    - Both twins check every area id, then every area version. So a pin wrong in two places is refused for the same field.

#### Settings before acceptance

- `AreaLedger::use_settings_envelope` sets the settings (see [Settings in the ledger](#settings-in-the-ledger-ledger_settingsrs)).
- Settings that opened are never replaced by none within one unlock (D7, the worker's `useSettings`).
- `AreaLedger::legacy_settings(user_id)` is the worker's `legacySettings` for a version 1 document.
    - Refused after settings that opened. Otherwise nothing is set.
- Acceptance before any settings for the account is refused (`Open your settings first.`).
    - This comes after the record is opened, as `marksOf` orders it.

#### `accept_served`

- `AreaLedger::accept_served(me, group_id, record, served: ServedChain, checked_at) -> ServedAcceptance`.
- Answers: `Accepted { chain, record, pin, guard }`, `Fork`, `RecordUnreadable`, `FetchFromVersionOne`, `Overtaken { split }`.
- `record` none with `served.after` above 0 is `Input`, before the ledger is touched.
- A continuation refused or overtaken is `FetchFromVersionOne`. Call again with the same record.
- From version 1: first with the cache, then without it, with the record's pin still a mark.
- Each run is the worker's `accept` against the family's floor.
- A changed session or account, or settings not open, is passed straight back. It is never turned into `FetchFromVersionOne` (the web's `accountError`).
- A run overtaken from version 1 is `Overtaken`, never an English error.
    - `served_race_message(split)` holds the words to show after three.
- Apps store the record only if no stored record is at a later roster version, and before they settle the pin.
    - The web's `putChain` refuses a lower version.

#### The floor

- The floor is the highest chain committed this session (`State::floors`).
    - Raised by every commit.
    - Never dropped by `uncommit`. Only by `forget_group` and `clear`.
    - The web's ledger keeps the same in `area-ledger.ts`.
- It is the `OLDER_CHAIN` floor before acceptance, and a mark (`pin_after` of it).
- Every commit checks it again (`State::commit`), so `commit` never goes below or beside it.
- `commit` holds a chain to the whole floor and to the held chain (`overtaken_by`: roster digest and group key at their versions).
- Admission counts the session floor as a mark (its pin among the pins).
- The floor moves to a later group key at the same roster too.
- `commit_served`/`uncommit_served` are held to the family's epoch the call took (`Reader::epoch`, bumped by every `forget_group`; `FAMILY_FORGOTTEN`, an account error).
- The ladder keeps the family committed between attempts.
    - `accept_once` takes `retried` (every attempt but the last when there is a record). It checks the session but does not uncommit.
    - The worker's `groupAccept` takes the same flag from `acceptFromRecord`.

#### The guard

- `FamilyGuard` (`Absent`, `Unreadable`, `Held { pin }`) goes to `accept_served`, `accept_joining` and `join_first_use`.
    - It is the device's guard (design 2.8), a mark like any pin.
    - `Unreadable` refuses with `GUARD_UNREADABLE`.
- The core decides how it advances.
    - `ServedAcceptance::Accepted` and `JoinAcceptance::Accepted` carry `guard: Option<GroupPin>`.
    - `guard_after` (twin of the web's `guardAfter`): `merge_pin(group, guard, pin, opened areas)` when `Merged` and `pin_ahead`, else none. So it never goes down.
- The app's rules for the guard:
    - Write it before the record. No pending record, no wait for the settings save.
    - Store it apart from the chain record.
    - Never delete it on a `not-member` wipe.
    - The store merges and never goes down (`merge_pin`, under the account's lock).
    - Nothing is written under an acceptance until its guard is stored.
- Wipe a family only through `AreaLedger::forget_group(group, guard, checked_at) -> GroupForget { forgotten, guard, unreadable }`.
    - It drops nothing while the held guard does not cover the session's floor. It hands back the guard to store: the held one moved on to the floor with the folders opened here (`guard_after`'s rule, `GuardAfter::Store`). Call it again after the store.
    - An unreadable guard holds it up only over a floor.
    - It forgets only over a held guard equal to the floor at its versions (`GuardAfter::Covered`).
    - It refuses, nothing dropped, a guard that disagrees with the floor or crosses it (`GUARD_CONFLICT`, `GuardAfter::Conflict`; `merge_pin` calls crossed versions a conflict).
    - It refuses one past the floor (`GUARD_AHEAD`, `GuardAfter::Ahead`): accept up to it first.
- iOS passes the stored guard (`heldFamilyGuard` in `FamilySync.swift`).

#### Merging pins

- `merge_pin(group_id, current, next, opened: Vec<Arc<OpenedArea>>) -> CoreResult<PinMerge>`: `Merged`, `Behind`, `Conflict`.
    - An opened area of another family is refused.
- `pin_ahead`.
- Check times compare by UTF-16 code units.
- `OpenedArea { group_id, workspace_id, version }` is a `uniffi::Object` only `open_area` makes (`AreaOpened::pin_area`).
    - So the areas folded in from `opened` are ones this device opened for that family.
- `current` and `next` are plain records an app can fill.
    - A forged area there only raises an area's mark, which is the limit of the type.
    - App reviews hold that the only `next` is `ServedAcceptance::Accepted`'s `pin`.

#### Device record fixtures

- `deviceRecords` in both area-ledger fixture files (`tests/common/device_records.rs`, `packages/crypto/src/device-record-testkit.ts`): 26 cases built alike.
    - Cold: the cache continued, a refused continuation, unreadable records, newer or damaged caches from version 1, cuts below the record's pin with and without it, a refused pin, the cache and the committed chain as marks, no mark.
    - Warm, with a chain committed first: the record at the floor, behind it, damaged and headless caches, the refused continuation that must keep the floor, settings ahead of the record, settings on a branch, and a branch at roster 2 that only the cache shows at 2.
    - The last two: version 1 settings set nothing, and an unreadable record is the answer before settings are open.
    - Each twin runs the other's records and served chains to the same full outcome, refusal messages and whether it fetched from version 1 included.
- The app's own records (`stores`).
- `mergePins` from `fixtures/merge-pin-cases.json` (15 cases).
- `raceMessages`.
- Fuzz: kind `device_record` in `pins`.
    - Any JSON sealed as the chain record, served `through` roster 1 to 3, with a `held` chain committed first.
    - An accepted chain never goes below the held one.
    - It reaches and passes through the record's pin whenever it is one.

### Joining (`join.rs`)

The whole newcomer side. Twin of the worker's join (`session-groups.ts`: `admission`, `groupJoinPreview`, `groupJoinCheck`, `groupAccept` with `joining`) and its escalation (`packages/crypto/src/join-session.ts`).

#### Preview

- `group_join_preview(me, group, record, served, holds)` → `JoinPreview::Code { roster_version, code, session }`.
- `holds` (the app's stored escalation, or none) is folded in first.
- Then marks, as `accept_served` reads them (`open_marks`), plus a chain or fork the session holds (`holds_family`).
- `open_marks` checks `me` in the worker's order:
    1. Another account: `NO_ACCOUNT`.
    2. The record.
    3. The settings.
    4. `Open your identity first.`
- The code is the roster's where the account's entry last became active.

#### Hidden positions

- Drawn from `OsRng` only when the code has no entry in the family's book.
    - `next_u32`, rejection-sampled below `2^32 - 4`, mod 12, distinct, ascending.
- Never redrawn until a match on that code clears it.
- A family keeps at most 64 codes (`MAX_SHOWN_CODES`).
    - The earliest unheld one goes.
    - A book of 64 held codes refuses to show another (`TOO_MANY`).
- `JoinSession` and `JoinMatched` are `uniffi::Object`s with no constructors.
    - A session carries the account, the generation, the family, the mark and its positions.
    - A check accepts it only while the book still holds exactly those positions for that mark in that generation.
    - Otherwise `NOT_SHOWN`: a lock, another account, or a restore that replaced positions not held.

#### Check

- `join_check(me, group, record, served, session, typed, now, holds)`. In order:
    1. The account, then the restore.
    2. Not shown (`NOT_SHOWN`) and incomplete, before verifying.
    3. The admission again: `Changed` with a showing, words unchecked.
    4. The words.
- `join_check` re-reads the session's generation and positions under the lock after its unlocked admission. `AFTER_ADMISSION` is a `#[cfg(test)]` seam for the race.
- Answers:
    - `WrongWords { holds }`: the family's first miss. It holds the code.
    - `Mismatch { holds }`: after that (`held || tried`).
    - `Matched { matched, holds }`: clears `tried` and that code's hold, and seals the joins record.
- The joins record after a match: `{v:4, groupId, joinMark, checkedAt}`, store `joins`.
    - Checked at the settings pin's time if any, else `now`.
    - Version 3 records are read alike.
    - Version 2 joins records (an older data-layer escalation) are refused: a join in flight across that upgrade is compared once more.
- `holds` is the escalation sealed in store `holds`: `{v:1, tried, held:[{rosterVersion, code, positions}]}`.
    - `None` when nothing is held.
    - The app stores it in place of the one before, or deletes it on `None`.
- `join_check_message(again, them)` holds the two sentences.

#### Restoring holds

- `holds` on either call only ever holds more.
    - A held entry here is kept.
    - An unheld one takes the stored positions and is held.
    - A new one needs room.
- Roster versions 1 to 2^53 − 1 only.
- A blob that does not open on this account is refused with `HOLDS_UNREADABLE`. That is the only answer an app deletes it on.

#### Accept

- `accept_joining(me, group, record, served, matched, guard)`.
- Token checks:
    - A token of another account: `NOT_THIS_ACCOUNT`.
    - Of an earlier unlock of the same account: `STALE_MATCH`. Reopen it from the record.
    - Of another family: `OTHER_FAMILY`.
- Single use:
    - The record's SHA-256 is reserved under the lock (`JoinBook::consumed`, `USED` if taken).
    - It is released unless the join is `Accepted`.
- Then the admission again.
    - `Changed` only when the account was let in again at a later roster and the chain still passes through the compared roster with the compared code.
    - Anything else (another code at the compared roster, a chain short of it) goes to `accept_once` with the join mark, which answers the fork or a refusal.
- The `Join` anchor (once `first_keys_checked`) is passed only where nothing marks the family, as in the worker.
- `join_matched_open` reopens a kept record.
    - `None`: another root, family, version, or any store but `joins`.

#### What single use means

- A joins record is a standing permission to commit the compared code for that family, until the app deletes it.
- `consumed` only stops a double submission within one unlock.
    - It is cleared by `forget_group`, a lock and another account.
    - A relaunch starts empty.
- The record is bound to the account root and the family by its AD, not to a ledger instance. Any ledger of the same account opens it.
- `JoinBook` lives in the ledger's `State`.
    - Dropped by `clear` and another account.
    - `forget_group` keeps the escalation and clears only `consumed`.

#### First use and family checks

Design: docs/optional-verification.md.

- `pair_code(chain, me, other, rosters) -> PairCode`, at the later admission of the two.
    - `Code`.
    - `OwnEntryWrong`: this account's own entry at that roster names none of its identities, or acceptance found it wrong.
    - `NotAdmitted`.
- `AreaLedger::pair_match(me, group, other, rosters, roster_version, code, guard: GuardState, checked_at) -> PairMatch { check, pin }`.
    - The check record only for this device's code.
    - A verified pin only when the head entry is active and names the compared entry's keys.
    - And those keys are the guard's keys (an unreadable guard: none), or else the settings pin's.
- `AreaLedger::join_first_use(me, group, record, served, guard, now) -> FirstUseJoin` seals the version 4 joins record of the head's pin.
    - `{v:4, groupId, firstUse: <pin>}`, `pin_after`'s, read back with `pin_of`.
- `accept_joining` commits it with that pin as one more mark and no anchor.
    - So its version 1 keys, roster and group key all hold on a reload.

- The admin's join code over the committed chain (`groupJoinCode`) is not here: it is `member_join_code`, in roster calls.

#### Join fixtures

- `tests/common/join.rs` and `join-testkit.ts`:
    - 22 `joinPreviews` over named histories with drawn positions (`draws()`, the same list in both).
    - 23 `joinChecks` (`fixtures/join-check-cases.json`).
    - `joinSessions` from `fixtures/join-session-scenarios.json`: 22 scenarios run as the app drives them.
        - The escalation kept from each check, restored after a lock or relaunch or from an earlier step.
        - Each twin's full outcomes matched step for step.
        - Each twin's joins record and kept escalation opened by the other.
    - 9 due and 12 sign `consents`.
- `packages/db/src/auth.consent.test.ts` stores the consents through the backfill.
- First-use scenarios:
    - `a-first-use-*`, with `-record-binds-its-first-keys` and `-its-group-key` over the histories `madeUp` and `succOther`.
    - `the-guard-is-a-mark-a-wipe-keeps`.
    - `the-guard-advances-and-a-replay-below-it-is-refused` (histories `removal`, `removalFork`; ops `guard`, a step's `guard: "held"`).
    - `a-family-check-*`, `a-check-record-*`.
    - `no-first-use-*` (op `first-use`, a step's `guard`; settings `checked-before`, `checked-malformed` through the fixtures-only `use_family_checks`).
    - `cross.firstUseRecord`.
    - `pairCodes` in the roster-call documents.
- `fixtures/v0.10.0/planted-join.json` is a real iOS 0.10.0 join over a planted entry.

#### The `fixtures` feature

- It is on for the crate's own tests (through a self dev-dependency) and for the fuzz crate.
- It gates:
    - `AreaLedger::with_draws(draws)`, which replaces the CSPRNG.
    - `join_words`: the bare typed-words rule. JavaScript's `trim` set, lowercased, two ascending positions in 0..=11, a twelve-word code.
    - `join_draw_positions`.
    - `device_store_seal_value`/`device_store_open_value`.
- None of them is in a release build.

### Successor consent signing (`consent.rs`)

- `links_needing_consent(links, identities)`: twin of `consent-due.ts`.
- `AreaLedger::succession_consent_sign(me, link, old_identity, next_identity)`: twin of the worker's `identityConsent`.
    - It signs with the account root the ledger holds. No account key crosses the FFI.
- Refusals, in order:
    1. `me` of another account: `NO_ACCOUNT`.
    2. `me` without the identity the account opened: `OPEN_IDENTITY`.
    3. Not two version 2 identities with the next later: `UPGRADED_ONLY`.
    4. Either not opening on this account: `NOT_OWN`.
    5. `link` not naming both, or not signed by the old identity: `This link is not one this account made.`
    6. Not adjacent in `me`: `NOT_CONSECUTIVE`.
- `me` is the full opened history. An app that leaves one out gets `NOT_CONSECUTIVE`.

### Roster calls (`roster_calls.rs`)

Twin of the worker's `groupStage` (admission, role changes), `groupOpenSeal`, `groupGrants` and `groupJoinCode` (`session-groups.ts`), and of `packages/crypto/src/outbox.ts` (`outboxStep`, `readOutboxEntry`, which the web's outbox drives).

#### Opening the group key

- `open_group_key(me, group, seal, sealer_ml_dsa_public_key, sealer_history, holder)`.
- Route 8's seal is opened against the committed chain with the holder envelope's KEM half.
- The seed is kept in `State::seeds` while it is the committed chain's current key version (`hold_seed`, session re-checked).
    - `AFTER_OPENING` is its test seam.
    - Dropped by a commit to a later key, `forget_group` and `clear`.

#### Contact pins for calls

- `admit_body` (by `user_id`), `member_join_code` and `outbox_open` take the person's pin from the settings only (`contact_pin`).
- `use_settings(user_id, pins, contacts)` is fixtures-only. Apps go through `use_settings_envelope`, which opens the served envelopes in the ledger.

#### Staging a call

- `admit_body`, `roles_body` (`MembersRole::{Grant, Take}`) and `handover_body` (`Handover::{To, StepDown}`) answer `RosterCall`.
    - `Staged`, `SyncFirst`, `OpenKeyFirst`, `OpenFoldersFirst`.
    - The person's refusals are errors.
- `caller(.., manager)` checks, in order: the account, the chain, `members` (`NOT_MANAGER`), the seed, the identity.
- `stage`:
    - Refuses `ALREADY_IN`, `NOT_CHECKED`, unchecked keys, `NOT_IN`, `UNCHANGED`, `SELF_TAKE`, `ORGANIZER_FIRST`.
    - Builds the roster (format 2).
    - Checks the signer's entry.
    - Answers `OpenFoldersFirst` before signing.
    - Signs.
    - Adds the succession when a holder loses `members`.
    - Accepts the staged chain (`stage_chain`). It is never committed, cached, a mark or returned.
    - `parts` seals and grants against it (live areas only, from `call_state`).
- `call_still_holds` re-checks session and chain under the lock. `AFTER_SIGNING` is its test seam.
- Then the entry is sealed (store `outbox`), with the body as text and `previousRosterDigest`/`rosterDigest`.

#### Admissions

- Admissions convert the found contact pin (`ContactPin::checked`).
    - A words check with every key part a string. Otherwise `These are not the keys whose words were checked.`
- They refuse an entry whose `userId` is not the person's exactly (the worker's check).
- `admit_body` lets someone in over a first-seen pin as over a verified one (the worker's `groupStage` too).
    - A pin trusted via a group, one short of a key part, or one filed for them over other keys still refuses (`NOT_THE_PINNED_KEYS`).
    - An admission is never signed with a role (`ADMIT_AS_MEMBER`).

#### The manager rule

- `roles_body` keeps the manager rule (docs/optional-verification.md 3.6). It is the twin of the worker's `CHECK_MANAGER_FIRST`.
- Granting `members` needs this account's own verified pin of the person (`words_checked`, `pin_verified`).
    - Its key commitment must be their current entry's (`entry_commitment`, the digests as hex).
- A first-seen pin, a family's word, or a verified pin over other keys refuses with `CHECK_MANAGER_FIRST`.
- Taking `members` away, and the handover, ask for no check.
- Test: `members_is_given_only_over_this_accounts_own_verified_pin_of_the_keys_their_entry_names`.

#### Grants, outbox and join codes

- `grants_body(me, identity, group, missing) -> GrantsCall`: what a `SendGrants` answer needs.
    - `Grants { requests }` per folder, 256 a request.
    - `SyncFirst`.
    - `OpenFoldersFirst`.
- `outbox_open(group, outbox_id, user_id, entry) -> OutboxCall`.
    - `Send`, `Hold`, `Landed`, `Superseded`.
    - `Sealed`: delete it.
    - Another account's `user_id`: an `Input` error.
- `outbox_step(status, code)`.
- `entry_read` checks fields in the web's order:
    1. Version as JS `=== 1`.
    2. Non-empty id, and the kept one.
    3. Family.
    4. Staged envelope.
    5. State.
    6. A JSON-object body, as text or object.
    7. Route.
    8. Then awaiting-check, landed/superseded against the committed head, the admission's pin, committed.
- The outbox's `admits` is `{ userId, keys }`, the key commitment (`admitted_keys`, `pin_commitment`).
    - An older entry with only `fingerprint` matches a pin whose commitment it is.
    - `keys` present decides alone.
    - `""` matches nothing.
- `member_join_code(group, user_id, rosters) -> MemberJoinCode`: `Code`, `OtherKeys`, `NotAdmitted`, `SyncFirst`, `NotPinned`.
    - The join code compares `Option` key parts (`entry_is_pin`).
- Fixtures-only: `group_device_record_seal`/`_open` and `DeviceStore` (the outbox is the core's), `identity_wrap` (fixed keys into an envelope), `outbox_entry_read(value, group, id, pin, head)` and `outbox_entry_seal`.

#### Roster call fixtures

- `fixtures/outbox-steps.json` and `fixtures/roster-call-sessions.json` are hand-written and run by both twins.
- `packages/groups/src/server.test.ts` stores the family route by route and posts every body of both files: resent, and two on one head.
- `tests/common/roster_calls.rs` and `roster-calls-testkit.ts` build the same family.
    - Persons 1 to 5, a group id derived under person 1.
    - Rosters: create A1, admit 2, admit 3 with members, create A2, delete A2, create A3, rotate A3 to 2.
- They build:
    - 15 calls (5 built, 10 refused alike).
    - 2 owed-grant calls.
    - 8 join codes.
    - 13 outbox entries.
    - The session scenarios (`session_run`, `sessionRun`).
- Fuzz: kinds `outbox_entry`, `member_join_code`, `roster_call` and the stateful `roster_call_session` in `pins`.

### Calls that rotate (`roster_calls/removal.rs`)

- Twin of the worker's `groupStage` kinds `remove`, `markLeft`, `rotate` and `retire`, of `groupRestage` with `rebuild`, and of `groupPreviousRoot` (`session-groups.ts`).
- The changes go through `stage` (`Change::{Remove, MarkLeft, Rotate, Retire}`). So the caller checks, the staged chain, `call_still_holds` and the sealed entry are the same as for other calls.

#### Bodies

| Function                                                                       | Route | Notes                                                           |
| ------------------------------------------------------------------------------ | ----- | --------------------------------------------------------------- |
| `removal_body(.., user_id, rotations, ends_lapsed, account_key_version, kems)` | 19    | `ends_lapsed` rides on the route and in the body when non-empty |
| `mark_left_body(.., user_ids, rotations, account_key_version, kems)`           | 7     | None is `NOBODY_LEFT`                                           |
| `area_rotation_body(.., rotation, account_key_version, kems)`                  | 24    |                                                                 |
| `area_delete_body(.., workspace_id, kems)`                                     | 30    | The folder must be live                                         |

- All answer `RosterCall`.
- `account_key_version` is the account key's (as for `open_family_area`).
    - Each rotation's self-grant names it.
    - Never the identity's key version. A master-key rotation or a succession moves the two apart, and the server refuses it (`self-grant-key-version`).
- `StagedCall.replaced` names documents carried on empty.

#### Rotations

- The rotations must be exactly the folders to rotate (`areas_to_rotate`, or the one a key replacement names).
    - Each once (`EVERY_FOLDER`).
    - Each live (`NOT_ON_LIST`).
- Each gets a fresh area and root key: a format 2 row with its root commitment.
- The new key is granted to every member active on the staged roster.
- `rotation_wire` (the worker's `rotationOf`):
    - The root is checked: parent, `parent_key_epoch` = to-version, a folder.
    - The target epoch must be above the root's (`DRAW_EPOCH`).
    - Every document is opened under the old key and sealed for its next version as the exact text read.
    - The root's current key comes from `AreaLedger::rotation_root_key` (the worker's `currentKeyOf`): held at its epoch, else the served envelope under the area key at its wrapped version.
    - Shares or links are refused (`SHARED_IN_FAMILY`).
    - The root is re-keyed by `rekey_node_records`. An unsigned root's metadata gets signed.
    - The old key is wrapped under the previous-root label.
    - Both are opened back (`KEYS_DID_NOT_OPEN`).
- Document text (`document_plaintext`):
    - Only the padding spaces are trimmed.
    - It is judged by `serde::de::IgnoredAny`, iteratively. That takes what JSON.parse takes and a `serde_json::Value` refuses: lone surrogate escapes, numbers past an f64, any depth.
    - A `tags` document JSON.parse refuses goes on empty. Any other kind is refused.
- The self-grant is sealed under the account root at the account key version passed in.
- The entry keeps `rotationKeys` (each folder's area and root key) for a rebuild.

#### Rebuild and repair

- `outbox_rebuild(me, identity, group, outbox_id, entry, rotations) -> StagedCall`: what `OutboxStep::Rebuild` needs.
    - The entry is read as `outbox_open` reads it, and must still follow the committed chain.
    - The roster's rows must be exactly the kept keys (count and commitments).
    - Only the folders named are made again (`NOT_ROTATED_HERE`), with the same keys, roster, grants and self-grant.
- `previous_root_repair(group, workspace_id, PreviousRoot) -> PreviousRootRepair`: `None`, `Opens`, `Repair { previous_root_key_envelope }`, `Cannot`.
    - Only the device's own previous key at that epoch is ever wrapped (`own_previous_node_key`, kept by a Drive rotation's commit).
    - A served envelope that opens to anything else is no better than one that does not open.
    - An empty envelope is none, as the worker's `!root.prevKeyEnvelope` reads it.

#### Removal fixtures

- The roster-call documents carry:
    - `removalCalls`: 12 calls on person 1's device, account key 2 and identity 1. Remove a member, remove a manager, mark left, replace A3's keys, delete A1, and 7 refused alike.
    - `previousRoots`: 6 route 25 envelopes.
    - `removalRoots`: the roots and documents the calls were built from.
- Built by `tests/common/removal_calls.rs` and `removal-calls-testkit.ts` over the roster-call family.
    - Each live folder's root has an id derived from its seed and a name person 1 signed, built once per twin.
    - A1's tags include a tag named by a lone surrogate. A3 has junk.
- Each body is read by the other twin as every member reads it:
    - The call verdict.
    - Each new key from its grants (the roster commits to it).
    - The root's new key against the root commitment, the old one under its previous-root label.
    - The name, the self-grant and its account key version, and every document's text.
    - The roster's area rows exactly what the call writes.
- `packages/groups/src/server.test.ts`:
    - Stores the family with those roots, A3's walk finished, the documents, and person 1's account key at 2.
    - Posts every built body of both twins. Each lands at version 8 and replays.
    - With the account key at 1, the removal is refused (`self-grant-key-version`).
    - Refuses a removal that leaves one of two live areas unrotated (`roster-chain`), and stores nothing.
- The repair rule is held by each twin's unit tests only. A device's own previous key comes only from a Drive rotation's commit, which the fixtures do not run.
- Fuzz kinds `removal_call` and `previous_root` in `pins`, both twins.

### Settings in the ledger (`ledger_settings.rs`)

Twin of the worker's `settingsKeyOpen`/`settingsOpen` (`settingsOpenFor` in `packages/crypto/src/settings-marks.ts`) and its settings marks (`settingsMarks`, `contactPinOf`, `settingsPinOf`, `refuseDowngrade`, which `session-groups.ts` calls).

#### Opening

- `AreaLedger::use_settings_envelope(user_id, key_envelope, settings_envelope)` opens the settings key under the root `open_account` holds, and the document under it.
    - None served is "no settings" (account checked).
    - Version 1 is `legacy_settings`.
    - Version 2 needs the key envelope.
- Messages are the web's.
    - `SETTINGS_NOT_OPENED` for any AEAD failure.
    - `Invalid key encoding.` for a field that is not canonical base64url, empty included.
- A document below the highest settings version opened in this unlock is refused (`OLDER_SETTINGS`).
    - `Settings::settings_version`, decided in `set_settings` under the lock.
    - The worker's `settingsMarks` keeps the same floor.
- Settings are set under the lock only while the generation and root they were opened under are still the ledger's (`NOT_THIS_ACCOUNT`). `AFTER_OPENING_SETTINGS` is the test seam.

#### Reading the document

- The plaintext is read as the web reads it (`read_document`):
    - TextDecoder's lossy UTF-8 and BOM drop.
    - Unpaired surrogate escapes in strings are written as `\uFFFD` (`without_lone_surrogates`, twin of `withoutLoneSurrogates` in `contacts.ts`).
    - JSON.
    - Then `readSettingsDocument`'s shape: `version` the number 1 or 2, `contacts` an object, array or null.
- `groups` members are kept raw (`HeldPin::Raw`).
    - `pin_of` checks one only when acceptance reads that family's.
    - A malformed pin refuses its family only. A JSON null is none.
- `contacts` are kept in document order.
    - A custom deserializer: a repeated key keeps its first place and takes the last value.
- A contact is found as the worker's `contactPin` finds it (`contact_pin_of`).
    - The first member whose key and string `userId` both lowercase to the id.
    - Members that are no object, or have no string `userId`, are skipped, in both twins.
- `familyChecks` are read too (`Settings::checks`, `AreaLedger::family_check`).
    - A record with `code` is a pair mark. A malformed one is refused for that family (`Invalid pair mark.`).
    - One without (the migration's `before`) is a mark only.
    - `ledger_settings::family_check_of` is the one reader.

#### Fixtures-only and not exported

- `use_settings` is fixtures-only (`#[cfg(feature = "fixtures")]`).
    - It stores typed pins as `HeldPin::Typed` and converts contacts to the web's JSON.
- `settings_seal_raw` (fixtures-only) seals documents `settings_seal` refuses.
- No exported function takes a `VerifiedPin`. The record stays, as `trust_as_group_does` returns one.
- `roster_entry_new` and `area_grant_open` are not uniffi-exported.

### Opening a family folder (`area_open.rs`)

Twin of the worker's `groupOpenArea` and `grantAreaKey`/`openAreaSelfGrant`.

- `AreaLedger::open_family_area(group_id, ServedArea, account_key_version) -> FamilyAreaOpened { opened, from: AreaKeyFrom, self_grant_to_store }`.
- Checks, in the worker's order:
    1. The committed chain (`NO_CHAIN`, so held-back families open nothing).
    2. The id derived under the family.
    3. The area live.
    4. The account.
- Then the key comes from, in order:
    1. The self-grant, only when at or above both the chain's latest and the served version, listed, and of the committed key. Otherwise it is ignored.
    2. The area grant. `GRANTER_KEY_NEEDED` without the granter's served ML-DSA key. The holder identity envelope is opened under the root (`NOT_OWN_IDENTITY`).
    3. Else `NOT_CHECKED_KEYS`.
- Self-grant context: `["hushos/group/area-self-grant",1,user,group,workspace,keyVersion,workspaceKeyVersion]`, wrapped with HKDF(salt, root, `hushos/workspace/grant-wrap/v1`).
- A grant at the version both the chain and the server call current is wrapped again for route 23.
- The key is held through `open_area_in`, with the session and root re-checked under the lock (`AFTER_OPENING_AREA`).
- `area_self_grant_seal`/`_open` are fixtures-only.

#### Self-grants in a master-key rotation

- `area_self_grant_rewrap(user_id, group_id, old_root, new_root, grant, key_version)` is the twin of `rewrapAreaSelfGrant`.
    - It is `self_grant_open` then `self_grant_seal`, so there is one self-grant context and one wrapping key.
    - It is the only self-grant function over UniFFI: two roots in, a sealed grant out.
    - The opener and sealer stay fixtures-only.
- The security challenge serves each `workspaces` row with `groupId` (null for the personal workspace).
- The apps rewrap a row with one through it (`Auth.rewrapGrants` on both), never through `workspace_grant_rewrap`, which refuses a self-grant.
- Fixtures both ways: `areaSelfGrant` in `fixtures/web.json`, `rotation.areaSelfGrant` in `core.json`.

#### Settings and area fixtures

- `fixtures/settings-area-cases.json`, run by `tests/common/settings_areas.rs` and `packages/crypto/src/settings-areas-testkit.ts` into the roster-call documents (`settingsReadings`, `areaOpens`).
    - 28 settings cases on person 1's device: envelopes, contacts and group pins of every odd shape, downgrades and older documents, a lone surrogate in a contact name, then acceptance, person 4's admission and person 2's join code.
    - 18 area cases on person 2's device: self-grants current, stale, served ahead, beyond listed, of another family, folder, root or key, damaged; the granter gone; stores only at the current key.
- Each twin's envelopes and self-grants are read by the other to the same full outcomes.
- Every stored self-grant is opened by the other to the folder's key, and opens the folder there.
- Unit tests in `ledger_settings.rs` and `area_open/tests.rs` come with break-checks.
    - Known survivors: `v > listed.len()` (duplicated by the commitment lookup, which returns none past the end) and the self-grant context label (one function seals and opens; the cross-twin fixtures catch it).
- Fuzz kinds in `pins`, both twins:
    - `settings`: document text read and probed; text both JSON parsers read alike (`settings_fits`).
    - `area_open`: any self-grant envelope against the family. The self-grant branch is reached only from the seeds' sealed self-grants, since a mutated one never opens.

## Fuzzing

- `fuzz/` is a cargo-fuzz crate with its own workspace and `Cargo.lock`.
- It is built with the nightly in `fuzz/rust-toolchain.toml`.
- Targets: `canonical`, `roster`, `group_succession`, `roster_build`, `statements`, `identity`, `succession`, `share_open`, `key_seal_open`, `area_grant_open`, `key_seal_context`, `pins`, `accept`, `record_integrity`, `origin_open`, `area_ledger`.

| File                                   | Holds                                            |
| -------------------------------------- | ------------------------------------------------ |
| `fuzz/src/targets.rs`                  | The verdicts (oracles)                           |
| `fuzz/src/shape.rs`                    | The JSON shapes                                  |
| `fuzz/src/structured.rs`               | Structured inputs (`arbitrary`)                  |
| `fuzz/examples/verdicts.rs`            | The Rust side of `bun run fuzz:diff`             |
| `packages/crypto/fuzz/verdicts.ts`     | The twin: same names, same inputs, same verdicts |
| `packages/crypto/fuzz/oracles.test.ts` | Holds the TypeScript oracles to the fixtures     |

- A new parser or verifier gets a target in both twins, or a kind in `statements`/`pins`.
- The `fuzzing` feature exposes `hushos_core::fuzzing::{parse_statement, encode_statement}` for the fuzz crate only. Nothing else may use it.
    - The `fuzzing` module also has raw openers and the writer-form statement builders for `record_integrity` and `origin_open`.
- CI runs the fuzz crate's lib tests: the oracles in `fuzz/src/targets.rs` held to the fixtures. So an oracle that misjudges a known chain fails there, not only in `fuzz:diff`.

### What the targets cover

- `statements` covers the drive record statements in all four forms.
- `roster` and `roster_build` read and build both roster formats.
- `accept` carries the root probe and mutates the anchor.
- `area_ledger`: see [Area ledger fixtures](#area-ledger-fixtures).
- `succession` has kinds `consent_due` and `consent_sign`.
- `pins` has kinds `device_record`, `outbox_entry`, `member_join_code`, `roster_call`, `roster_call_session`, `removal_call`, `previous_root`, `settings`, `area_open`, `join_check`, `join_preview` (with `words` and `join`), `join_draws`, `join_session`, `pair_code` and `joins_record`.

### `pins` kinds for joining and first use

Seeded from the fixtures, both twins.

- `join_draws`: draws to positions across the twins.
- `join_session`: an arbitrary op list through both interpreters.
    - It takes every shared scenario but the one checking a showing from elsewhere.
    - Ops `first-use` and `guard`, a `guard` per sync, first use and accept, every scenario's settings. No `restore` is `false`.
    - Session rules: held positions never move until a match, a restore only holds more, the calm try and the alarm, a showing from before a lock refused, kept exactly while held, no join without a match, and one per unlock.
    - An unreadable guard never accepts.
    - A first use needs settings that hold and, over a `before` check record, another mark.
    - A guard handed back covers the held one it was given.
    - A step's `stored: false` is a failed guard write.
    - A `forget` (which passes the held guard) must hand back a guard reaching the chain committed when the held one is behind it.
- Nothing is accepted past a mark it was given: the settings pin, the guard handed, the chain committed, a first use's record.
    - "Past" means: the same first keys, the roster statements through it, and the succession statements into every key up to the one its roster is under.
    - `k` = 1 + the successions tied at or below it in the mark's own history. Later ones are allowed.
    - Never the signatures, which ML-DSA makes at random.
    - Every guard handed back is under that `k` at its roster.
    - `session_holds_mark` / `sessionHoldsMark`, held to the fixtures by a test in `fuzz/src/targets.rs` and `packages/crypto/fuzz/oracles.test.ts`.
- `settings` probes `familyChecks` per group id.
    - Probes are canonical lowercase UUIDs.
    - Both twins read `groups` and `familyChecks` only from an object.
    - `checks`: none, a mark, a pair mark, refused.
- `pair_code` works out:
    - The bare code: equal ids refused, the same with the ids swapped.
    - The chain's code as a roster-call member holding their own or another's keys: no code over keys the device does not hold, the same code when the other member works it out.
- `joins_record` seals any JSON as person 2's joins record through `device_store_seal_value` and reads it back by an acceptance joining.
    - Only version 3 or 4 of this family joins.
    - A first use only over its pin's first keys and roster, never reported checked.
    - A join mark always is.

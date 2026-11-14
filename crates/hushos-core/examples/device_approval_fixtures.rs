//! Approving on another device as this core builds it (`docs/two-step-design.md` 12), for
//! the web to match byte for byte (`packages/crypto/src/device-approval.test.ts`) and for
//! the server's own copy (`packages/db/src/signatures.test.ts`): for one request of each
//! purpose, the commitment, the code, the statement, the approving device's signature and
//! the QR text. Every value is derived from a label, so a run changes nothing unless the
//! construction did. The mirror of `packages/crypto/scripts/device-approval-fixtures.ts`;
//! writes `packages/crypto/src/__fixtures__/core-device-approval.json`. Regenerate with
//! `bun run fixtures` at the root.

use hushos_core::*;
use serde_json::json;
use sha2::{Digest as _, Sha256};
use std::fs;
use std::path::PathBuf;

fn labelled(label: &str) -> Vec<u8> {
    Sha256::digest(format!("hushos-fixture:{label}").as_bytes()).to_vec()
}

fn uuid(bytes: &[u8]) -> String {
    let mut hex: Vec<String> = bytes[..16].iter().map(|byte| format!("{byte:02x}")).collect();
    hex[6] = format!("4{}", &hex[6][1..]);
    hex[8] = format!("8{}", &hex[8][1..]);
    let text = hex.concat();
    format!("{}-{}-{}-{}-{}", &text[..8], &text[8..12], &text[12..16], &text[16..20], &text[20..])
}

fn main() {
    let mut cases = Vec::new();
    for purpose in
        ["login", "password", "master-key", "recovery-key", "delete", "two-step", "device-approval"]
    {
        let asking = device_signing_public_key(labelled(&format!("core:{purpose}:asking"))).unwrap();
        let approver_seed = labelled(&format!("core:{purpose}:approver"));
        let approver = device_signing_public_key(approver_seed.clone()).unwrap();
        // Upper case here, lower case in everything built from it: ids are compared lowercased.
        let user_id = uuid(&labelled(&format!("core:{purpose}:user"))).to_uppercase();
        let request_id = uuid(&labelled(&format!("core:{purpose}:request")));
        let step_token = base64url_encode(labelled(&format!("core:{purpose}:token")));
        let token_digest = step_token_digest(step_token.clone());
        let device_signing_key = base64url_encode(asking);
        let nonce = base64url_encode(labelled(&format!("core:{purpose}:nonce")));
        let approver_key = base64url_encode(labelled(&format!("core:{purpose}:approver-key")));
        let commitment = device_step_commitment(
            purpose.into(),
            token_digest.clone(),
            device_signing_key.clone(),
            nonce.clone(),
        )
        .unwrap();
        let step = DeviceStep {
            user_id: user_id.clone(),
            request_id: request_id.clone(),
            purpose: purpose.into(),
            token_digest: token_digest.clone(),
            device_signing_key: device_signing_key.clone(),
        };
        cases.push(json!({
            "purpose": purpose,
            "userId": user_id,
            "requestId": request_id,
            "stepToken": step_token,
            "tokenDigest": token_digest,
            "deviceSigningKey": device_signing_key,
            "nonce": nonce,
            "approverKey": approver_key,
            "commitment": commitment,
            "code": device_step_code(step.clone(), approver_key.clone(), nonce.clone()).unwrap(),
            "statement": base64url_encode(device_step_statement(step.clone()).unwrap()),
            "approver": {
                "publicKey": base64url_encode(approver),
                "signature": device_step_sign(approver_seed, step).unwrap(),
            },
            "qr": approval_qr(request_id, commitment).unwrap(),
        }));
    }
    let document = json!({
        "generatedBy": "crates/hushos-core/examples/device_approval_fixtures.rs",
        "cases": cases,
    });
    let out = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/crypto/src/__fixtures__/core-device-approval.json");
    fs::write(&out, serde_json::to_string_pretty(&document).unwrap() + "\n").expect("written");
    println!("wrote packages/crypto/src/__fixtures__/core-device-approval.json");
}

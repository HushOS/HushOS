import { mkdir, writeFile } from 'node:fs/promises';
import sodium from 'libsodium-wrappers';
import {
    approvalQr,
    deviceStepCode,
    deviceStepCommitment,
    deviceStepStatement,
} from '../src/device-approval';
import { encode } from '../src/keys';
import { stepTokenDigest } from '../src/two-step';

/*
 * Approving on another device as the web builds it (docs/two-step-design.md 12), for the Rust
 * core to match byte for byte (`crates/hushos-core/tests/device_approval_fixtures.rs`) and for
 * the server's own copy (`packages/db/src/signatures.test.ts`): for one request of each purpose,
 * the commitment, the code, the statement, the approving device's signature and the QR text.
 * Every value is derived from a label, so a run changes nothing unless the construction did.
 * Writes `crates/hushos-core/fixtures/web-device-approval.json`. Regenerate with
 * `bun run fixtures` at the root.
 */

await sodium.ready;

async function labelled(label: string, length = 32) {
    const digest = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`hushos-fixture:${label}`)),
    );
    return digest.subarray(0, length);
}
const uuid = (bytes: Uint8Array) => {
    const hex = [...bytes.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0'));
    hex[6] = `4${hex[6]![1]}`;
    hex[8] = `8${hex[8]![1]}`;
    const text = hex.join('');
    return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
};

const purposes = [
    'login',
    'password',
    'master-key',
    'recovery-key',
    'delete',
    'two-step',
    'device-approval',
];
const cases = [];
for (const purpose of purposes) {
    const asking = sodium.crypto_sign_seed_keypair(await labelled(`web:${purpose}:asking`));
    const approver = sodium.crypto_sign_seed_keypair(await labelled(`web:${purpose}:approver`));
    // Upper case here, lower case in everything built from it: ids are compared lowercased.
    const userId = uuid(await labelled(`web:${purpose}:user`)).toUpperCase();
    const requestId = uuid(await labelled(`web:${purpose}:request`));
    const stepToken = encode(await labelled(`web:${purpose}:token`));
    const tokenDigest = await stepTokenDigest(stepToken);
    const deviceSigningKey = encode(asking.publicKey);
    const nonce = encode(await labelled(`web:${purpose}:nonce`));
    const approverKey = encode(await labelled(`web:${purpose}:approver-key`));
    const commitment = await deviceStepCommitment({
        purpose,
        tokenDigest,
        deviceSigningKey,
        nonce,
    });
    const step = { userId, requestId, purpose, tokenDigest, deviceSigningKey };
    const statement = deviceStepStatement(step);
    cases.push({
        purpose,
        userId,
        requestId,
        stepToken,
        tokenDigest,
        deviceSigningKey,
        nonce,
        approverKey,
        commitment,
        code: await deviceStepCode({ ...step, approverKey, nonce }),
        statement: encode(statement),
        approver: {
            publicKey: encode(approver.publicKey),
            signature: encode(sodium.crypto_sign_detached(statement, approver.privateKey)),
        },
        qr: approvalQr({ requestId, commitment }),
    });
}

const out = new URL('../../../crates/hushos-core/fixtures/', import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(
    new URL('web-device-approval.json', out),
    JSON.stringify(
        { generatedBy: 'packages/crypto/scripts/device-approval-fixtures.ts', cases },
        null,
        2,
    ) + '\n',
);
console.log('wrote crates/hushos-core/fixtures/web-device-approval.json');

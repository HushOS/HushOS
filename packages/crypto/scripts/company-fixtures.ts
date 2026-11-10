import { mkdir, writeFile } from 'node:fs/promises';
import {
    companyCases,
    companyKeys,
    companySeals,
    refusalOf,
    sealItemVerdict,
} from '../src/company-testkit';
import { GROUP, says, verdictOf } from '../src/group-testkit';
import type { AcceptInput } from '../src/group-trust';
import type { SignedGroupStatement } from '../src/groups';
import { encode } from '../src/keys';

/*
 * A company's rosters, seals and verdicts as the web makes them, for the Rust
 * core to judge and open the same way (crates/hushos-core/tests/
 * web_company_fixtures.rs): every history of company-testkit.ts that keeps or
 * breaks an acceptance rule of docs/companies-design.md 2.1, with the web's
 * full verdict; the company key, the kit and a folder's notice keys from
 * fixed seeds; and every seal of a company's life, with a few a hostile
 * client made. Signatures and seals use fresh randomness and differ on every
 * run. Regenerate with `bun run fixtures:groups` at the repository root.
 */

const signed = (statement: SignedGroupStatement) => ({
    statement: encode(statement.statement),
    signature: {
        ed25519: encode(statement.signature.ed25519),
        mlDsa: encode(statement.signature.mlDsa),
    },
    signerSignature: encode(statement.signerSignature),
    ...(statement.kitSignature ? { kitSignature: encode(statement.kitSignature) } : {}),
});

const inputJson = (input: AcceptInput) => ({
    firstKeys: input.firstKeys,
    anchor: input.anchor,
    pins: input.pins,
    rosters: input.rosters.map(signed),
    successions: input.successions.map(signed),
    mlDsaKeys: input.mlDsaKeys,
    me: input.me,
    cache: input.cache,
    joinMark: input.joinMark ?? null,
    pairMarks: input.pairMarks ?? [],
    record: null,
    root: null,
    next: null,
});

const cases = [];
for (const c of await companyCases()) {
    // The web's own verdict first: a case the web misjudges is not written.
    const verdict = await verdictOf(c.input);
    if (!says(verdict, c.expected))
        throw new Error(`${c.name}: the web says ${JSON.stringify(verdict).slice(0, 200)}`);
    cases.push({
        name: c.name,
        input: inputJson(c.input),
        expected: verdict,
        refusal: refusalOf(c),
    });
}

const seals = await companySeals();
for (const item of seals.items) {
    const verdict = await sealItemVerdict(item, seals.chainAt);
    if (JSON.stringify(verdict) !== JSON.stringify(item.expected))
        throw new Error(`${item.name}: the web says ${JSON.stringify(verdict)}`);
}

const out = new URL('../../../crates/hushos-core/fixtures/', import.meta.url);
await mkdir(out, { recursive: true });
await writeFile(
    new URL('web-company.json', out),
    JSON.stringify(
        {
            generatedBy: 'packages/crypto/scripts/company-fixtures.ts',
            groupId: GROUP,
            keys: await companyKeys(),
            cases,
            seals: { history: inputJson(seals.history), items: seals.items },
        },
        null,
        2,
    ) + '\n',
);
console.log('wrote crates/hushos-core/fixtures/web-company.json');

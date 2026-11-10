import { mkdir, writeFile } from 'node:fs/promises';
import {
    companyCases,
    companyKeys,
    companySeals,
    refusalOf,
    sealItemVerdict,
} from '../src/company-testkit';
import {
    folderVerdictCases,
    listCaseVerdict,
    listCases,
    listStatementCases,
    listStatementVerdict,
} from '../src/company-lists-testkit';
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
 * fixed seeds; every seal of a company's life, with a few a hostile client
 * made; and the folders' lists and heads (2.3): every case of
 * company-lists-testkit.ts as a device reads it step by step, with the web's
 * verdict and the record it would keep at each step. Signatures and seals
 * use fresh randomness and differ on every run. Regenerate with
 * `bun run fixtures:groups` at the repository root.
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

// The folders' lists: one set of served ML-DSA keys for every case, and each case's history,
// heads rows, steps and the web's verdict at every step.
const listKeys: Record<string, string> = {};
const lists = [];
for (const c of await listCases()) {
    const verdict = await listCaseVerdict(c);
    if (!c.holds(verdict))
        throw new Error(`${c.name}: the web says ${JSON.stringify(verdict).slice(0, 400)}`);
    Object.assign(listKeys, c.input.mlDsaKeys);
    lists.push({
        name: c.name,
        input: { ...inputJson(c.input), mlDsaKeys: {} },
        heads: c.heads,
        steps: c.steps,
        expected: verdict,
    });
}
const statements = await listStatementCases();

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
            lists: {
                mlDsaKeys: listKeys,
                cases: lists,
                statements: statements.statements.map((c) => ({
                    ...c,
                    expected: listStatementVerdict(c.kind, c.statement),
                })),
                heads: statements.heads,
                shareLogStart: statements.shareLogStart,
                folderVerdicts: folderVerdictCases(),
            },
        },
        null,
        2,
    ) + '\n',
);
console.log('wrote crates/hushos-core/fixtures/web-company.json');

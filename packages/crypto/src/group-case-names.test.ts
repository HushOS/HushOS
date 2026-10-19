import { expect, test, vi } from 'vitest';
import core from './__fixtures__/core-groups.json';
import { groupCases } from './group-testkit';
import type * as Pq from './pq';

/*
 * The core's fixture (crates/hushos-core/examples/group_fixtures.rs) judges a
 * history for every case the web knows, so that a case added on either side
 * without `bun run fixtures` fails here. Only the names are compared, and the
 * web's cases are built here only for them: with ML-DSA left out, as signing
 * all of them in JavaScript (about 500 signatures) took 7 s on a laptop and
 * pushed group-fixtures.test.ts past its budget on CI. Without real signatures
 * nothing built here is a verdict, and none is read: the cases are judged
 * against the core's in group-fixtures.test.ts, from the core's own bytes.
 * The mock lives in this file alone.
 */
vi.mock('./pq', async (importOriginal) => {
    const pq = await importOriginal<typeof Pq>();
    return {
        ...pq,
        mlDsaSign: () => new Uint8Array(pq.ML_DSA_SIGNATURE_BYTES),
        // The builders check what they sign as they go; unsigned, that check would stop them.
        mlDsaVerify: () => true,
    };
});

test('the core judged a history for every case the web knows, and no other', async () => {
    expect(core.cases.map((entry) => entry.name)).toEqual(
        (await groupCases()).map((entry) => entry.name),
    );
});

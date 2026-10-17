import { createPolar as createPolar1026 } from '@polar-sh/sdk/2026-10';
import { attempt, loadState, polar, sandboxOptions, show } from './sandbox';

/*
 * Does the 2026-10 API path behave the same as 2026-04 for the calls groups need? Reads the
 * E2 product with both, then raises and cuts the free E3 subscription through 2026-10 and
 * compares the responses with a 2026-04 read of the same subscription.
 */
const polar1026 = createPolar1026(sandboxOptions);
const state = await loadState();

function diff(path: string, a: unknown, b: unknown, out: string[]) {
    if (
        typeof a !== typeof b ||
        Array.isArray(a) !== Array.isArray(b) ||
        (a === null) !== (b === null)
    ) {
        out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
        return;
    }
    if (a && typeof a === 'object') {
        const keys = new Set([...Object.keys(a), ...Object.keys(b as object)]);
        for (const key of keys)
            diff(
                `${path}.${key}`,
                (a as Record<string, unknown>)[key],
                (b as Record<string, unknown>)[key],
                out,
            );
        return;
    }
    if (a !== b) out.push(`${path}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

function report(label: string, a: unknown, b: unknown, ignore: RegExp = /modified_at$/) {
    const out: string[] = [];
    diff('', a, b, out);
    const relevant = out.filter((line) => !ignore.test(line.split(':')[0]!));
    show(`${label}: differences (2026-04 vs 2026-10)`, relevant);
}

const productId = state.familyMonthly as string;
report('product get', await polar.products.get(productId), await polar1026.products.get(productId));

const subId = (state.e3 as { subscription: string }).subscription;
const start = await polar.subscriptions.get(subId);
show('E3 free subscription at start', { units: start.units, pending_update: start.pending_update });
const raise = await attempt(`2026-10 raise ${start.units}→${start.units! + 1} invoice`, () =>
    polar1026.subscriptions.update(subId, {
        units: start.units! + 1,
        proration_behavior: 'invoice',
    }),
);
if (raise.ok) {
    show('2026-10 raise response', {
        units: raise.value.units,
        pending_update: raise.value.pending_update,
    });
    report('after raise', await polar.subscriptions.get(subId), raise.value, /modified_at$|^\.$/);
}
const cut = await attempt(`2026-10 cut →${start.units} next_period`, () =>
    polar1026.subscriptions.update(subId, {
        units: start.units!,
        proration_behavior: 'next_period',
    }),
);
if (cut.ok) {
    show('2026-10 cut response', {
        units: cut.value.units,
        pending_update: cut.value.pending_update,
    });
    report('after cut', await polar.subscriptions.get(subId), cut.value);
}
const below = await attempt('2026-10 cut below minimum', () =>
    polar1026.subscriptions.update(subId, { units: 5, proration_behavior: 'next_period' }),
);
if (!below.ok) show('2026-10 below-minimum error', { status: below.status, error: below.error });

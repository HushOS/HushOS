#!/usr/bin/env bun
/*
 * Measured seconds per spec file (and per serial block of the files in BLOCKS) for each browser
 * suite, from the logs of one CI run, in the shape of e2e/durations.json, which
 * scripts/e2e-shard.ts balances the shards by. Fetch a run's logs once to a file (parallel
 * fetches trip GitHub's rate limit), then print the times and copy them in:
 *
 *   gh run view <ci run> -R HushOS/HushOS --log > ci.log
 *   gh run view <webkit run> -R HushOS/HushOS --log > webkit.log
 *   bun scripts/e2e-durations.ts ci.log webkit.log
 *
 * A file's time is the sum of its tests' times as the list reporter prints them, its beforeAll
 * included (a hook's time counts toward the first test after it). A test retried is counted
 * once, at its first attempt's time. A skipped test counts nothing, but its file is listed (at the
 * least, one second), so the shards know it costs nothing rather than guessing; so is a spec file
 * the chromium or webkit logs never name (mobile.spec.ts has no WebKit tests). Read a run of the
 * tree as it is now: a spec file added since would be listed at one second.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/* Files whose serial blocks run on separate workers (mode: 'parallel'), balanced one by one. */
const BLOCKS = new Set(['families.spec.ts']);

const suiteOf = (job: string) =>
    /\(families/.test(job)
        ? 'families'
        : /\(webkit \d/.test(job)
          ? 'webkit'
          : /\(chromium \d/.test(job)
            ? 'chromium'
            : null;

const seconds = { ms: 0.001, s: 1, m: 60 } as const;
// `  ✓  12 [chromium] › e2e/drive.spec.ts:40:1 › a block › a test (3.4s)`, or `-` and no time if skipped.
const line =
    /(?:✓|✘|-)\s+\d+ \[[\w-]+\] › e2e\/([\w.-]+\.spec\.ts):\d+:\d+ › (.*?)( \(retry #\d+\))?(?: \(([\d.]+)(ms|s|m)\))?\s*$/;

const suites: Record<string, Record<string, number>> = {};
const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
    for (const entry of readFileSync(path, 'utf8').split('\n')) {
        const suite = suiteOf(entry.split('\t')[0] ?? '');
        const match = suite && line.exec(entry);
        if (!suite || !match) continue;
        const [, file, title, retry, value, unit] = match;
        const key = `${suite} ${file} ${title}`;
        if (retry || seen.has(key)) continue;
        seen.add(key);
        const block = title!.includes(' › ') ? title!.split(' › ')[0] : null;
        const unitName = BLOCKS.has(file!) && block ? `${file} › ${block}` : file!;
        const times = (suites[suite] ??= {});
        times[unitName] =
            (times[unitName] ?? 0) +
            (value ? Number(value) * seconds[unit as keyof typeof seconds] : 0);
    }
}
const specs = readdirSync(join(import.meta.dir, '..', 'e2e')).filter((file) =>
    file.endsWith('.spec.ts'),
);
for (const suite of ['chromium', 'webkit']) {
    const times = suites[suite];
    if (!times) continue;
    const named = new Set(Object.keys(times).map((unit) => unit.split(' › ')[0]));
    for (const file of specs) if (!named.has(file)) times[file] = 0;
}
const rounded = Object.fromEntries(
    Object.entries(suites).map(([suite, times]) => [
        suite,
        Object.fromEntries(
            Object.entries(times)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([unit, time]) => [unit, Math.max(1, Math.round(time))]),
        ),
    ]),
);
console.log(JSON.stringify(rounded, null, 4));

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
 * A file's time is the sum of its tests' wall times as e2e/timing-reporter.ts prints them, hooks
 * and fixtures included (the list reporter's times leave the hooks out, so a file whose
 * beforeAll uploads 300 files would weigh almost nothing). Only first attempts are printed, so a
 * retried test counts once. A skipped test counts nothing, but its file is listed (at the
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

// `e2e-time<TAB>e2e/drive.spec.ts<TAB>a block › a test<TAB>3.41`, after the job's log prefix.
const line = /\se2e-time\te2e\/([\w.-]+\.spec\.ts)\t(.*)\t([\d.]+)\s*$/;

const suites: Record<string, Record<string, number>> = {};
const seen = new Set<string>();
for (const path of process.argv.slice(2)) {
    for (const entry of readFileSync(path, 'utf8').split('\n')) {
        const suite = suiteOf(entry.split('\t')[0] ?? '');
        const match = suite && line.exec(entry);
        if (!suite || !match) continue;
        const [, file, title, value] = match;
        const key = `${suite} ${file} ${title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const block = title!.includes(' › ') ? title!.split(' › ')[0] : null;
        const unitName = BLOCKS.has(file!) && block ? `${file} › ${block}` : file!;
        const times = (suites[suite] ??= {});
        times[unitName] = (times[unitName] ?? 0) + Number(value);
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

#!/usr/bin/env bun
/*
 * The Playwright argument for one CI shard of a browser suite, balanced by measured time rather
 * than by Playwright's --shard, which splits by test count in file order: drive.spec.ts's many
 * short tests and families.spec.ts's skipped ones once made one WebKit shard take 8.5 minutes
 * beside another's 3.5.
 *
 *   bun scripts/e2e-shard.ts <chromium|webkit|families> <shard> <total>
 *
 * The units are the spec files, and the serial blocks of a file in parallel mode that
 * e2e/durations.json lists one by one (families.spec.ts). Each goes to the shard with the least
 * time so far, longest first. A spec file on disk that the suite's times leave out counts
 * DEFAULT_SECONDS, so a new file lands where there is room; a block they leave out runs on the
 * shard with the least time, which runs everything the others don't list. Refresh the times
 * (scripts/e2e-durations.ts) when a job drifts a minute or more past the others, or after
 * splitting a file. Each shard runs two workers, so a unit longer than half a shard's time
 * sets that shard's length: split the file rather than add shards.
 */
import { readdirSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import durations from '../e2e/durations.json';

/* What a spec file the measured times don't list yet is taken to cost. */
const DEFAULT_SECONDS = 60;

const [suite, shardArg, totalArg] = process.argv.slice(2);
const shard = Number(shardArg);
const total = Number(totalArg);
const fail = (message: string) => {
    console.error(message);
    process.exit(1);
};
if (suite !== 'chromium' && suite !== 'webkit' && suite !== 'families')
    fail(`unknown suite ${suite}: chromium, webkit or families`);
if (!Number.isInteger(total) || total < 1) fail(`the total ${totalArg} is not a shard count`);
if (!Number.isInteger(shard) || shard < 1 || shard > total)
    fail(`shard ${shardArg} is not between 1 and ${total}`);

const e2e = join(import.meta.dir, '..', 'e2e');
const specs = readdirSync(e2e).filter((file) => file.endsWith('.spec.ts'));
const times: Record<string, number> = durations[suite as 'chromium' | 'webkit' | 'families'];
const fileOf = (unit: string) => unit.split(' › ')[0]!;
// A listed file that no longer exists would quietly move its tests to the catch-all shard.
for (const unit of Object.keys(times))
    if (!specs.includes(fileOf(unit)))
        fail(
            `e2e/durations.json lists ${unit} for ${suite}, but e2e/${fileOf(unit)} does not exist`,
        );

const units = new Map(Object.entries(times));
// The families job names its own files; the other suites run every spec file.
if (suite !== 'families') {
    const listed = new Set([...units.keys()].map(fileOf));
    for (const file of specs) if (!listed.has(file)) units.set(file, DEFAULT_SECONDS);
}

const shards = Array.from({ length: total }, () => ({ time: 0, units: [] as string[] }));
const longestFirst = [...units].sort(([a, x], [b, y]) => y - x || a.localeCompare(b));
for (const [unit, time] of longestFirst) {
    const least = shards.reduce((best, next) => (next.time < best.time ? next : best));
    least.time += time;
    least.units.push(unit);
}
// The shard with the least time (the last of equals) also runs whatever no shard lists.
const catchAll = shards.reduce((best, next) => (next.time <= best.time ? next : best));

for (const [index, { time, units }] of shards.entries())
    console.error(
        `${suite} ${index + 1}/${total}: ${Math.round(time)} s in ${units.length} units${shards[index] === catchAll ? ', and anything unlisted' : ''}`,
    );

const list = join(mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'e2e-shard-')), 'tests');
const mine = shards[shard - 1]!;
if (mine === catchAll) {
    writeFileSync(list, shards.flatMap((other) => (other === mine ? [] : other.units)).join('\n'));
    console.log(`--test-list-invert=${list}`);
} else {
    writeFileSync(list, mine.units.join('\n'));
    console.log(`--test-list=${list}`);
}

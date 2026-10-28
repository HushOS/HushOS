/*
 * CI's `bun install --frozen-lockfile`, with a time limit on each attempt. A cold install
 * on a runner takes about 5 seconds, but now and then one stalls after
 * `Resolved, downloaded and extracted [2]` and prints nothing more: on 2026-10-28 one
 * hung 40 minutes on main and one took 39 minutes on a branch, on runners whose other
 * jobs installed in 4 seconds. Bun puts no limit on a stalled download, so an attempt
 * that passes LIMIT_MS is stopped and tried again from where it got to, the later
 * attempts with --verbose so the log shows the request that stalls. An install that
 * fails for any other reason, such as an out-of-date lockfile, fails at once.
 */
const ATTEMPTS = 3;
const LIMIT_MS = 4 * 60_000;

for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const args = ['install', '--frozen-lockfile', ...(attempt > 1 ? ['--verbose'] : [])];
    const install = Bun.spawn([process.execPath, ...args], {
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: LIMIT_MS,
        killSignal: 'SIGKILL',
    });
    const code = await install.exited;
    if (code === 0) process.exit(0);
    if (!install.signalCode) process.exit(code);
    console.error(
        `::warning title=bun install stalled::Attempt ${attempt} of ${ATTEMPTS} ran past ${LIMIT_MS / 60_000} minutes and was stopped.`,
    );
}
process.exit(1);

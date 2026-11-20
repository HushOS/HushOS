import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/*
 * Prints each test's wall time on CI, for scripts/e2e-durations.ts to weigh the shards by. The
 * list reporter's time leaves out the hooks: a test after a 1.6-second beforeAll prints (1ms),
 * so long-list.spec.ts's 300-file upload and the families blocks' accounts would weigh nothing.
 * A result's startTime is taken before its hooks run, so the span from it to the end of the test
 * counts the beforeAll, beforeEach, fixtures and afterEach along with the body.
 *
 *   e2e-time<TAB>e2e/drive.spec.ts<TAB>a block › a test<TAB>3.41
 *
 * Only the first attempt is printed, and a skipped test prints 0.
 */
export default class TimingReporter implements Reporter {
    printsToStdio() {
        return false;
    }

    onTestEnd(test: TestCase, result: TestResult) {
        if (result.retry > 0) return;
        const [, , file, ...titles] = test.titlePath();
        const seconds =
            result.status === 'skipped' ? 0 : (Date.now() - result.startTime.getTime()) / 1000;
        console.log(`e2e-time\te2e/${file}\t${titles.join(' › ')}\t${seconds.toFixed(2)}`);
    }
}

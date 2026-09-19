import { execFileSync } from 'node:child_process';

/*
 * A full run registers more accounts than sign-up lets one address have in an
 * hour (twenty verification emails), and the buckets outlive the run, so they
 * are emptied before the suite starts. The operators the reports specs promote
 * outlive it too, and a report is sealed to every current operator, so past
 * runs' operators are demoted as well; nothing else in the database is touched.
 * Against another server (E2E_BASE_URL) the database is not ours to reach.
 */
export default function globalSetup() {
    if (process.env.E2E_BASE_URL) return;
    try {
        execFileSync(
            'docker',
            [
                'compose',
                '-f',
                'compose.yaml',
                '-f',
                'compose.dev.yaml',
                'exec',
                '-T',
                'db',
                'sh',
                '-c',
                'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "delete from auth_rate_limits" -c "update users set role = \'member\' where role = \'admin\' and email like \'e2e-%@hushos.local\'"',
            ],
            { stdio: ['ignore', 'ignore', 'inherit'] },
        );
    } catch {
        console.warn(
            'Could not reset auth_rate_limits and past operators; a long run may hit the verification email limit or the operator cap.',
        );
    }
}

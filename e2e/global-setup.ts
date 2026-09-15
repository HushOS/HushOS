import { execFileSync } from 'node:child_process';

/*
 * A full run registers more accounts than sign-up lets one address have in an
 * hour (twenty verification emails), and the buckets outlive the run. They are
 * emptied before the suite starts; nothing else in the database is touched.
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
                'psql -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "delete from auth_rate_limits"',
            ],
            { stdio: ['ignore', 'ignore', 'inherit'] },
        );
    } catch {
        console.warn(
            'Could not clear auth_rate_limits; a long run may hit the verification email limit.',
        );
    }
}

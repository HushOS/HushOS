import { resealTwoStepSecrets } from '@hushos/auth/two-step-keys';
import { createLogger, sanitizeFailure } from '@hushos/logging';
import type { Job } from 'pg-boss';
import type { JobPayloads, queues } from '../client';

/*
 * After a rotation of the two-step key (docs/two-step-design.md 8): every authenticator
 * secret still sealed under an older key (TWO_STEP_PREVIOUS_KEY, or the key derived from the
 * OPAQUE setup) is opened with that key and sealed again under the current one, so the older
 * key can be dropped at the next rotation. The worker builds its keys as the web service does,
 * from the same settings (TWO_STEP_KEY, TWO_STEP_PREVIOUS_KEY or their files, and the OPAQUE
 * setup from the environment or the database), and moves nothing until the web service has
 * said it seals under the same current key.
 *
 * Backup codes are not touched: the server never holds one in plain text, so a set stays
 * under the key it was hashed with until its owner makes a new one.
 *
 * Each run is one wide event, with counts and key ids only (a key's id is the first 8 bytes
 * of its SHA-256). Nothing a key or a secret is made of is logged. An operator reads it to
 * know a rotation has finished: `reseal: 'done'` with nothing in `left`.
 */
export async function twoStepReseal(job: Job<JobPayloads[typeof queues.twoStepReseal]>) {
    const event = createLogger({ job: { id: job.id, queue: job.name } });
    const started = performance.now();
    try {
        const run = await resealTwoStepSecrets({
            batchSize: job.data.batchSize,
            signal: job.signal,
        });
        const durationMs = Math.round(performance.now() - started);
        // Field names avoid the word the log's redaction removes; ids are not secrets.
        if (run.status === 'no-key') event.set({ twoStep: { reseal: 'no-key' }, durationMs });
        else if (run.status === 'waiting')
            event.set({
                twoStep: {
                    reseal: 'waiting',
                    sealedWith: run.sealedWith,
                    webSealsWith: run.webSealsWith,
                },
                durationMs,
            });
        else {
            const left = Object.values(run.left).reduce((sum, count) => sum + count, 0);
            event.set({
                twoStep: {
                    reseal: 'done',
                    sealedWith: run.sealedWith,
                    moved: run.moved,
                    changed: run.changed,
                    unopened: run.unopened,
                    unknown: run.unknown,
                    left,
                    leftUnder: run.left,
                    backupCodesUnder: run.backupCodes,
                },
                durationMs,
            });
            // Rows nobody here can move are the operator's to act on: a key to put back, or damage.
            if (run.unopened || Object.keys(run.unknown).length)
                event.warn(
                    'Some authenticator secrets were not re-sealed: this worker lacks their key, or they did not open under it.',
                );
        }
        return run;
    } catch (error) {
        if (error instanceof Error) event.error(error);
        event.set({ failure: sanitizeFailure(error) });
        throw error;
    } finally {
        event.emit();
    }
}

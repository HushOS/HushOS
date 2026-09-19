import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const endpoint = z.url().refine((value) => {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.search && !url.hash;
}, 'Use an http(s) endpoint URL without a query or fragment.');
const bucket = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Use a valid bucket name.');
const flag = z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true');

// 8 MiB parts and S3's 10,000-part ceiling put the hard cap just under 80 GiB.
const MAX_FILE_CEILING = 10_000n * 8n * 1024n * 1024n;

/*
 * The primary object store, needed by the web app and the worker. Any S3-compatible
 * store works; MinIO locally, R2 for the hosted service. Nothing here is optional:
 * without a store there is no Drive.
 */
export const storageEnv = createEnv({
    server: {
        STORAGE_ENDPOINT: endpoint,
        // Where the server itself reaches the store when that differs from the URL browsers
        // use: the bundled MinIO is `http://minio:9000` inside Compose. Presigned URLs keep
        // STORAGE_ENDPOINT. Unset, the server uses STORAGE_ENDPOINT for everything.
        STORAGE_INTERNAL_ENDPOINT: endpoint.optional(),
        STORAGE_REGION: z.string().min(1).max(64).default('auto'),
        STORAGE_BUCKET: bucket,
        STORAGE_ACCESS_KEY_ID: z.string().min(1).max(256),
        STORAGE_SECRET_ACCESS_KEY: z.string().min(1).max(256),
        STORAGE_FORCE_PATH_STYLE: flag,
        // The provider's infrequent-access class name for the tiering job, for
        // example STANDARD_IA on R2 and AWS; unset, the job does nothing.
        STORAGE_COLD_CLASS: z
            .string()
            .regex(/^[A-Z_]{1,32}$/, 'Use the storage class name as the S3 API spells it.')
            .optional(),
        // After a database restore: the orphan sweep stays paused until this
        // moment, so objects the restored database forgot are not destroyed first.
        DRIVE_ORPHAN_SWEEP_PAUSED_UNTIL: z.iso.datetime({ offset: true }).optional(),
        // The oldest client the server still serves, per client name, as
        // "web/1,cli/0.4". A client below its minimum gets 426 and told to update.
        DRIVE_CLIENT_MINIMUMS: z
            .string()
            .regex(
                /^[a-z][a-z0-9-]{0,31}\/[0-9]+(\.[0-9]+){0,3}(,[a-z][a-z0-9-]{0,31}\/[0-9]+(\.[0-9]+){0,3})*$/,
                'Use name/version pairs separated by commas, for example web/1,cli/0.4.',
            )
            .optional(),
        DRIVE_MAX_FILE_BYTES: z
            .string()
            .regex(/^[0-9]{1,16}$/)
            .default(String(32n * 1024n * 1024n * 1024n))
            .transform(BigInt)
            .refine((value) => value >= 1n && value <= MAX_FILE_CEILING, {
                message: 'DRIVE_MAX_FILE_BYTES must be between 1 and 83886080000.',
            }),
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});

/* The replica bucket. Worker only; all-or-nothing, and without it replication is off. */
export const storageReplicaEnv = createEnv({
    server: {
        STORAGE_REPLICA_ENDPOINT: endpoint.optional(),
        STORAGE_REPLICA_REGION: z.string().min(1).max(64).optional(),
        STORAGE_REPLICA_BUCKET: bucket.optional(),
        STORAGE_REPLICA_ACCESS_KEY_ID: z.string().min(1).max(256).optional(),
        STORAGE_REPLICA_SECRET_ACCESS_KEY: z.string().min(1).max(256).optional(),
        STORAGE_REPLICA_FORCE_PATH_STYLE: flag,
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});

/*
 * The evidence bucket: where the worker keeps a copy of what was reported, so a
 * report outlives the owner's deletions and the hold. Worker only; all-or-nothing,
 * and without it the hold on the primary bucket is the only preservation.
 */
export const storageEvidenceEnv = createEnv({
    server: {
        STORAGE_EVIDENCE_ENDPOINT: endpoint.optional(),
        STORAGE_EVIDENCE_REGION: z.string().min(1).max(64).optional(),
        STORAGE_EVIDENCE_BUCKET: bucket.optional(),
        STORAGE_EVIDENCE_ACCESS_KEY_ID: z.string().min(1).max(256).optional(),
        STORAGE_EVIDENCE_SECRET_ACCESS_KEY: z.string().min(1).max(256).optional(),
        STORAGE_EVIDENCE_FORCE_PATH_STYLE: flag,
    },
    runtimeEnv: process.env,
    emptyStringAsUndefined: true,
});

export function evidenceConfigured() {
    const env = storageEvidenceEnv;
    const set = [
        env.STORAGE_EVIDENCE_ENDPOINT,
        env.STORAGE_EVIDENCE_BUCKET,
        env.STORAGE_EVIDENCE_ACCESS_KEY_ID,
        env.STORAGE_EVIDENCE_SECRET_ACCESS_KEY,
    ].filter(Boolean).length;
    if (set !== 0 && set !== 4)
        throw new Error(
            'Set all of STORAGE_EVIDENCE_ENDPOINT, STORAGE_EVIDENCE_BUCKET, STORAGE_EVIDENCE_ACCESS_KEY_ID and STORAGE_EVIDENCE_SECRET_ACCESS_KEY, or none of them.',
        );
    return set === 4;
}

export function replicaConfigured() {
    const env = storageReplicaEnv;
    const set = [
        env.STORAGE_REPLICA_ENDPOINT,
        env.STORAGE_REPLICA_BUCKET,
        env.STORAGE_REPLICA_ACCESS_KEY_ID,
        env.STORAGE_REPLICA_SECRET_ACCESS_KEY,
    ].filter(Boolean).length;
    if (set !== 0 && set !== 4)
        throw new Error(
            'Set all of STORAGE_REPLICA_ENDPOINT, STORAGE_REPLICA_BUCKET, STORAGE_REPLICA_ACCESS_KEY_ID and STORAGE_REPLICA_SECRET_ACCESS_KEY, or none of them.',
        );
    return set === 4;
}

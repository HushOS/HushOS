// Bootstraps the bundled Garage for HushOS Drive through its admin API, and is safe to run
// on every start: the single-node layout, the access key from STORAGE_ACCESS_KEY_ID and
// STORAGE_SECRET_ACCESS_KEY, the bucket, browser CORS for APP_ORIGIN, and a rule that aborts
// multipart uploads left incomplete for 3 days, behind the worker's own expiry job.
const admin = process.env.GARAGE_ADMIN_URL ?? 'http://garage:3903';
const authorization = `Bearer ${required('GARAGE_ADMIN_TOKEN')}`;
const accessKeyId = required('STORAGE_ACCESS_KEY_ID');
const secretAccessKey = required('STORAGE_SECRET_ACCESS_KEY');
const bucket = required('STORAGE_BUCKET');
const origin = new URL(required('APP_ORIGIN')).origin;

if (accessKeyId.length < 8)
    fail(`STORAGE_ACCESS_KEY_ID must be at least 8 characters for Garage; bun run setup sets one.`);
if (secretAccessKey.length < 16) fail('STORAGE_SECRET_ACCESS_KEY must be at least 16 characters.');

type Node = { id: string; dataPartition?: { total: number } | null };

const status = await get<{ layoutVersion: number; nodes: Node[] }>('GetClusterStatus');
if (!status) fail('Garage has no cluster status.');
if (status.layoutVersion === 0) {
    const [node] = status.nodes;
    if (!node) fail('Garage reports no node.');
    // Offer the whole disk; with one node the capacity only has to be non-zero.
    const capacity = node.dataPartition?.total ?? 1024 ** 4;
    await post('UpdateClusterLayout', {
        roles: [{ id: node.id, zone: 'dc1', capacity, tags: [] }],
    });
    await post('ApplyClusterLayout', { version: 1 });
    console.info('Assigned the single-node layout.');
}

const key = await get<{ secretAccessKey?: string }>(
    `GetKeyInfo?id=${encodeURIComponent(accessKeyId)}&showSecretKey=true`,
);
// Garage can neither change a key's secret nor reuse a deleted key's identifier.
if (key && key.secretAccessKey !== secretAccessKey)
    fail(
        `Key ${accessKeyId} already exists with another secret. To rotate it, set a new STORAGE_ACCESS_KEY_ID with the new secret.`,
    );
if (!key) await post('ImportKey', { accessKeyId, secretAccessKey, name: 'hushos' });

const existing = await get<{ id: string }>(
    `GetBucketInfo?globalAlias=${encodeURIComponent(bucket)}`,
);
const { id } = existing ?? (await post<{ id: string }>('CreateBucket', { globalAlias: bucket }));
await post('AllowBucketKey', {
    bucketId: id,
    accessKeyId,
    permissions: { read: true, write: true, owner: true },
});
await post(`UpdateBucket?id=${id}`, {
    // Browsers PUT parts and GET ranges straight from the bucket and read each part's ETag.
    corsRules: [
        {
            AllowedOrigin: [origin],
            AllowedMethod: ['GET', 'PUT', 'HEAD'],
            AllowedHeader: ['*'],
            ExposeHeader: ['ETag'],
            MaxAgeSeconds: 3600,
        },
    ],
    lifecycleRules: [
        {
            ID: 'abort-incomplete-uploads',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 3 },
        },
    ],
});
console.info(`Bucket ${bucket} is ready for ${origin}.`);

/* A 404 comes back as null: the key or bucket does not exist yet. */
async function get<T>(path: string): Promise<T | null> {
    const response = await fetch(`${admin}/v2/${path}`, { headers: { authorization } });
    if (response.status === 404) return null;
    return (await read(path, response)) as T;
}

async function post<T = unknown>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${admin}/v2/${path}`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return (await read(path, response)) as T;
}

async function read(path: string, response: Response): Promise<unknown> {
    if (!response.ok) fail(`${path.split('?')[0]}: ${response.status} ${await response.text()}`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

function required(name: string): string {
    const value = process.env[name];
    if (!value) fail(`${name} is not set. Run bun run setup first.`);
    return value;
}

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

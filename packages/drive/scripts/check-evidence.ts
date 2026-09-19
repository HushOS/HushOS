import { randomUUID } from 'node:crypto';
import { evidenceStore } from '../src/storage';

/*
 * Proves the evidence store works from the worker's code path with the
 * worker's credentials: write an object, see it, presign it, fetch it through
 * the presigned URL, delete it. Prints pass or fail per step and never the
 * credentials. Run from the repository root with the root .env loaded:
 *   bun --env-file=.env run --cwd packages/drive check:evidence
 */
const store = evidenceStore();
if (!store) {
    console.error('No evidence store configured: set the four STORAGE_EVIDENCE_* variables.');
    process.exit(2);
}
const key = `reports/check-${randomUUID()}/probe`;
const body = new TextEncoder().encode(`hushos evidence check ${new Date().toISOString()}`);
let failed = false;
async function step(name: string, work: () => Promise<string | void>) {
    try {
        const detail = await work();
        console.log(`pass  ${name}${detail ? `  (${detail})` : ''}`);
    } catch (error) {
        failed = true;
        const message = error instanceof Error ? error.message : String(error);
        console.log(`FAIL  ${name}  ${message}`);
    }
}
await step('write', async () => {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await store.client.send(
        new PutObjectCommand({
            Bucket: store.bucket,
            Key: key,
            Body: body,
            ContentLength: body.length,
        }),
    );
});
await step('head', async () => {
    const found = await store.head(key);
    if (!found || found.size !== body.length) throw new Error('object missing or wrong size');
    return `${found.size} bytes`;
});
await step('list', async () => {
    const page = await store.list('reports/', null, 10);
    if (!page.objects.some((o) => o.key === key)) throw new Error('not in the listing');
});
await step('presign and fetch', async () => {
    const url = await store.presignGet(key, 60);
    const response = await fetch(url, { headers: { Range: 'bytes=0-15' } });
    if (response.status !== 206 && response.status !== 200)
        throw new Error(`GET returned ${response.status}`);
    const text = await response.text();
    if (!text.startsWith('hushos')) throw new Error('unexpected body');
    return `${response.status}, ranges ${response.headers.get('accept-ranges') ?? 'unknown'}`;
});
await step('delete', async () => {
    await store.delete(key);
    if (await store.head(key)) throw new Error('still present after delete (object lock?)');
});
console.log(failed ? '\nSome steps failed.' : '\nThe evidence store works with these credentials.');
process.exit(failed ? 1 : 0);

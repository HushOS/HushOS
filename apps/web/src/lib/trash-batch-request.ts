import { readCapped } from '@/lib/read-capped';

/*
 * The edge of the batch trash, restore and purge routes: the body is read whole under
 * a cap before anything parses it. MAX_TRASH_BATCH ids are about 7.8 KB of
 * JSON (`{"nodeIds":[...]}`, 39 bytes an id), and nothing larger is one.
 */
export const TRASH_BATCH_BODY_BYTES = 12 * 1024;
const TRASH_BATCH_PATH = /^\/api\/drive\/workspaces\/[^/]+\/(trash|restore|purge)-batch\/?$/;

/*
 * For a batch request: the request again, its body read under the cap, or a
 * 413 when the body runs past it. Null for any other request, which goes on as
 * it came.
 */
export async function boundTrashBatch(request: Request): Promise<Request | Response | null> {
    if (request.method !== 'POST' || !TRASH_BATCH_PATH.test(new URL(request.url).pathname))
        return null;
    const body = await readCapped(request, TRASH_BATCH_BODY_BYTES);
    if (!body)
        return Response.json(
            { message: 'Request is too large.', code: 'too-large' },
            { status: 413 },
        );
    return new Request(request.url, { method: request.method, headers: request.headers, body });
}

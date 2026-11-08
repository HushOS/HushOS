import { readCapped } from '@/lib/read-capped';

/*
 * Every write to the API outside /api/auth (its own caps, in api.server.ts) and /api/groups and
 * /api/invitations (lib/group-requests.ts) is read whole under a cap at the edge, before anything
 * parses it: Elysia parses and validates a body before any sign-in check runs, so without this an
 * anonymous client could make the server buffer whatever it sends (Bun's default is 128 MiB).
 *
 * Each cap sits well above the largest body a client sends, worked out from the route's schema
 * and from what the web, iOS and Android clients batch.
 */
const KiB = 1024;
const MiB = 1024 * KiB;

/* Every other body: the largest is about 15 KB (an affiliate's notes, every character escaped). */
export const DEFAULT_BODY_BYTES = 64 * KiB;

/* MAX_TRASH_BATCH ids are about 7.8 KB of JSON (`{"nodeIds":[...]}`, 39 bytes an id). */
export const TRASH_BATCH_BODY_BYTES = 12 * KiB;

/* The rotation cap is read only for a signed-in account, so a stranger can't send megabytes. */
export const ROTATION_BODY_BYTES = 16 * MiB;

type Cap = { method: string; path: RegExp; bytes: number; signedInFirst?: boolean };

/* The routes whose bodies run past the default, each with why. Paths without /api; first match wins. */
export const BODY_CAPS: readonly Cap[] = [
    {
        method: 'POST',
        path: /^\/drive\/workspaces\/[^/]+\/(trash|restore|purge)-batch$/,
        bytes: TRASH_BATCH_BODY_BYTES,
    },
    // 64 folders of a folder upload, about 1.2 KB each; the schema allows about 404 KB.
    { method: 'POST', path: /^\/drive\/folders$/, bytes: 512 * KiB },
    // One key envelope per operator, up to 500: about 870 KB at most, a few KB in practice.
    { method: 'POST', path: /^\/drive\/reports$/, bytes: 1 * MiB },
    { method: 'POST', path: /^\/admin\/reports\/[^/]+\/keys$/, bytes: 1 * MiB },
    // Every part of an upload in one call: 10,000 parts' ETags, about 670 KB for an 80 GiB file.
    { method: 'POST', path: /^\/drive\/uploads\/[^/]+\/complete$/, bytes: 2 * MiB },
    // A sealed workspace document may be up to 1 MiB of plaintext: 1.33 MiB in Base64url.
    { method: 'PUT', path: /^\/drive\/workspaces\/[^/]+\/documents\/[^/]+$/, bytes: 1.5 * MiB },
    // A rotation work page, 200 nodes with their versions and shares: about 400 KB typically,
    // megabytes for files with many versions or shares.
    {
        method: 'POST',
        path: /^\/drive\/nodes\/[^/]+\/rotation\/nodes$/,
        bytes: ROTATION_BODY_BYTES,
        signedInFirst: true,
    },
];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/* The cap for a request, by method and path (with or without /api, trailing slashes ignored). */
export function bodyCap(method: string, pathname: string) {
    const path = pathname.replace(/^\/api(?=\/)/, '').replace(/\/+$/, '') || '/';
    return (
        BODY_CAPS.find((cap) => cap.method === method && cap.path.test(path)) ?? {
            method,
            path: /.*/,
            bytes: DEFAULT_BODY_BYTES,
        }
    );
}

const tooLarge = () =>
    Response.json({ message: 'Request is too large.', code: 'too-large' }, { status: 413 });

/*
 * For a write: the request again, its body read under its route's cap; a 413 when the body runs
 * past it (refused before reading when Content-Length already says so); or a 401 when the route's
 * cap is only for a signed-in account and `signedIn` says there is none. A read goes on as it came.
 */
export async function boundBody(
    request: Request,
    signedIn: () => Promise<boolean>,
): Promise<Request | Response> {
    if (SAFE_METHODS.has(request.method)) return request;
    const cap = bodyCap(request.method, new URL(request.url).pathname);
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > cap.bytes) {
        await request.body?.cancel();
        return tooLarge();
    }
    if (cap.signedInFirst && !(await signedIn())) {
        await request.body?.cancel();
        return Response.json(
            { message: 'Sign in to open Drive.', code: 'forbidden' },
            { status: 401 },
        );
    }
    const body = await readCapped(request, cap.bytes);
    if (!body) return tooLarge();
    return new Request(request.url, { method: request.method, headers: request.headers, body });
}

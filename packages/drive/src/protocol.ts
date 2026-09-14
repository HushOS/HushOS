/*
 * Constants shared by the server, the browser client and native clients. Anything
 * a client could hardcode is also reported by `GET /api/drive/capabilities`, so a
 * client built against one release can notice when the server moved.
 */
export {
    CHUNK_SIZE,
    CHUNK_TAG_BYTES,
    CONTENT_SUITE,
    LEGACY_CONTENT_SUITE,
    READABLE_CONTENT_SUITES,
    DRIVE_ENVELOPE_SUITE,
    KEY_ENVELOPE_BYTES,
    VERSION_ENVELOPE_BYTES,
    THUMBNAIL_MAX_BYTES,
    NAME_MAX_CODE_POINTS,
    METADATA_MAX_BYTES,
} from '@hushos/crypto/drive';

/* 2: the thumbnail is a trailer of the object and the version envelope carries the sizes. */
export const DRIVE_PROTOCOL_VERSION = 2;
export const MAX_DEPTH = 64;
export const ANCESTOR_WALK_CAP = 128;
export const TOMBSTONE_DAYS = 90;
export const TRASH_RETENTION_DAYS = 30;
export const UPLOAD_TTL_HOURS = 24;
export const PART_URL_TTL_SECONDS = 60 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 60 * 60;
export const SHARE_URL_TTL_SECONDS = 15 * 60;
export const LISTING_PAGE_SIZE = 500;
export const MAX_PART_URLS_PER_REQUEST = 64;
export const MAX_FOLDER_BATCH = 64;
export const THUMBNAIL_BATCH = 100;

/* The name a client shows for the root; never stored, the root's metadata names it. */
export const ROOT_NAME = 'Drive';

export type Capabilities = {
    protocolVersion: number;
    /* Suites the server accepts uploads in; older ones it stores are still served. */
    contentSuites: number[];
    envelopeSuites: number[];
    chunkSize: number;
    maxFileBytes: string; // decimal string, bigint on both sides
    maxDepth: number;
    nameMaxCodePoints: number;
    tombstoneDays: number;
    trashRetentionDays: number;
};

/* An error a client can act on; the message is shown to the person as is. */
export type DriveErrorCode =
    | 'not-found'
    | 'conflict'
    | 'stale'
    | 'parent-trashed'
    | 'trashed'
    | 'cycle'
    | 'too-deep'
    | 'over-quota'
    | 'too-large'
    | 'unsupported'
    | 'invalid'
    | 'expired'
    | 'rotating'
    | 'forbidden';

/* ------------------------------------------------------------------------- */
/* The client header                                                          */
/* ------------------------------------------------------------------------- */

/*
 * Every request to Drive carries `HushOS-Client: <name>/<version>`, and the
 * server refuses a client below the operator's configured minimum for that
 * name with 426 and a message that names the fix. A native client cannot be
 * redeployed, so this is how an old CLI or file provider learns it must update
 * instead of failing on a shape it no longer understands. Pure functions; the
 * API layer turns a refusal into the response.
 */

export const CLIENT_HEADER = 'HushOS-Client';

export type ClientIdentity = { name: string; version: string };

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const VERSION = /^[0-9]+(\.[0-9]+){0,3}$/;

/* "web/1.2" -> { name, version }; anything else is null. */
export function parseClientHeader(value: string | null | undefined): ClientIdentity | null {
    if (!value) return null;
    const slash = value.indexOf('/');
    if (slash <= 0) return null;
    const name = value.slice(0, slash).trim().toLowerCase();
    const version = value.slice(slash + 1).trim();
    if (!NAME.test(name) || !VERSION.test(version)) return null;
    return { name, version };
}

/* Dotted numeric versions, segment by segment; "1.10" is newer than "1.9". */
export function compareVersions(a: string, b: string) {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff < 0 ? -1 : 1;
    }
    return 0;
}

/* "web/1,cli/0.4" -> Map; the env schema has already checked the shape. */
export function parseMinimums(value: string | null | undefined) {
    const minimums = new Map<string, string>();
    for (const pair of (value ?? '').split(',')) {
        const parsed = parseClientHeader(pair);
        if (parsed) minimums.set(parsed.name, parsed.version);
    }
    return minimums;
}

export type ClientCheck =
    | { ok: true; client: ClientIdentity }
    | { ok: false; status: 400 | 426; message: string };

/*
 * What to do with one request. A missing or malformed header is a client bug
 * (400); a version below the minimum is a client that must update (426). A
 * client name with no configured minimum is served whatever its version.
 */
export function checkClient(
    header: string | null | undefined,
    minimums: ReadonlyMap<string, string>,
): ClientCheck {
    const client = parseClientHeader(header);
    if (!client)
        return {
            ok: false,
            status: 400,
            message: `Send a ${CLIENT_HEADER} header of the form name/version.`,
        };
    const minimum = minimums.get(client.name);
    if (minimum !== undefined && compareVersions(client.version, minimum) < 0)
        return {
            ok: false,
            status: 426,
            message:
                client.name === 'web'
                    ? 'This version of HushOS is out of date. Reload the page to update.'
                    : `Update ${client.name} to version ${minimum} or later to keep using Drive.`,
        };
    return { ok: true, client };
}

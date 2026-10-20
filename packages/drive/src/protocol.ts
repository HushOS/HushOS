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
    DOCUMENT_ENVELOPE_MAX_BYTES,
    DOCUMENT_MAX_BYTES,
    METADATA_MAX_BYTES,
} from '@hushos/crypto/drive';
export { LINK_KDF_VERSION, LINK_PASSWORD_MIN_LENGTH } from '@hushos/crypto/links';
import { DOCUMENT_ENVELOPE_MAX_BYTES } from '@hushos/crypto/drive';

/*
 * What one workspace may keep in sealed documents (docs/drive-design.md,
 * "Sealed workspace documents"), personal or group area alike: at most 8
 * kinds, and stored envelopes of at most two documents at the largest size
 * (2 MiB and 80 bytes) between them. Every client writes one kind today, the
 * tags registry, so this is room to grow, not a squeeze. The bound matters in
 * a group area: every rotation of the area carries all its documents again,
 * re-sealed, in the roster call, so whatever members may store here is what a
 * roster body must make room for (docs/groups-server.md 4, "Body caps"), ten
 * areas over.
 */
export const WORKSPACE_DOCUMENT_KINDS = 8;
/*
 * The document kinds the server stores: what shipped clients write, and
 * nothing else, so no member can plant a kind other clients do not know (a
 * group area's rotation must carry every kind the area holds). Widen this when
 * a client ships a new kind, before that client is released; never narrow it
 * while any workspace holds the kind. The limits above stay as the backstop.
 */
export const DOCUMENT_KINDS: readonly string[] = ['tags'];
export const WORKSPACE_DOCUMENT_BYTES = 2 * DOCUMENT_ENVELOPE_MAX_BYTES;

/*
 * 2: the thumbnail is a trailer of the object and the version envelope carries the sizes.
 * 3: objects are padded to a Padmé bucket (content suite 3), and every metadata and
 *    content-key envelope carries its writer's signature.
 */
export const DRIVE_PROTOCOL_VERSION = 3;
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
/*
 * The most items one trash-batch or restore-batch request names. The server
 * walks each one under the workspace's lock, so this bounds how long a request
 * holds it; a client chunks a larger selection.
 */
export const MAX_TRASH_BATCH = 500;
/* Batch trash and restore requests one account may make a minute, both together. */
export const TRASH_BATCHES_PER_MINUTE = 60;

/*
 * A share envelope is suite 4 (an ephemeral X25519 key, ML-KEM-768 and the
 * granter's hybrid signature, docs/identity-pq-design.md), 4565 bytes, and
 * nothing else is written or served. Suites 1 (72 bytes), 2 (1160) and 3
 * (1256) no longer open on any client; their lengths are kept only so the
 * server can tell an outdated client to update rather than call its envelope
 * malformed.
 */
export const SHARE_SUITE = 4;
export const SHARE_ENVELOPE_BYTES = 4565;
export const RETIRED_SHARE_ENVELOPE_BYTES: readonly number[] = [72, 1160, 1256];
export const THUMBNAIL_BATCH = 100;

/* The name a client shows for the root; never stored, the root's metadata names it. */
export const ROOT_NAME = 'Drive';
/* What people see for the top folder, wherever it is named: lists, paths, crumbs. */
export const ROOT_LABEL = 'My files';

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
    /* Whether the server serves groups (families) at all; absent from servers before 1c. */
    groups?: boolean;
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
    | 'forbidden'
    /* A workspace document write would pass WORKSPACE_DOCUMENT_KINDS or WORKSPACE_DOCUMENT_BYTES. */
    | 'document-limit'
    /* A write's signature did not verify against the writer's current signing key. */
    | 'bad-signature'
    /* A share or link made or changed in a family folder, where sharing is not offered. */
    | 'family-sharing'
    /* A move out of a company's area its policy doesn't allow (docs/families-shared-pool.md 6.4). */
    | 'policy';

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
 *
 * The version is the HushOS product version (`web/1.0.0`, `ios/1.0.0`), the
 * same for the server, the web app and both phone apps. Clients built before
 * product versioning sent their Drive protocol number instead (`ios/3`); they
 * still parse, and count as older than every product version minimum. Minimums
 * written before 1.0.0 (`web/3`) still hold those old clients to them.
 */

export const CLIENT_HEADER = 'HushOS-Client';
/*
 * How a link visitor names the link to the API: the token in this header, so it
 * never sits in a path that reverse proxies write to their access logs.
 */
export const LINK_TOKEN_HEADER = 'x-link-token';

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

/* A product version as clients send it: major.minor.patch, no leading zeros. */
const PRODUCT_VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

export function isProductVersion(version: string) {
    return PRODUCT_VERSION.test(version);
}

/*
 * The oldest client release that will understand the protocol changes now
 * being built. Nothing refuses older clients yet: a change that needs it sets
 * this as the minimum for its route or for the operator's defaults.
 */
export const UPCOMING_PROTOCOL_MINIMUM = '1.0.0';

/*
 * Whether a client is at least `minimum`. Two kinds of minimum:
 *
 * - A product version (`1.0.0`): the client must send a product version at
 *   least that high. One that sent anything else (a pre-1.0 protocol number
 *   such as "3") is older than every product version: "3" must not pass for
 *   newer than "1.0.0".
 * - Anything else (`3`): a floor from before 1.0.0, when clients sent their
 *   Drive protocol number. Pre-1.0 clients are compared with it as they always
 *   were; a client sending a product version is past every such floor.
 */
export function meetsMinimum(client: ClientIdentity, minimum: string) {
    if (isProductVersion(minimum))
        return isProductVersion(client.version) && compareVersions(client.version, minimum) >= 0;
    return isProductVersion(client.version) || compareVersions(client.version, minimum) >= 0;
}

/* The client names whose minimum is a pre-1.0 protocol floor, for a deprecation warning. */
export function legacyMinimums(minimums: ReadonlyMap<string, string>) {
    return [...minimums].filter(([, minimum]) => !isProductVersion(minimum)).map(([name]) => name);
}

/* "web/1.0.0,ios/1.0.0" (or the older "web/3") -> Map; the env schema has already checked the shape. */
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
    if (minimum !== undefined && !meetsMinimum(client, minimum))
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

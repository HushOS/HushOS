/*
 * The group routes' limits and answer codes (docs/groups-server.md 4), shared
 * by the server, the web wrapper that caps bodies before they are read, and
 * any client.
 */

/* Why a group route refused, as `code` on its error body. */
export type GroupErrorCode =
    | 'invalid'
    | 'succession-due'
    | 'left-due'
    | 'members-changed'
    | 'stale'
    | 'seats'
    | 'organizer'
    | 'last-holder'
    | 'unsupported'
    | 'forbidden'
    | 'email-mismatch'
    | 'not-member'
    | 'not-pending'
    | 'rotating'
    | 'held'
    | 'epoch-stale'
    | 'root-moved'
    | 'root-mid-rotation'
    | 'not-rotating'
    | 'area-moved'
    | 'no-seal'
    | 'area-limit'
    | 'group-limit'
    | 'grants-due'
    | 'exists'
    | 'already-member'
    | 'gone'
    | 'too-large'
    | 'rate-limited'
    | 'unavailable';

export type GroupErrorStatus = 400 | 402 | 403 | 404 | 409 | 410 | 413 | 426 | 429 | 501 | 503;

/* Seals and grants one call may carry. */
export const MAX_SEALS_PER_CALL = 100;
export const MAX_GRANTS_PER_CALL = 256;
/* Rotations one roster may carry: a family's left-marking roster rotates every area. */
export const MAX_ROTATIONS_PER_CALL = 1024;
/* Roster pages: at most this many rosters, or about this many bytes of statements. */
export const ROSTER_PAGE = 200;
export const ROSTER_PAGE_BYTES = 8 * 1024 * 1024;
/* Identities per page of route 6. */
export const IDENTITY_PAGE = 100;
/* How long an invitation stays open. */
export const INVITATION_DAYS = 7;

/* Body caps, before anything is parsed (docs/groups-server.md 4, "Body caps"). */
export const SMALL_BODY_BYTES = 16 * 1024;
export const CREATE_BODY_BYTES = 96 * 1024;
export const SEALS_BODY_BYTES = 1024 * 1024;
export const GRANTS_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_ROSTER_BODY_BYTES = 8 * 1024 * 1024;
/*
 * A roster route's cap for a group whose head roster is `headStatementBytes`
 * long: its base64 with room for the next one to grow by 256 KiB, the
 * signatures and fields, and the seals, grants and rotations a call carries.
 * A family's bodies stay far below the 8 MiB ceiling.
 */
export function rosterBodyLimit(headStatementBytes: number, areas: number) {
    const statement = Math.ceil(((headStatementBytes + 256 * 1024) * 4) / 3);
    const rotations = areas * 8 * 1024;
    const sealsAndGrants = (MAX_SEALS_PER_CALL + MAX_GRANTS_PER_CALL) * 6200;
    return Math.min(
        MAX_ROSTER_BODY_BYTES,
        statement + 64 * 1024 + rotations + Math.min(sealsAndGrants, 2 * 1024 * 1024),
    );
}

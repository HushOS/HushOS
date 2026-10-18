import { WORKSPACE_DOCUMENT_BYTES, WORKSPACE_DOCUMENT_KINDS } from '@hushos/drive/protocol';
import { GROUP_AREA_LIMIT_MAX } from '@hushos/env/group-limits';

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
    | 'payer'
    | 'no-plan'
    /* One family per account: the caller, or the person being let in, is in another family. */
    | 'in-family'
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
    | 'document-stale'
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
 * What one area's re-sealed workspace documents can add to a roster call, at
 * Drive's limits: every byte a workspace may store, as base64, and for each
 * kind its name, version and the JSON around them (well under 256 bytes).
 */
export const ROTATION_DOCUMENTS_BODY_BYTES =
    Math.ceil((WORKSPACE_DOCUMENT_BYTES * 4) / 3) + WORKSPACE_DOCUMENT_KINDS * 256;

/*
 * Which of a roster route's requests carry area rotations, and so their
 * workspace documents: routes 7, 18 and 19 every area (a family roster that
 * marks someone left rotates them all), route 24 the one area it names, and
 * routes 17 and 21 none of the room for them (a departure is marked left on
 * route 7 first, docs/groups-server.md 4).
 */
export type RosterDocuments = 'all' | 'one' | 'none';

/* Roster bodies one account may have in flight at once, across its groups. */
export const MAX_ROSTER_BODIES_IN_FLIGHT = 2;

/*
 * A roster route's cap for a group whose head roster is `headStatementBytes`
 * long and which has `areas` areas: the head's base64 with room for the next
 * one to grow by 256 KiB, the signatures and fields, and the seals, grants and
 * rotations a call carries, never more than 8 MiB; then, on top, room for the
 * workspace documents the route's rotations re-seal at Drive's limits (every
 * area, one, or none). Derived from the limits, never from what is stored, and
 * the area count clamped to the most an operator may allow, so it is a hard
 * ceiling: about 34.7 MiB at the default of ten areas, about 141 MiB at 50.
 * Kept outside the 8 MiB on purpose: documents any member may write must never
 * be able to crowd out the roster that removes them.
 */
export function rosterBodyLimit(
    headStatementBytes: number,
    areas: number,
    documents: RosterDocuments,
) {
    const counted = Math.min(Math.max(areas, 0), GROUP_AREA_LIMIT_MAX);
    const statement = Math.ceil(((headStatementBytes + 256 * 1024) * 4) / 3);
    const rotations = counted * 8 * 1024;
    const sealsAndGrants = (MAX_SEALS_PER_CALL + MAX_GRANTS_PER_CALL) * 6200;
    const resealed = documents === 'all' ? counted : documents === 'one' ? 1 : 0;
    return (
        Math.min(
            MAX_ROSTER_BODY_BYTES,
            statement + 64 * 1024 + rotations + Math.min(sealsAndGrants, 2 * 1024 * 1024),
        ) +
        resealed * ROTATION_DOCUMENTS_BODY_BYTES
    );
}

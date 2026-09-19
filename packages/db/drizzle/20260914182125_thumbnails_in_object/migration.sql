-- Content suite 2: the thumbnail is a trailer of the file's own object and the version
-- envelope carries the sizes, so the server holds no thumbnail object, no pointer, and no
-- plaintext size. First-release thumbnails lived in objects of their own; they cannot be
-- moved into the files they belong to without the client's keys, so they are retired here:
-- their bytes leave every accounting they were in and their keys go through the deletion
-- outbox like any other object. Files uploaded before this show their type's icon until
-- they are uploaded again.

-- Thumbnail uploads still in flight: the reservation goes back, the row is aborted, and the
-- store's abandoned multipart upload is bounded by the bucket's lifecycle rule.
UPDATE workspace_storage s
SET reserved_bytes = s.reserved_bytes - r.bytes, updated_at = now()
FROM (
    SELECT workspace_id, sum(reserved_bytes) AS bytes
    FROM drive_uploads
    WHERE purpose = 'thumbnail' AND status IN ('open', 'completing', 'conflicted')
    GROUP BY workspace_id
) r
WHERE r.workspace_id = s.workspace_id;--> statement-breakpoint
UPDATE drive_uploads
SET status = 'aborted', reserved_bytes = 0
WHERE purpose = 'thumbnail' AND status IN ('open', 'completing', 'conflicted');--> statement-breakpoint

-- Ready thumbnails were counted once per version that pointed at them; each reference gives its bytes back.
UPDATE workspace_storage s
SET used_bytes = s.used_bytes - u.bytes, updated_at = now()
FROM (
    SELECT v.workspace_id, sum(o.ciphertext_size) AS bytes
    FROM file_versions v
    JOIN drive_objects o ON o.id = v.thumbnail_object_id
    WHERE v.status <> 'purged' AND o.status = 'ready'
    GROUP BY v.workspace_id
) u
WHERE u.workspace_id = s.workspace_id;--> statement-breakpoint

-- Every thumbnail object's key goes to the outbox: a published one waits for its replica
-- the usual way, a pending one is deleted at once. Then the rows themselves go.
INSERT INTO drive_object_deletions (object_id, workspace_id, object_key, published, replicated)
SELECT id, workspace_id, object_key, status = 'ready', replicated_at IS NOT NULL
FROM drive_objects
WHERE kind = 'thumbnail'
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE file_versions SET thumbnail_object_id = NULL WHERE thumbnail_object_id IS NOT NULL;--> statement-breakpoint
UPDATE drive_uploads SET object_id = NULL WHERE purpose = 'thumbnail';--> statement-breakpoint
DELETE FROM drive_uploads WHERE purpose = 'thumbnail';--> statement-breakpoint
DELETE FROM drive_objects WHERE kind = 'thumbnail';--> statement-breakpoint

ALTER TABLE "file_versions" DROP CONSTRAINT "file_versions_thumbnail_object_id_drive_objects_id_fkey";--> statement-breakpoint
ALTER TABLE "drive_objects" DROP CONSTRAINT "drive_objects_kind_valid";--> statement-breakpoint
ALTER TABLE "drive_uploads" DROP CONSTRAINT "drive_uploads_purpose_valid";--> statement-breakpoint
DROP INDEX "drive_report_items_thumbnail_idx";--> statement-breakpoint
ALTER TABLE "drive_objects" DROP COLUMN "kind";--> statement-breakpoint
ALTER TABLE "drive_report_items" DROP COLUMN "thumbnail_object_id";--> statement-breakpoint
ALTER TABLE "drive_report_items" DROP COLUMN "thumbnail_object_key";--> statement-breakpoint
ALTER TABLE "drive_report_items" DROP COLUMN "thumbnail_nonce";--> statement-breakpoint
ALTER TABLE "drive_report_items" DROP COLUMN "thumbnail_plaintext_size";--> statement-breakpoint
ALTER TABLE "drive_uploads" DROP COLUMN "purpose";--> statement-breakpoint
ALTER TABLE "file_versions" DROP COLUMN "thumbnail_object_id";--> statement-breakpoint
ALTER TABLE "drive_objects" ALTER COLUMN "plaintext_size" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "drive_objects" DROP CONSTRAINT "drive_objects_framing_valid", ADD CONSTRAINT "drive_objects_framing_valid" CHECK ("chunk_size" > 0 and "chunk_count" >= 1 and octet_length("content_nonce") = 16 and (("content_suite" = 1 and "plaintext_size" >= 0 and "ciphertext_size" = "plaintext_size" + 16 * "chunk_count") or ("content_suite" = 2 and "plaintext_size" is null and "ciphertext_size" >= 16 * "chunk_count")));--> statement-breakpoint
-- Dropping the thumbnail columns above already took this constraint with them.
ALTER TABLE "drive_report_items" DROP CONSTRAINT IF EXISTS "drive_report_items_valid", ADD CONSTRAINT "drive_report_items_valid" CHECK ("depth" >= 0 and "key_epoch" >= 1 and "parent_key_epoch" >= 1 and octet_length("key_envelope") = 72 and octet_length("metadata_envelope") between 42 and 4136 and (("kind" = 'folder' and "version_id" is null) or ("kind" = 'file' and ("version_id" is null or ("object_id" is not null and "object_key" is not null and octet_length("content_key_envelope") in (72, 84) and octet_length("content_nonce") = 16 and "chunk_size" > 0 and "chunk_count" >= 1 and ("plaintext_size" is null or "plaintext_size" >= 0) and "ciphertext_size" >= 0)))));--> statement-breakpoint
ALTER TABLE "file_versions" DROP CONSTRAINT "file_versions_envelope_valid", ADD CONSTRAINT "file_versions_envelope_valid" CHECK (("status" = 'purged' and "content_key_envelope" is null and "purged_at" is not null) or ("status" <> 'purged' and octet_length("content_key_envelope") in (72, 84) and "object_id" is not null));
#!/bin/sh
# Bootstraps the bundled MinIO for HushOS Drive: the bucket, nothing else. MinIO
# refuses a lifecycle rule whose only action is aborting incomplete multipart
# uploads, so that second layer of cleanup is left to the worker's expiry job here;
# on R2, B2 and S3 add the 3-day abort rule in the provider's console.
set -eu
mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null
mc mb --ignore-existing "local/$STORAGE_BUCKET"
echo "Bucket $STORAGE_BUCKET is ready."

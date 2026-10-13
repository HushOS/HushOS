/*
 * The domain reads its store settings when it loads; tests replace the store
 * itself (vi.mock('./storage')), so any well-formed values will do. Set only
 * when absent, so a run against a real store keeps its own.
 */
process.env.STORAGE_ENDPOINT ??= 'http://store.test';
process.env.STORAGE_BUCKET ??= 'hushos-test';
process.env.STORAGE_ACCESS_KEY_ID ??= 'test';
process.env.STORAGE_SECRET_ACCESS_KEY ??= 'test';

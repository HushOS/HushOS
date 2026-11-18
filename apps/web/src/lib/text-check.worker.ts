/*
 * The structured-text check beside Save, off the main thread (lib/text-check.ts):
 * the editor's text arrives decrypted from the page and nothing leaves this
 * worker except the line that fails. The page ends it when a newer edit or a
 * close makes the answer moot, however long the parse would have taken.
 */

import { dataFailure, type DataKind } from '@/lib/text-parse-data';

self.onmessage = (event: MessageEvent<{ kind: 'preload' } | { kind: DataKind; text: string }>) => {
    if (event.data.kind === 'preload') {
        self.postMessage({ ready: true });
        return;
    }
    self.postMessage({ failure: dataFailure(event.data.kind, event.data.text) });
};

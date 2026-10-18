/*
 * Checks and lays out a large JSON file off the main thread, so a file of
 * several MB doesn't hold the page while it is parsed. The text arrives
 * decrypted from the page and nothing leaves this worker except the answer.
 */

import { inspectJson } from '@/lib/json';

self.onmessage = (event: MessageEvent<{ id: number; text: string } | { kind: 'preload' }>) => {
    if ('kind' in event.data) return;
    const { id, text } = event.data;
    self.postMessage({ id, result: inspectJson(text) });
};

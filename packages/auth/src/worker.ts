import type { CryptoRequests, CryptoResults } from '@hushos/crypto';
import { serve } from './worker-handler';

export type WorkerRequests = CryptoRequests;
export type WorkerResults = CryptoResults;
self.onmessage = serve((message) => self.postMessage(message));

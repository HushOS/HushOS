import {
    createCryptoSession,
    CryptoError,
    type CryptoRequests,
    type CryptoResults,
} from '@hushos/crypto';

export type WorkerRequests = CryptoRequests;
export type WorkerResults = CryptoResults;
const session = createCryptoSession();
type Message = Parameters<typeof session.handle>[0];
self.onmessage = async (event: MessageEvent<Message>) => {
    try {
        self.postMessage({ id: event.data.id, result: await session.handle(event.data) });
    } catch (error) {
        session.reset();
        self.postMessage({
            id: event.data.id,
            error:
                error instanceof CryptoError
                    ? error.message
                    : 'Something went wrong on this device. Please try again.',
        });
    }
};

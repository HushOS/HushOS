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
    const { id } = event.data;
    try {
        const result = await session.handle(event.data, {
            progress: (value) => self.postMessage({ id, progress: value }),
        });
        self.postMessage({ id, result });
    } catch (error) {
        // A failed account operation (enrolment, unlock, a key rotation) leaves the
        // session in no state to trust, so it starts over. A Drive operation that
        // fails, such as a chunk read on a preview closed a moment earlier, is an
        // ordinary error for its caller and must not wipe the keys under everything
        // else that is running.
        if (!String(event.data.operation).startsWith('drive')) session.reset();
        self.postMessage({
            id,
            error:
                error instanceof CryptoError
                    ? error.message
                    : 'Something went wrong on this device. Please try again.',
        });
    }
};

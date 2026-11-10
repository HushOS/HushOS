import {
    createCryptoSession,
    CryptoError,
    RefusedError,
    SavedAccessError,
    type CryptoRequests,
    type CryptoResults,
} from '@hushos/crypto';
import { ordinaryFailure } from './ordinary-failure';

export type WorkerRequests = CryptoRequests;
export type WorkerResults = CryptoResults;
type Message = Parameters<ReturnType<typeof createCryptoSession>['handle']>[0];
/*
 * One worker: a session of its own, and its answer to each message, posted with `post`.
 * Apart from the worker itself, the auth client's tests run it in process, so that what a
 * failed operation does to the session there is this rule and not a copy of it.
 */
export function serve(post: (message: unknown) => void) {
    const session = createCryptoSession();
    return async (event: Pick<MessageEvent<Message>, 'data'>) => {
        const { id } = event.data;
        try {
            const result = await session.handle(event.data, {
                progress: (value) => post({ id, progress: value }),
            });
            post({ id, result });
        } catch (error) {
            // A failed account operation (enrolment, unlock, a key rotation) leaves the
            // session in no state to trust, so it starts over. A Drive operation that
            // fails, such as a chunk read on a preview closed a moment earlier, is an
            // ordinary error for its caller and must not wipe the keys under everything
            // else that is running; so is a family's (a member list the server sent that
            // does not hold, a change refused), which the group session undoes itself. A
            // refusal changed nothing, so it keeps the session too.
            const kept = error instanceof RefusedError;
            // The saved unlock does not open with its device key: the client's cue to erase it.
            const invalid = error instanceof SavedAccessError;
            if (!kept && !ordinaryFailure(String(event.data.operation))) session.reset();
            post({
                id,
                error:
                    error instanceof CryptoError
                        ? error.message
                        : 'Something went wrong on this device. Please try again.',
                ...(kept ? { kept } : {}),
                ...(invalid ? { invalid } : {}),
            });
        }
    };
}
self.onmessage = serve((message) => self.postMessage(message));

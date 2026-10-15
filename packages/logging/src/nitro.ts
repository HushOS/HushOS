import type { RequestLogger } from 'evlog';
import { evlogErrorHandler } from 'evlog/nitro/v3';
import { sanitizeFailure } from './privacy';

export { default, evlogErrorHandler } from 'evlog/nitro/v3';

type Handler = typeof evlogErrorHandler;

/* What the router throws on purpose: a redirect is a Response, notFound() a marked plain object. */
function routerSignal(error: unknown) {
    return (
        error instanceof Response ||
        (typeof error === 'object' &&
            error !== null &&
            !(error instanceof Error) &&
            (error as { isNotFound?: unknown }).isNotFound === true)
    );
}

/* An h3 HTTPError thrown on purpose: its status, headers and message are the answer. */
function deliberate(error: unknown) {
    return (
        error instanceof Error &&
        error.name === 'HTTPError' &&
        (error as { unhandled?: unknown }).unhandled !== true
    );
}

function statusOf(error: unknown) {
    const value = error as { status?: unknown; statusCode?: unknown } | null;
    const status = value?.status ?? value?.statusCode;
    return typeof status === 'number' && status >= 400 && status <= 599 ? status : 500;
}

/*
 * evlog's handler answers its own errors as JSON and rethrows anything else,
 * which the framework then prints whole, outside the event's redaction: an
 * error's message can carry what the request held (an address, a file name).
 * Here anything else is logged on the request's event as its class and code
 * only, and what goes on is a bare error with the same status and no message.
 * Outside production the original is printed too, for whoever runs the server.
 */
export function safeErrorHandler(
    requestLog: () => Promise<RequestLogger | undefined> | RequestLogger | undefined,
): Handler {
    return async (nextOrOptions) => {
        try {
            return await evlogErrorHandler(nextOrOptions);
        } catch (error) {
            // A client that went away is not a failure; the framework restores its reason.
            if (routerSignal(error) || deliberate(error)) throw error;
            if (error instanceof Error && error.name === 'AbortError') throw error;
            const status = statusOf(error);
            try {
                const log = await requestLog();
                log?.set({ failure: sanitizeFailure(error) });
                if (status < 500) log?.warn('Request refused.');
                else log?.error(new Error('Request failed.'));
            } catch {
                // Outside a request, or no logger: the bare error below still carries nothing.
            }
            if (process.env.NODE_ENV !== 'production') console.error(error);
            throw Object.assign(new Error('Request failed.'), { status });
        }
    };
}

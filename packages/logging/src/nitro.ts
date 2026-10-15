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

type RequestLog = () => Promise<RequestLogger | undefined> | RequestLogger | undefined;

/* Marks an error withoutDetail already logged and stripped, so a second pass leaves it alone. */
const stripped = Symbol.for('hushos.logging.stripped');

/*
 * What goes on in place of an error that escaped a server route or a server
 * function. The framework prints an error it doesn't recognise whole, outside
 * the event's redaction, and an error's message can carry what the request
 * held (an address, a file name). The original is logged on the request's event
 * as its class and code only, and what goes on is a bare error with the same
 * status and no message, which the framework neither prints nor explains.
 * Router signals, deliberate HTTP errors and a client going away go on as they
 * are. Outside production the original is printed too, for whoever runs it.
 */
export async function withoutDetail(error: unknown, requestLog: RequestLog): Promise<unknown> {
    if (routerSignal(error) || deliberate(error)) return error;
    // Already logged and stripped by an inner pass (a server function inside a server route).
    if (typeof error === 'object' && error !== null && stripped in error) return error;
    // A client that went away is not a failure; the framework restores its reason.
    if (error instanceof Error && error.name === 'AbortError') return error;
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
    return Object.assign(new Error('Request failed.'), { status, [stripped]: true });
}

/* evlog's handler, which answers its own errors as JSON, with anything else passed through withoutDetail. */
export function safeErrorHandler(requestLog: RequestLog): Handler {
    return async (nextOrOptions) => {
        try {
            return await evlogErrorHandler(nextOrOptions);
        } catch (error) {
            throw await withoutDetail(error, requestLog);
        }
    };
}

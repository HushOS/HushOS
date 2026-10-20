import { dehydrate, QueryClient } from '@tanstack/react-query';
import { setupRouterSsrQueryIntegration } from '@tanstack/react-router-ssr-query';
import { describe, expect, it, vi } from 'vitest';

/*
 * The SSR query integration reads the page's streamed queries with a stream reader. On WebKit
 * (Safari, and Playwright's WebKit) ReadableStreamDefaultReader.releaseLock() holds the reader's
 * lock while it makes a TypeError; a garbage collection starting at that allocation waits on a
 * marking thread that wants the same lock, and the page's main thread never runs again. The page
 * sat on "Opening your files" with timers and input dead. The patch in
 * patches/@tanstack%2Frouter-ssr-query-core@1.169.3.patch drops the release (nothing reads the
 * stream after it ends); these tests fail if an upgrade or a lost patch brings it back.
 */

type Hydrate = (dehydrated: unknown) => Promise<void>;

function clientRouter() {
    const router = { isServer: false, options: {} as { hydrate?: Hydrate } };
    const queryClient = new QueryClient();
    setupRouterSsrQueryIntegration({
        router: router as never,
        queryClient,
        handleRedirects: false,
        wrapQueryClient: false,
    });
    return { router, queryClient };
}

/* What the server streams: one batch of dehydrated queries. */
async function batch(key: string, data: unknown) {
    const server = new QueryClient();
    await server.prefetchQuery({ queryKey: [key], queryFn: async () => data });
    return dehydrate(server).queries;
}

/* Every reader the integration takes, and every release of one. */
function watchReaders() {
    const getReader = vi.spyOn(ReadableStream.prototype, 'getReader');
    const releases = vi.spyOn(ReadableStreamDefaultReader.prototype, 'releaseLock');
    return {
        get readers() {
            return getReader.mock.results.map(
                (result) => result.value as ReadableStreamDefaultReader,
            );
        },
        releases,
    };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the SSR query stream on the client', () => {
    it('hydrates every streamed batch and never releases the reader when the stream ends', async () => {
        const { router, queryClient } = clientRouter();
        const watched = watchReaders();
        const { releases } = watched;
        const first = await batch('first', { n: 1 });
        const second = await batch('second', { n: 2 });
        let push!: ReadableStreamDefaultController;
        const stream = new ReadableStream({ start: (controller) => void (push = controller) });

        await router.options.hydrate!({ query: { stream } });
        push.enqueue(first);
        push.enqueue(second);
        push.close();
        await watched.readers[0]!.closed;
        await settle();

        // The stream was read to its end: both batches reached the cache.
        expect(queryClient.getQueryData(['first'])).toEqual({ n: 1 });
        expect(queryClient.getQueryData(['second'])).toEqual({ n: 2 });
        expect(watched.readers).toHaveLength(1);
        expect(releases).not.toHaveBeenCalled();
    });

    it('cancels the stream when a batch fails to hydrate while it is still open, without releasing the reader', async () => {
        const { router, queryClient } = clientRouter();
        const watched = watchReaders();
        const { releases } = watched;
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        let push!: ReadableStreamDefaultController;
        const cancelled = vi.fn();
        const stream = new ReadableStream({
            start: (controller) => void (push = controller),
            cancel: cancelled,
        });

        await router.options.hydrate!({ query: { stream } });
        push.enqueue(await batch('first', { n: 1 }));
        // Not a list of queries: hydrating it throws, and the stream is still open behind it.
        push.enqueue(42);
        // The integration logs the failure, then cancels; wait for the log, not for a close that a
        // missing cancel would never bring.
        await vi.waitFor(() => expect(errors).toHaveBeenCalled());
        await settle();

        expect(queryClient.getQueryData(['first'])).toEqual({ n: 1 });
        // The server's side is told to stop, with the error that stopped the reading.
        expect(cancelled).toHaveBeenCalledTimes(1);
        expect(cancelled.mock.calls[0]![0]).toBeInstanceOf(TypeError);
        // Nothing more is read: a later batch would only be dropped.
        expect(() => push.enqueue([])).toThrow(TypeError);
        expect(releases).not.toHaveBeenCalled();
    });

    it('leaves a stream that errored on its own without releasing the reader', async () => {
        const { router } = clientRouter();
        const watched = watchReaders();
        const { releases } = watched;
        vi.spyOn(console, 'error').mockImplementation(() => {});
        let push!: ReadableStreamDefaultController;
        const stream = new ReadableStream({ start: (controller) => void (push = controller) });

        await router.options.hydrate!({ query: { stream } });
        push.error(new Error('The page was cut short.'));
        await watched.readers[0]!.closed.catch(() => {});
        await settle();

        expect(watched.readers).toHaveLength(1);
        expect(releases).not.toHaveBeenCalled();
    });
});

import { edenFetch, treaty } from '@elysia/eden';
import { createIsomorphicFn } from '@tanstack/react-start';
import { useRequest } from 'nitro/context';

import { apiApp, type Api } from '@/lib/api.server';

export const getApi = createIsomorphicFn()
    .server(() => treaty(apiApp).api)
    .client(() => treaty<Api>(window.location.origin).api);

export const getApiFetch = createIsomorphicFn()
    .server(() =>
        edenFetch<Api>(new URL(useRequest().url).origin, {
            fetcher: ((input, init) =>
                Promise.resolve(apiApp.fetch(new Request(input, init)))) as typeof fetch,
        }),
    )
    .client(() => edenFetch<Api>(''));

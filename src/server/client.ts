import { hc } from 'hono/client';

import { getBaseUrl } from '@/lib/utils';
import { type AppType } from '@/server';

export const client = hc<AppType>(getBaseUrl(), {
    fetch: async (input: RequestInfo | URL, requestInit?: RequestInit) => {
        return fetch(input, requestInit).then(res => {
            if (!res.ok) {
                throw new Error('Request failed.');
            }

            return res;
        });
    },
});

import { fetchRequestHandler } from '@trpc/server/adapters/fetch';

import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';

async function handler(req: Request) {
    const response = await fetchRequestHandler({
        endpoint: '/api/trpc',
        router: appRouter,
        req,
        createContext: () =>
            createTRPCContext({
                headers: req.headers,
            }),
        onError({ error, path }) {
            console.error(`>>> tRPC Error on '${path}'`, error);
        },
    });

    return response;
}

export { handler as GET, handler as POST };

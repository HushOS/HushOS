import { type inferRouterInputs, type inferRouterOutputs } from '@trpc/server';
import superjson from 'superjson';

import { clientEnvs } from '@/env/client';
import { type AppRouter } from '@/server/api/root';

export const transformer = superjson;

function getBaseUrl() {
    if (typeof window !== 'undefined') return window.location.origin;
    return `https://${clientEnvs.NEXT_PUBLIC_DOMAIN}`;
}

export function getUrl() {
    return getBaseUrl() + '/api/trpc';
}

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;

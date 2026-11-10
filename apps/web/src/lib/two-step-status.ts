import type { TwoStepStatus } from '@hushos/auth/api';
import { readSessionToken } from '@hushos/auth/http';
import { AuthError, getTwoStep } from '@hushos/auth/server';
import { queryOptions } from '@tanstack/react-query';
import { createIsomorphicFn } from '@tanstack/react-start';
import { useRequest } from 'nitro/context';
import { authClient } from '@/lib/auth-client';

/*
 * The account's second step as Settings shows it, or null on a server that does not offer
 * two-step sign-in (TWO_STEP_ENABLED off; the route answers 501 `unsupported`): the section
 * then draws nothing, since nothing in it could work. Read directly on the server for the
 * first paint, so the section neither flashes in nor pushes the page down, and through the
 * API in the browser.
 */
const readTwoStep = createIsomorphicFn()
    .server(async (): Promise<TwoStepStatus | null> => {
        try {
            return await getTwoStep(readSessionToken(useRequest()));
        } catch (error) {
            if (error instanceof AuthError && error.code === 'unsupported') return null;
            throw error;
        }
    })
    .client(async (): Promise<TwoStepStatus | null> => {
        try {
            return await authClient.twoStep();
        } catch (error) {
            if ((error as { code?: unknown } | null)?.code === 'unsupported') return null;
            throw error;
        }
    });

export const twoStepQueryOptions = queryOptions({
    queryKey: ['account', 'two-step'] as const,
    queryFn: () => readTwoStep(),
    staleTime: 15_000,
    retry: false,
});

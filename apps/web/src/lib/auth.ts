import { getSessionUser, getEnrollment } from '@hushos/auth/server';
import { createIsomorphicFn } from '@tanstack/react-start';
import { useRequest } from 'nitro/context';
import { authClient } from '@/lib/auth-client';

export const getCurrentUser = createIsomorphicFn()
    .server(() => getSessionUser(useRequest()))
    .client(async () => (await authClient.session()).user);

export const getCurrentEnrollment = createIsomorphicFn()
    .server(() => getEnrollment(useRequest()))
    .client(async () => (await authClient.enrollment()).enrollment);

export const getRecoveryEnrollment = createIsomorphicFn()
    .server(() => getEnrollment(useRequest(), 'recover'))
    .client(async () => (await authClient.enrollment('recover')).enrollment);

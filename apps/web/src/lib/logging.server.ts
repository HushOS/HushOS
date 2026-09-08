import type { RequestLogger } from '@hushos/logging';
import { useRequest } from 'nitro/context';

export function useLogger() {
    const logger = useRequest().context?.log as RequestLogger | undefined;
    if (!logger) throw new Error('Request logger is unavailable outside a Nitro request.');
    return logger;
}

export function useRequestId() {
    return useLogger().getContext().requestId as string;
}

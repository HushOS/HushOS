import type { RequestLogger } from '@hushos/logging';
import { withoutDetail } from '@hushos/logging/nitro';
import { createMiddleware, createStart } from '@tanstack/react-start';

/*
 * Every server function's errors pass through here before Start serializes or
 * prints them: what escaped is logged on the request's event as its class and
 * code, and what goes on is a bare error (see withoutDetail). No server function
 * here throws a message meant for the person; where one's failure is shown (the
 * sign-up form's referral and offer lookups), authError says it in plain words.
 */
const functionErrors = createMiddleware({ type: 'function' }).server(async ({ next }) => {
    try {
        return await next();
    } catch (error) {
        throw await withoutDetail(
            error,
            async () =>
                (await import('nitro/context')).useRequest().context?.log as
                    | RequestLogger
                    | undefined,
        );
    }
});

export const startInstance = createStart(() => ({ functionMiddleware: [functionErrors] }));

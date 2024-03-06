import { createRegistrationResponse } from '@/server/api/routers/auth/createRegistrationResponse';
import { sendRegistrationCode } from '@/server/api/routers/auth/sendRegistrationCode';
import { storeUserRecord } from '@/server/api/routers/auth/storeUserRecord';
import { createTRPCRouter } from '@/server/api/trpc';

export const authRouter = createTRPCRouter({
    sendRegistrationCode,
    createRegistrationResponse,
    storeUserRecord,
});

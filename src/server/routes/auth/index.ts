import { OpenAPIHono } from '@hono/zod-openapi';

import { createCredentialResponse } from '@/server/routes/auth/login/create-credential-response';
import { userAuth } from '@/server/routes/auth/login/user-auth';
import { logoutApp } from '@/server/routes/auth/logout';
import { createRegistrationResponse } from '@/server/routes/auth/register/create-registration-response';
import { sendRegistrationCode } from '@/server/routes/auth/register/send-registration-code';
import { storeUserRecord } from '@/server/routes/auth/register/store-user-record';
import { ContextVariables } from '@/server/types';

export const authApp = new OpenAPIHono<{ Variables: ContextVariables }>()
    // Register routes
    .route('/', sendRegistrationCode)
    .route('/', createRegistrationResponse)
    .route('/', storeUserRecord)
    // Login routes
    .route('/', createCredentialResponse)
    .route('/', userAuth)
    // Logout routes
    .route('/', logoutApp);

import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';

import { createRegistrationResponseRouteConfig } from '@/server/routes/auth/create-registration-response';
import { sendRegistrationCodeRouteConfig } from '@/server/routes/auth/send-registration-code';
import { storeUserRecordRouteConfig } from '@/server/routes/auth/store-user-record';
import { waitlistRouteConfig } from '@/server/routes/waitlist';

const registry = new OpenAPIRegistry();

registry.registerPath(sendRegistrationCodeRouteConfig);
registry.registerPath(createRegistrationResponseRouteConfig);
registry.registerPath(storeUserRecordRouteConfig);
registry.registerPath(waitlistRouteConfig);

export { registry };

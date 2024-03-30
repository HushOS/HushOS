import { DrizzlePostgreSQLAdapter } from '@lucia-auth/adapter-drizzle';
import { Lucia } from 'lucia';

import { serverEnvs } from '@/env/server';
import { getDbClient } from '@/services/db';
import { sessions, users } from '@/services/db/schema';

export function getLuciaClient() {
    return new Lucia(new DrizzlePostgreSQLAdapter(getDbClient(), sessions, users), {
        sessionCookie: {
            attributes: {
                secure: serverEnvs.NODE_ENV === 'production',
            },
        },
        getUserAttributes: attributes => {
            return {
                id: attributes.id,
                email: attributes.email,
            };
        },
    });
}

declare module 'lucia' {
    interface Register {
        Lucia: ReturnType<typeof getLuciaClient>;
        DatabaseUserAttributes: {
            id: number;
            email: string;
        };
    }
}

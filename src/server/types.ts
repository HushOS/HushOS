import { Session, User } from 'lucia';

import { getLuciaClient } from '@/services/auth';
import { getDbClient } from '@/services/db';

export type ContextVariables = {
    db: ReturnType<typeof getDbClient>;
    lucia: ReturnType<typeof getLuciaClient>;
    user: User | null;
    session: Session | null;
};

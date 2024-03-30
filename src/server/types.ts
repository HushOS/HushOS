import { Session, User } from 'lucia';

import { lucia } from '@/services/auth';
import { db } from '@/services/db';

export type ContextVariables = {
    db: typeof db;
    lucia: typeof lucia;
    user: User | null;
    session: Session | null;
};

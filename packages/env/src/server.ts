import { authEnv } from './auth';
import { dbEnv } from './db';
import { emailEnv, validateEmailAdapter } from './email';

export function validateServerEnv() {
    validateEmailAdapter();
    return { ...dbEnv, ...authEnv, ...emailEnv };
}

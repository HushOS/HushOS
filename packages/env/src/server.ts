import { authEnv } from './auth';
import { billingEnv, validateBillingProvider } from './billing';
import { dbEnv } from './db';
import { emailEnv, validateEmailAdapter } from './email';

export function validateServerEnv() {
    validateEmailAdapter();
    validateBillingProvider();
    return { ...dbEnv, ...authEnv, ...emailEnv, ...billingEnv };
}

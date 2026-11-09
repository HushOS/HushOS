import { authEnv } from './auth';
import { billingEnv, validateBillingProvider } from './billing';
import { dbEnv } from './db';
import { emailEnv, validateEmailAdapter } from './email';
import { groupsEnv } from './groups';
import { storageEnv } from './storage';
import { twoStepEnv } from './two-step';

export function validateServerEnv() {
    validateEmailAdapter();
    validateBillingProvider();
    return {
        ...dbEnv,
        ...authEnv,
        ...emailEnv,
        ...billingEnv,
        ...storageEnv,
        ...groupsEnv,
        // Read here so a malformed two-step key stops the server at start, not at a sign-in.
        ...twoStepEnv,
    };
}

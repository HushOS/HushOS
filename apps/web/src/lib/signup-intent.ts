import { CURRENCY_PATTERN } from '@hushos/billing/protocol';
import { t } from 'elysia';

/*
 * What sign-up may carry into the account it makes (`/auth/register/email`): the plan chosen on
 * the pricing page, a referral or offer code, where the visitor came from, and the currency the
 * plan was shown in. Elysia drops any field not named here, so each one sign-up sends is named:
 * a currency left out was dropped silently, and the checkout fell back to the visitor's locale.
 * The currency is a code's shape only (ISO 4217, lowercase); whether the plan is priced in it is
 * the catalogue's to say, where it is used.
 */
const intentValue = t.String({ minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9_-]+$' });

export const intentSchema = t.Object({
    plan: t.Optional(intentValue),
    referral: t.Optional(intentValue),
    source: t.Optional(intentValue),
    currency: t.Optional(
        t.String({ minLength: 3, maxLength: 3, pattern: CURRENCY_PATTERN.source }),
    ),
});

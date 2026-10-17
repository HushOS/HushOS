import { createPolar } from '@polar-sh/sdk/2026-04';

/*
 * Shared setup for the Polar group-billing experiments (docs/polar-group-billing-spike.md 6).
 * Sandbox only: every script imports this first, and it refuses to build a client unless
 * POLAR_ENVIRONMENT is exactly "sandbox". The server URL is pinned rather than derived from
 * the environment name, so a typo cannot fall through to production. The token is read here
 * and never printed.
 *
 * Every object these scripts create is named or keyed with the `exp-` prefix, and none carries
 * `hushos_plan`, so the app's personal catalogue ignores them.
 */
export const SANDBOX_URL = 'https://sandbox-api.polar.sh';

if (process.env.POLAR_ENVIRONMENT !== 'sandbox') {
    console.error('Refusing to run: POLAR_ENVIRONMENT must be "sandbox".');
    process.exit(1);
}
const accessToken = process.env.POLAR_ACCESS_TOKEN;
if (!accessToken) {
    console.error('Refusing to run: POLAR_ACCESS_TOKEN is not set.');
    process.exit(1);
}

/* Options for any API-version client; the 2026-10 comparison script builds its own from these. */
export const sandboxOptions = {
    accessToken,
    environment: 'sandbox',
    baseUrl: SANDBOX_URL,
} as const;

export const polar = createPolar(sandboxOptions);

const statePath = new URL('./state.json', import.meta.url);

/* IDs of created sandbox objects, kept beside the scripts so later runs and cleanup can find them. */
export type State = Record<string, unknown>;

export async function loadState(): Promise<State> {
    const file = Bun.file(statePath);
    return (await file.exists()) ? ((await file.json()) as State) : {};
}

export async function saveState(state: State) {
    await Bun.write(statePath, `${JSON.stringify(state, null, 4)}\n`);
}

/* Runs a call and returns either its result or the error's status and body, so a refusal is a result. */
export async function attempt<T>(
    label: string,
    call: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; status: number | null; error: unknown }> {
    try {
        const value = await call();
        console.log(`[ok]   ${label}`);
        return { ok: true, value };
    } catch (cause) {
        const status =
            typeof cause === 'object' && cause !== null && 'statusCode' in cause
                ? Number((cause as { statusCode: unknown }).statusCode)
                : null;
        const error =
            typeof cause === 'object' && cause !== null && 'error' in cause
                ? (cause as { error: unknown }).error
                : String(cause);
        console.log(`[fail] ${label}: ${status ?? ''} ${JSON.stringify(error)}`);
        return { ok: false, status, error };
    }
}

export function show(label: string, value: unknown) {
    console.log(`${label}: ${JSON.stringify(value, null, 2)}`);
}

export function unique() {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

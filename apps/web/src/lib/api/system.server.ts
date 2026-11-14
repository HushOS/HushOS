import '@/lib/server-only';
import * as auth from '@hushos/auth/server';
import { db } from '@hushos/db';
import { log as serverLog } from '@hushos/logging';
import { API_SERVICE } from '@hushos/shared';
import { Elysia } from 'elysia';
import {
    healthResponse,
    readyResponse,
    unavailableResponse,
} from '@/lib/api/admin-responses.server';
import { requestContext } from '@/lib/api/shared.server';

/*
 * At its readiness checks this process says which two-step key it seals under and which keys
 * it can read (their ids, never the keys). The worker re-seals older secrets towards a key
 * only when every web process seen in the last five minutes seals under it
 * (docs/two-step-design.md 8), so each process keeps saying so for as long as it runs: one
 * that stops is taken for gone. Not at every request, though: readiness is asked by anyone,
 * signed in or not, and each word is a write. A failure is logged, never the readiness
 * answer's, and the next check tries again.
 */
const KEY_REPORT_MS = 15_000;
// On the process's own steady clock: the wall clock can be set back, and a process that then
// stayed silent for as long as it was set back would be taken for gone.
let keysReportedAt = Number.NEGATIVE_INFINITY;
let keysReporting = false;
function reportTwoStepKeys() {
    if (keysReporting || performance.now() - keysReportedAt < KEY_REPORT_MS) return;
    keysReporting = true;
    void auth
        .reportTwoStepKeys()
        .then(() => {
            keysReportedAt = performance.now();
        })
        .catch((error: unknown) =>
            serverLog.error({
                message: 'This process could not say which two-step key it seals under.',
                twoStep: { failure: error instanceof Error ? error.name : typeof error },
            }),
        )
        .finally(() => {
            keysReporting = false;
        });
}

/*
 * At its readiness checks this process also ends the requests to approve on another device
 * whose time is up (docs/two-step-design.md 12): one that a sign-in which proved no device left
 * unanswered is a failed step, with the notice that goes with it, and nobody else may ever
 * touch that account to find it. Once a minute at most. The worker cannot do it: counting a
 * failed step sends the account's notice, which is this service's to send.
 */
const SETTLE_MS = 60_000;
let settledAt = Number.NEGATIVE_INFINITY;
let settling = false;
function settleDeviceApprovals() {
    if (settling || performance.now() - settledAt < SETTLE_MS) return;
    settling = true;
    // The minute starts when the sweep does, whatever becomes of it: one that fails is tried
    // again a minute later, not at every readiness check until it stops failing.
    settledAt = performance.now();
    void auth
        .settleDeviceApprovals()
        .catch((error: unknown) =>
            serverLog.error({
                message: 'Requests to approve on another device could not be ended.',
                twoStep: { failure: error instanceof Error ? error.name : typeof error },
            }),
        )
        .finally(() => {
            settling = false;
        });
}

/* Health and readiness (/api/health, /api/ready). */
export const systemApi = new Elysia()
    .use(requestContext)
    .get('/health', { response: { 200: healthResponse } }, () => ({
        status: 'ok' as const,
        service: API_SERVICE,
    }))
    // The 503 is declared too, so the outage reply is held to its shape like the 200.
    .get(
        '/ready',
        { response: { 200: readyResponse, 503: unavailableResponse } },
        async ({ status, log, set }) => {
            set.headers['Cache-Control'] = 'no-store';
            try {
                await db.execute('select 1');
                reportTwoStepKeys();
                settleDeviceApprovals();
                return { status: 'ok' as const };
            } catch (error) {
                if (error instanceof Error) log.error(error);
                return status(503, { status: 'unavailable' as const });
            }
        },
    );

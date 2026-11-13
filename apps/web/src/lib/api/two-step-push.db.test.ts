import { randomBytes } from 'node:crypto';
import type { NotificationKind } from '@hushos/db/schema';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { appCode, loadEdge, type Account, type Edge } from '@/test/auth-edge.server';

/*
 * Two-step sign-in's notices also go to the account's devices (docs/two-step-design.md 7),
 * through the HTTP edge, real OPAQUE and Postgres. Only the relay is stood in for: its pings
 * are kept in `pings`. A push names an event and nothing else; the device fetches the event
 * over its own session, so what is checked is what each side is handed: the relay a handle,
 * an id and a class, the device a kind and, for a used backup code, how many are left.
 */

const RELAY = 'https://relay.hush.example';
const NOTIFICATIONS = { api: '/api/notifications' };

/* Every notice two-step sign-in sends by email (packages/emails, `SecurityNoticeKind`). */
const STEP_KINDS = [
    'two-step-on',
    'two-step-off',
    'two-step-app-added',
    'two-step-app-removed',
    'backup-codes-made',
    'backup-code-used',
    'phrase-used',
    'phrase-replaced',
    'password-reset',
    'account-key-rotated',
    'step-failed',
    'change-step-failed',
    'totp-frozen',
] as const satisfies readonly NotificationKind[];

let edge: Edge;
const pings: { handle: string; id: string; class: string }[] = [];
const relay = { down: false };

beforeAll(async () => {
    edge = await loadEdge({
        TWO_STEP_ENABLED: 'true',
        NOTIFICATIONS_ENABLED: 'true',
        PUSH_RELAY_URL: RELAY,
    });
});
beforeEach(async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    await edge.resetDatabase();
    edge.outbox.length = 0;
    pings.length = 0;
    relay.down = false;
    // The only host the server may reach from here is the relay, with a ping.
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
        if (String(url) !== `${RELAY}/v1/ping`) throw new Error(`Unexpected request to ${url}.`);
        if (relay.down) throw new Error('connect ECONNREFUSED');
        pings.push(JSON.parse(init?.body as string));
        return new Response(null, { status: 202 });
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
afterAll(() => edge.closeDatabase());

const handle = () => randomBytes(32).toString('base64url');

/* A new sign-in of `who`, registered for pushes: its session and its relay handle. */
async function device(who: Account, signedIn?: string) {
    const cookie = signedIn ?? (await edge.signIn(who)).session!;
    expect(cookie).toBeTruthy();
    const registration = { kind: 'relay', handle: handle() };
    const registered = await edge.call('PUT', '/registration', registration, {
        cookie,
        ...NOTIFICATIONS,
    });
    expect(registered).toMatchObject({ status: 200, body: { registered: true } });
    return { cookie, handle: registration.handle };
}

/* Turns the step on through the routes, as the settings screen does. */
async function turnOn(cookie: string) {
    const { proof } = await edge.passwordProof('/two-step/reauth', {}, { cookie });
    const enrol = await edge.call('POST', '/two-step/totp', proof, { cookie });
    expect(enrol.status).toBe(200);
    const confirmed = await edge.call(
        'POST',
        `/two-step/totp/${enrol.body.id}/confirm`,
        { code: await appCode(enrol.body.secret, -1) },
        { cookie },
    );
    expect(confirmed.status).toBe(200);
    return { secret: enrol.body.secret as string, codes: confirmed.body.backupCodes as string[] };
}

/* A sign-in through the step with a backup code. */
async function signInWithCode(who: Account, code: string) {
    const asked = await edge.signIn(who, { twoStep: true });
    return edge.call('POST', '/login/two-step', {
        token: asked.body.twoStep.token,
        proof: { kind: 'backup', code },
    });
}

/* Pushes are sent after the reply and not awaited: wait for the ones a test expects. */
async function pinged(count: number) {
    for (let waited = 0; waited < 200 && pings.length < count; waited++)
        await new Promise((resolve) => setTimeout(resolve, 10));
    return [...pings];
}

const fetched = (cookie: string, id: string) =>
    edge.call('GET', `/${id}`, undefined, { cookie, ...NOTIFICATIONS });
const listed = async (cookie: string) =>
    (await edge.call('GET', '', undefined, { cookie, ...NOTIFICATIONS })).body.notifications as {
        id: string;
        kind: string;
        data: Record<string, unknown>;
    }[];

describe('two-step notices on the account’s devices', () => {
    test('turning the step on pings every device of the account with an event id alone, though every toggle is off', async () => {
        const who = await edge.account();
        const laptop = await device(who);
        const phone = await device(who);
        // The second sign-in was itself a notice to the first device: let it land, then start clean.
        expect(await pinged(1)).toMatchObject([{ handle: laptop.handle }]);
        pings.length = 0;
        // Another account's device, registered with the same relay: it must hear nothing.
        const stranger = await edge.account();
        const theirs = await device(stranger);
        // Security notices cannot be turned off: both toggles off changes nothing here.
        expect(
            (
                await edge.call(
                    'PUT',
                    '/settings',
                    { shared: false, family: false },
                    { cookie: laptop.cookie, ...NOTIFICATIONS },
                )
            ).status,
        ).toBe(200);

        await turnOn(laptop.cookie);
        expect(await edge.notices('two-step-on')).toHaveLength(1);

        const sent = await pinged(2);
        expect(sent.map((ping) => ping.handle).sort()).toEqual(
            [laptop.handle, phone.handle].sort(),
        );
        expect(sent.map((ping) => ping.handle)).not.toContain(theirs.handle);
        // One event for both devices, classed as security, and nothing else in the ping.
        expect(new Set(sent.map((ping) => ping.id)).size).toBe(1);
        for (const ping of sent) {
            expect(Object.keys(ping).sort()).toEqual(['class', 'handle', 'id']);
            expect(ping.class).toBe('security');
            expect(ping.id).toMatch(/^[0-9a-f-]{36}$/);
        }

        // The other device fetches it over its own session: the kind, and no words or names.
        const event = await fetched(phone.cookie, sent[0]!.id);
        expect(event.status).toBe(200);
        expect(Object.keys(event.body.notification).sort()).toEqual([
            'createdAt',
            'data',
            'id',
            'kind',
        ]);
        expect(event.body.notification).toMatchObject({
            id: sent[0]!.id,
            kind: 'two-step-on',
            data: {},
        });
        // It is this account's event: another account's session finds nothing under that id.
        expect((await fetched(theirs.cookie, sent[0]!.id)).status).toBe(404);
        expect(await listed(theirs.cookie)).toEqual([]);
    }, 90_000);

    test('a used backup code tells the devices how many are left, the number its email gives', async () => {
        const who = await edge.account();
        const laptop = await device(who);
        const { codes } = await turnOn(laptop.cookie);
        await pinged(1);
        pings.length = 0;

        expect((await signInWithCode(who, codes[0]!)).status).toBe(200);
        const [mail] = await edge.notices('backup-code-used');
        expect(mail!.count).toBe(9);
        // The code's own notice and the new sign-in's: two events for the one registered device.
        await pinged(2);
        const events = await listed(laptop.cookie);
        expect(events.map((event) => event.kind).sort()).toEqual([
            'backup-code-used',
            'new-device',
            'two-step-on',
        ]);
        const used = events.find((event) => event.kind === 'backup-code-used')!;
        expect(used.data).toEqual({ left: mail!.count });
        expect(pings.map((ping) => ping.id)).toContain(used.id);
    }, 90_000);

    test('a relay that cannot be reached costs neither the action nor its email, and the event still waits for the device', async () => {
        const who = await edge.account();
        const laptop = await device(who);
        relay.down = true;

        await turnOn(laptop.cookie);
        expect(await edge.notices('two-step-on')).toHaveLength(1);
        expect(
            (await edge.call('GET', '/two-step', undefined, { cookie: laptop.cookie })).body.on,
        ).toBe(true);
        expect(pings).toEqual([]);
        // The device fetches what it missed when it next wakes.
        expect((await listed(laptop.cookie)).map((event) => event.kind)).toEqual(['two-step-on']);
    }, 90_000);

    test('every kind of two-step notice is one a device can fetch, in the shape its app reads', async () => {
        const { notificationsRepository } = await import('@hushos/db');
        const who = await edge.account();
        const laptop = await device(who);
        for (const kind of STEP_KINDS) {
            const data = kind === 'backup-code-used' ? { left: 0 } : {};
            const recorded = await notificationsRepository.recordEvent({
                userId: who.userId,
                kind,
                data,
            });
            // A security notice: recorded whatever the account's toggles say, and due at once.
            expect(recorded, kind).toMatchObject({ class: 'security', handles: [laptop.handle] });
            const event = await fetched(laptop.cookie, recorded!.id);
            expect(event.status, kind).toBe(200);
            expect(event.body.notification, kind).toMatchObject({ id: recorded!.id, kind, data });
        }
        // The list hands all of them over too, oldest first: one kind the schema refused would fail it whole.
        expect((await listed(laptop.cookie)).map((event) => event.kind)).toEqual([...STEP_KINDS]);
    }, 90_000);

    test('new backup codes made with a backup code: one notice, that new codes were made, and the use is in the security log', async () => {
        const who = await edge.account();
        const laptop = await device(who);
        const { codes } = await turnOn(laptop.cookie);
        await pinged(1);
        pings.length = 0;
        edge.outbox.length = 0;

        // New codes, the step answered with one of the old ones, as the settings screen sends it.
        const step = await edge.call(
            'POST',
            '/two-step/challenge',
            { purpose: 'two-step' },
            { cookie: laptop.cookie },
        );
        expect(step.status).toBe(200);
        const { proof } = await edge.passwordProof('/two-step/reauth', {}, laptop);
        const made = await edge.call(
            'POST',
            '/two-step/backup-codes',
            {
                ...proof,
                twoStep: { token: step.body.token, proof: { kind: 'backup', code: codes[0] } },
            },
            { cookie: laptop.cookie },
        );
        expect(made.status).toBe(200);
        expect(made.body.codes).toHaveLength(10);

        // The code that was used belonged to the set that is gone now. "A backup code was
        // used, 9 are left" would count codes that no longer work (and counted after the new
        // set was written it said ten, which no app can read). One notice says what happened.
        const [mail] = await edge.notices('backup-codes-made');
        expect(mail!.text).toContain('no longer work');
        await pinged(1);
        await edge.quiet();
        expect(edge.outbox.map((notice) => notice.kind)).toEqual(['backup-codes-made']);

        // The device is handed that one event, with the rest of its list.
        const list = await edge.call('GET', '', undefined, {
            cookie: laptop.cookie,
            ...NOTIFICATIONS,
        });
        expect(list.status).toBe(200);
        const events = list.body.notifications as { id: string; kind: string }[];
        expect(events.map((event) => event.kind)).toEqual(['two-step-on', 'backup-codes-made']);
        expect(pings.map((ping) => ping.id)).toEqual([events[1]!.id]);

        // The use is not lost: the account's security log has it, beside the new set.
        const log = await edge.call('GET', '/security-events', undefined, {
            cookie: laptop.cookie,
        });
        expect(
            (log.body.events as { kind: string; method: string | null }[])
                .filter((line) => line.kind.startsWith('backup-code'))
                .map((line) => `${line.kind}:${line.method}`)
                .sort(),
        ).toEqual(['backup-code-used:backup', 'backup-codes-made:null']);
        expect(
            (await edge.call('GET', '/two-step', undefined, { cookie: laptop.cookie })).body
                .backupCodesLeft,
        ).toBe(10);
    }, 90_000);

    test('a backup code that passes another change still says how many are left, from when it was used', async () => {
        const who = await edge.account();
        const laptop = await device(who);
        const { codes, secret } = await turnOn(laptop.cookie);
        await pinged(1);
        edge.outbox.length = 0;

        // Starting a new authenticator app, the step answered with a backup code: the set stays.
        const step = await edge.call(
            'POST',
            '/two-step/challenge',
            { purpose: 'two-step' },
            { cookie: laptop.cookie },
        );
        const { proof } = await edge.passwordProof('/two-step/reauth', {}, laptop);
        const started = await edge.call(
            'POST',
            '/two-step/totp',
            {
                ...proof,
                twoStep: { token: step.body.token, proof: { kind: 'backup', code: codes[0] } },
            },
            { cookie: laptop.cookie },
        );
        expect(started.status).toBe(200);
        expect(started.body.secret).not.toBe(secret);
        const [mail] = await edge.notices('backup-code-used');
        expect(mail!.count).toBe(9);
        const used = (await listed(laptop.cookie)).find(
            (event) => event.kind === 'backup-code-used',
        );
        expect(used!.data).toEqual({ left: 9 });
    }, 90_000);

    test('an event no app can read is left out by itself: the rest of the page still reaches the device', async () => {
        const { notificationsRepository } = await import('@hushos/db');
        const who = await edge.account();
        const laptop = await device(who);
        const record = (kind: 'two-step-on' | 'two-step-off' | 'backup-codes-made') =>
            notificationsRepository.recordEvent({ userId: who.userId, kind, data: {} });
        const before = await record('two-step-on');
        // A row the server would never write now: stored by a bug, or by a release that counted wrongly.
        const [bad] = await edge.db
            .insert(edge.schema.notificationEvents)
            .values({ userId: who.userId, kind: 'backup-code-used', data: { left: 10 } })
            .returning({ id: edge.schema.notificationEvents.id });
        const after = await record('two-step-off');

        // Asked for by id, it is gone, as an event past its 30 days is: the app shows its fallback.
        expect((await fetched(laptop.cookie, bad!.id)).status).toBe(404);
        expect((await fetched(laptop.cookie, after!.id)).status).toBe(200);

        // The list is not refused whole, and the events on both sides of the bad row arrive.
        const list = await edge.call('GET', '', undefined, {
            cookie: laptop.cookie,
            ...NOTIFICATIONS,
        });
        expect(list.status).toBe(200);
        expect(list.body.notifications.map((event: { id: string }) => event.id)).toEqual([
            before!.id,
            after!.id,
        ]);
        // The device's place in the list moved past the page it was handed, and nothing is repeated.
        const later = await record('backup-codes-made');
        expect((await listed(laptop.cookie)).map((event) => event.id)).toEqual([later!.id]);
    }, 90_000);

    test('an event is refused before it is stored when its data is not its kind’s, and nobody is pinged for it', async () => {
        const { notificationsRepository } = await import('@hushos/db');
        const who = await edge.account();
        const laptop = await device(who);
        const refused: [(typeof STEP_KINDS)[number], Record<string, unknown>][] = [
            // More codes left than a set holds after one is used, fewer than none, and not a count.
            ['backup-code-used', { left: 10 }],
            ['backup-code-used', { left: -1 }],
            ['backup-code-used', { left: 2.5 }],
            ['backup-code-used', {}],
            // A field no kind has: a name is exactly what must never ride along.
            ['two-step-app-removed', { name: 'HushOS Support, call 5550100' }],
            ['backup-code-used', { left: 3, device: 'evil.example' }],
        ];
        for (const [kind, data] of refused)
            await expect(
                notificationsRepository.recordEvent({ userId: who.userId, kind, data }),
                JSON.stringify([kind, data]),
            ).rejects.toThrow('notification was refused');
        expect(await edge.db.select().from(edge.schema.notificationEvents)).toEqual([]);
        expect(await listed(laptop.cookie)).toEqual([]);
    }, 90_000);
});

import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import { closeDatabase, createTestAccount, resetDatabase } from '../test/helpers';
import * as auth from './auth';
import { db } from './client';
import * as notifications from './notifications';
import { accountDevices, notificationEvents, notificationRegistrations } from './schema';

/*
 * Notifications (docs/devices-design.md 5): what each account's devices are pinged for and can
 * fetch. Every rule here is one a person would notice broken: a ping to a device they removed, a
 * stranger's event on their screen, a notice they turned off, or none at all for a security one.
 */

beforeEach(resetDatabase);
afterAll(closeDatabase);

const handle = (letter: string) => letter.repeat(43);
const shared = (granterUserId: string, shareId: string) =>
    ({ granterUserId, shareId, role: 'viewer' }) as const;

async function device(userId: string) {
    const [row] = await db
        .insert(accountDevices)
        .values({ userId })
        .returning({ id: accountDevices.id });
    return row!.id;
}

async function registered(letter: string) {
    const account = await createTestAccount();
    const deviceId = await device(account.userId);
    await notifications.putRegistration({
        userId: account.userId,
        deviceId,
        target: { handle: handle(letter) },
    });
    return { ...account, deviceId };
}

describe('pings', () => {
    test('a security notice reaches every live device of that account and no other', async () => {
        const owner = await registered('A');
        const second = await device(owner.userId);
        await notifications.putRegistration({
            userId: owner.userId,
            deviceId: second,
            target: { handle: handle('B') },
        });
        await registered('C');
        const sent = await notifications.recordEvent({ userId: owner.userId, kind: 'new-device' });
        expect(sent!.class).toBe('security');
        expect(sent!.handles.sort()).toEqual([handle('A'), handle('B')]);
    });

    test('a removed device is never pinged', async () => {
        const owner = await registered('A');
        const removed = await device(owner.userId);
        await notifications.putRegistration({
            userId: owner.userId,
            deviceId: removed,
            target: { handle: handle('B') },
        });
        await db
            .update(accountDevices)
            .set({ revokedAt: new Date() })
            .where(eq(accountDevices.id, removed));
        const sent = await notifications.recordEvent({
            userId: owner.userId,
            kind: 'device-removed',
        });
        expect(sent!.handles).toEqual([handle('A')]);
        // And the cleanup job drops its registration.
        expect(await notifications.dropRevokedRegistrations()).toBe(1);
    });

    test('signing a device out ends its registration', async () => {
        const owner = await registered('A');
        const tokenHash = Buffer.alloc(32, 7);
        await db.execute(
            `insert into sessions (user_id, device_id, token_hash, expires_at, credential_version)
             values ('${owner.userId}', '${owner.deviceId}', '\\x${tokenHash.toString('hex')}', now() + interval '1 day', 1)`,
        );
        await auth.signOutDevice(tokenHash);
        expect(
            await db
                .select()
                .from(notificationRegistrations)
                .where(eq(notificationRegistrations.deviceId, owner.deviceId)),
        ).toEqual([]);
    });

    test('an `other` ping waits while one from the last minute is unfetched, and a list reopens it', async () => {
        const owner = await registered('A');
        const t0 = new Date();
        const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);
        const record = (seconds: number) =>
            notifications.recordEvent({
                userId: owner.userId,
                kind: 'family-waiting',
                data: { groupId: owner.workspaceId },
                now: at(seconds),
            });
        expect((await record(0))!.handles).toEqual([handle('A')]);
        expect((await record(30))!.handles).toEqual([]);
        // A fetch by id alone does not answer the ping: the device has not seen the rest.
        const waiting = await record(40);
        await notifications.getEvent(owner.userId, waiting!.id);
        expect((await record(50))!.handles).toEqual([]);
        // A minute after the ping, the next goes anyway.
        expect((await record(61))!.handles).toEqual([handle('A')]);
        // A list answers it at once.
        await notifications.listPending(owner.userId, owner.deviceId);
        expect((await record(62))!.handles).toEqual([handle('A')]);
    });

    test('a security notice is never held back by an open `other` ping', async () => {
        const owner = await registered('A');
        const now = new Date();
        await notifications.recordEvent({
            userId: owner.userId,
            kind: 'family-waiting',
            data: { groupId: owner.workspaceId },
            now,
        });
        const sent = await notifications.recordEvent({
            userId: owner.userId,
            kind: 'password-attempts',
            now: new Date(now.getTime() + 1000),
        });
        expect(sent!.handles).toEqual([handle('A')]);
    });
});

describe('settings', () => {
    test('each toggle turns off its own kinds only; security notices cannot be turned off', async () => {
        const owner = await registered('A');
        const sharer = await createTestAccount();
        const share = () =>
            notifications.recordEvent({
                userId: owner.userId,
                kind: 'shared',
                data: shared(sharer.userId, sharer.workspaceId),
            });
        const invite = () =>
            notifications.recordEvent({
                userId: owner.userId,
                kind: 'family-invitation',
                data: { groupId: sharer.workspaceId, invitationId: sharer.workspaceId },
            });
        expect(await notifications.getSettings(owner.userId)).toEqual({
            shared: true,
            family: true,
        });
        await notifications.putSettings(owner.userId, { shared: false, family: true });
        expect(await share()).toBeNull();
        expect(await invite()).not.toBeNull();
        await notifications.putSettings(owner.userId, { shared: true, family: false });
        expect(await share()).not.toBeNull();
        expect(await invite()).toBeNull();
        await notifications.putSettings(owner.userId, { shared: false, family: false });
        for (const kind of ['new-device', 'device-removed', 'password-attempts'] as const)
            expect(
                await notifications.recordEvent({ userId: owner.userId, kind, data: {} }),
            ).not.toBeNull();
    });
});

describe('fetching', () => {
    test('another account’s event is never found, by id or in a list', async () => {
        const owner = await registered('A');
        const stranger = await registered('B');
        const event = await notifications.recordEvent({ userId: owner.userId, kind: 'new-device' });
        expect(await notifications.getEvent(stranger.userId, event!.id)).toBeNull();
        expect(
            (await notifications.listPending(stranger.userId, stranger.deviceId)).events,
        ).toEqual([]);
        expect((await notifications.getEvent(owner.userId, event!.id))?.kind).toBe('new-device');
    });

    test('a device’s list starts at its registration and hands each event once, oldest first', async () => {
        const owner = await createTestAccount();
        const deviceId = await device(owner.userId);
        await notifications.recordEvent({ userId: owner.userId, kind: 'new-device' });
        await notifications.putRegistration({
            userId: owner.userId,
            deviceId,
            target: { handle: handle('A') },
        });
        expect((await notifications.listPending(owner.userId, deviceId)).events).toEqual([]);
        await notifications.recordEvent({ userId: owner.userId, kind: 'device-removed' });
        await notifications.recordEvent({ userId: owner.userId, kind: 'password-attempts' });
        const first = await notifications.listPending(owner.userId, deviceId);
        expect(first.events.map((event) => event.kind)).toEqual([
            'device-removed',
            'password-attempts',
        ]);
        expect((await notifications.listPending(owner.userId, deviceId)).events).toEqual([]);
        // A new handle keeps the device's place.
        await notifications.putRegistration({
            userId: owner.userId,
            deviceId,
            target: { handle: handle('B') },
        });
        expect((await notifications.listPending(owner.userId, deviceId)).events).toEqual([]);
    });

    test('an event past 30 days is gone, and the purge deletes every one', async () => {
        const owner = await registered('A');
        for (let i = 0; i < 5; i++)
            await notifications.recordEvent({ userId: owner.userId, kind: 'new-device' });
        const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
        await db.update(notificationEvents).set({ createdAt: old });
        const [one] = await db
            .select({ id: notificationEvents.id })
            .from(notificationEvents)
            .limit(1);
        expect(await notifications.getEvent(owner.userId, one!.id)).toBeNull();
        expect(await notifications.purgeExpiredEvents(2)).toBe(5);
        expect(await db.select().from(notificationEvents)).toEqual([]);
    });
});

describe('registrations', () => {
    test('another account cannot take over a device’s registration or delete it', async () => {
        const owner = await registered('A');
        const stranger = await createTestAccount();
        await notifications.putRegistration({
            userId: stranger.userId,
            deviceId: owner.deviceId,
            target: { handle: handle('Z') },
        });
        expect(await notifications.deleteRegistration(stranger.userId, owner.deviceId)).toBe(false);
        const sent = await notifications.recordEvent({ userId: owner.userId, kind: 'new-device' });
        expect(sent!.handles).toEqual([handle('A')]);
        expect(await notifications.deleteRegistration(owner.userId, owner.deviceId)).toBe(true);
    });

    test('a handle must be a relay handle', async () => {
        const owner = await createTestAccount();
        const deviceId = await device(owner.userId);
        await expect(
            notifications.putRegistration({
                userId: owner.userId,
                deviceId,
                target: { handle: 'short' },
            }),
        ).rejects.toThrow();
    });
});

describe('web push', () => {
    const subscription = {
        endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
        p256dh: 'B'.repeat(87),
        auth: 'C'.repeat(22),
    };

    test('a browser is pushed to with its subscription; a device switching kinds keeps one', async () => {
        const owner = await createTestAccount();
        const deviceId = await device(owner.userId);
        await notifications.putRegistration({
            userId: owner.userId,
            deviceId,
            target: { webPush: subscription },
        });
        const sent = await notifications.recordEvent({ userId: owner.userId, kind: 'new-device' });
        expect(sent!.handles).toEqual([]);
        expect(sent!.webPush).toEqual([{ deviceId, ...subscription }]);
        // Now reached through the relay: the subscription is gone with it.
        await notifications.putRegistration({
            userId: owner.userId,
            deviceId,
            target: { handle: handle('A') },
        });
        const again = await notifications.recordEvent({ userId: owner.userId, kind: 'new-device' });
        expect(again!.handles).toEqual([handle('A')]);
        expect(again!.webPush).toEqual([]);
    });

    test('a subscription its push service dropped is deleted, and only that one', async () => {
        const owner = await createTestAccount();
        const deviceId = await device(owner.userId);
        await notifications.putRegistration({
            userId: owner.userId,
            deviceId,
            target: { webPush: subscription },
        });
        await notifications.dropWebSubscription(
            deviceId,
            'https://fcm.googleapis.com/fcm/send/other',
        );
        expect(
            (await notifications.recordEvent({ userId: owner.userId, kind: 'new-device' }))!
                .webPush,
        ).toHaveLength(1);
        await notifications.dropWebSubscription(deviceId, subscription.endpoint);
        expect(
            (await notifications.recordEvent({ userId: owner.userId, kind: 'new-device' }))!
                .webPush,
        ).toEqual([]);
    });

    test('the table refuses a subscription that is not one, and a row that is both or neither', async () => {
        const owner = await createTestAccount();
        const deviceId = await device(owner.userId);
        for (const bad of [
            { ...subscription, endpoint: 'http://fcm.googleapis.com/x' },
            { ...subscription, p256dh: 'short' },
            { ...subscription, auth: 'C'.repeat(30) },
        ])
            await expect(
                notifications.putRegistration({
                    userId: owner.userId,
                    deviceId,
                    target: { webPush: bad },
                }),
            ).rejects.toThrow();
        await expect(
            db.insert(notificationRegistrations).values({
                deviceId,
                userId: owner.userId,
                handle: handle('A'),
                webEndpoint: subscription.endpoint,
                webP256dh: subscription.p256dh,
                webAuth: subscription.auth,
            }),
        ).rejects.toThrow();
        await expect(
            db.insert(notificationRegistrations).values({ deviceId, userId: owner.userId }),
        ).rejects.toThrow();
    });

    test('the VAPID pair is made once and never replaced', async () => {
        let made = 0;
        const make = () => {
            made += 1;
            return { privateKey: `p${made}`, publicKey: `k${made}` };
        };
        const first = await notifications.vapidKeyPair(make);
        const second = await notifications.vapidKeyPair(make);
        expect(second).toEqual(first);
        expect(made).toBe(1);
    });
});

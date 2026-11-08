import { checkClient, parseMinimums } from '@hushos/drive/protocol';
import { GROUP_WRITE_HEADER, GROUP_WRITE_PROTOCOL } from '@hushos/groups/protocol';
import { describe, expect, test } from 'vitest';
// The source, not the module: importing the handlers needs a whole server environment.
import clientSource from './api-client.ts?raw';
import { followsGroupWrites, groupWriteMinimums } from './group-write-floor';
import { HUSHOS_VERSION } from './version';

/*
 * The client floor on family-changing routes (docs/optional-verification.md
 * 7.3): a web tab that follows older family-write rules (it sends an older
 * number, or none) is refused with 426 on the routes that let people in,
 * change roles or seal family keys, and served everywhere else, Drive and the
 * join's own routes included, whatever release version it names: hushos.com
 * deploys without bumping it. Only `web/` is held to the number, so an iOS
 * 0.10.0 phone keeps joining. GROUP_WRITE_CLIENT_MINIMUMS only raises the
 * version floor.
 */

const none = parseMinimums(undefined);

describe('the family-write number', () => {
    test('a web tab without it, or with an older one, is refused; this one passes, whatever the release', () => {
        // The same release version on both: only the number tells them apart.
        expect(checkClient(`web/${HUSHOS_VERSION}`, groupWriteMinimums(none, none))).toMatchObject({
            ok: true,
        });
        expect(followsGroupWrites('web', null)).toBe(false);
        expect(followsGroupWrites('web', undefined)).toBe(false);
        expect(followsGroupWrites('web', '')).toBe(false);
        expect(followsGroupWrites('web', String(GROUP_WRITE_PROTOCOL - 1))).toBe(false);
        expect(followsGroupWrites('web', 'two')).toBe(false);
        expect(followsGroupWrites('web', '2.5')).toBe(false);
        expect(followsGroupWrites('web', String(GROUP_WRITE_PROTOCOL))).toBe(true);
        // A later tab against this server (a rollback): served, as a newer release is.
        expect(followsGroupWrites('web', String(GROUP_WRITE_PROTOCOL + 1))).toBe(true);
    });

    test('the phones aren’t asked for it: iOS 0.10.0 sends none and keeps joining', () => {
        expect(followsGroupWrites('ios', null)).toBe(true);
        expect(followsGroupWrites('android', null)).toBe(true);
    });

    test('the web client sends it on every request', () => {
        expect(GROUP_WRITE_HEADER).toBe('HushOS-Group-Write');
        expect(clientSource).toMatch(
            /headers: \{\s*\[CLIENT_HEADER\]: `web\/\$\{HUSHOS_VERSION\}`,\s*\[GROUP_WRITE_HEADER\]: String\(GROUP_WRITE_PROTOCOL\),\s*\}/,
        );
    });
});

describe('the family-change version floor', () => {
    test('has none built in: today’s release is served, and every client name is served unless an operator sets one', () => {
        const floor = groupWriteMinimums(none, none);
        expect(floor.size).toBe(0);
        expect(checkClient(`web/${HUSHOS_VERSION}`, floor)).toMatchObject({ ok: true });
        expect(checkClient('ios/0.10.0', floor)).toMatchObject({ ok: true });
        const set = groupWriteMinimums(none, parseMinimums('ios/0.11.0'));
        expect(checkClient('ios/0.10.0', set)).toMatchObject({ status: 426 });
    });

    test('GROUP_WRITE_CLIENT_MINIMUMS raises it over DRIVE_CLIENT_MINIMUMS and never lowers it', () => {
        const raised = groupWriteMinimums(none, parseMinimums('web/999.0.0'));
        expect(checkClient(`web/${HUSHOS_VERSION}`, raised)).toMatchObject({ status: 426 });
        // Lower than Drive's own: Drive's stands.
        const lowered = groupWriteMinimums(parseMinimums('web/2.0.0'), parseMinimums('web/1.0.0'));
        expect(lowered.get('web')).toBe('2.0.0');
        // A pre-1.0 protocol floor is below every product version.
        expect(
            groupWriteMinimums(parseMinimums('web/1.0.0'), parseMinimums('web/9')).get('web'),
        ).toBe('1.0.0');
        // Drive's own minimum, when higher, is the floor here as well.
        expect(groupWriteMinimums(parseMinimums('web/999.1.0'), none).get('web')).toBe('999.1.0');
    });
});

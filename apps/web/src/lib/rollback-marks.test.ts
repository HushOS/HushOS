import { beforeEach, describe, expect, test } from 'vitest';
import {
    identityRolledBack,
    identitySeen,
    rememberIdentitySeen,
    rememberSettingsSeen,
    settingsSeen,
} from './rollback-marks';

/*
 * A server keeps the settings and the identity, and would like to hand back
 * an older copy of either. What a device has seen must only ever go up, per
 * account, whatever identity the account has now.
 */
const MAYA = '0f6d6c1e-2a49-4d8b-9b1a-4b3f4b8c1d01';
const SAM = '0f6d6c1e-2a49-4d8b-9b1a-4b3f4b8c1d02';

describe('rollback marks', () => {
    beforeEach(() => window.localStorage.clear());

    test('the settings mark is never lowered', () => {
        rememberSettingsSeen(MAYA, 5);
        rememberSettingsSeen(MAYA, 3);
        expect(settingsSeen(MAYA)).toBe(5);
    });

    test('marks kept per identity before carry over at their highest, and survive a new identity', () => {
        // What an earlier version kept: one mark per identity key the account had.
        window.localStorage.setItem(`hushos.settings-seen:${MAYA}:first-identity-key`, '7');
        window.localStorage.setItem(`hushos.settings-seen:${MAYA}:second-identity-key`, '4');
        // Another account's marks are not this one's.
        window.localStorage.setItem(`hushos.settings-seen:${SAM}:sams-key`, '40');
        expect(settingsSeen(MAYA)).toBe(7);
        // A succession leaves no fresh count behind: the account's mark is what is read.
        rememberSettingsSeen(MAYA, 2);
        expect(settingsSeen(MAYA)).toBe(7);
        expect(settingsSeen(SAM)).toBe(40);
    });

    test('an own identity served below the highest key version opened is refused', () => {
        rememberIdentitySeen(MAYA, 3);
        rememberIdentitySeen(MAYA, 2);
        expect(identitySeen(MAYA)).toBe(3);
        expect(identityRolledBack(2, identitySeen(MAYA))).toBe(true);
        expect(identityRolledBack(3, identitySeen(MAYA))).toBe(false);
        expect(identityRolledBack(4, identitySeen(MAYA))).toBe(false);
        // A new device has no mark, and refuses nothing: that is inherent.
        expect(identityRolledBack(1, identitySeen(SAM))).toBe(false);
    });
});

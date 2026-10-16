import { beforeEach, describe, expect, test } from 'vitest';
import {
    identityRolledBack,
    identitySeen,
    identityVersionSeen,
    rememberIdentitySeen,
    rememberSettingsDocumentSeen,
    rememberSettingsSeen,
    settingsDocumentRolledBack,
    settingsDocumentSeen,
    settingsNoneTrusted,
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

    test('once a settings document opened here, none or a version 1 document is an older copy', () => {
        expect(settingsDocumentSeen(MAYA)).toBe(false);
        expect(settingsDocumentRolledBack('none', settingsDocumentSeen(MAYA))).toBe(false);
        rememberSettingsDocumentSeen(MAYA);
        expect(settingsDocumentSeen(MAYA)).toBe(true);
        expect(settingsDocumentSeen(SAM)).toBe(false);
        expect(settingsDocumentRolledBack('none', true)).toBe(true);
        expect(settingsDocumentRolledBack(1, true)).toBe(true);
        expect(settingsDocumentRolledBack(2, true)).toBe(false);
    });

    test('"no settings" is a reading only for a brand-new account on a device that has seen nothing', () => {
        expect(settingsNoneTrusted(0, 0, false)).toBe(true);
        // None served at a sequence above 0: a version 1 document, or settings withheld.
        expect(settingsNoneTrusted(3, 3, false)).toBe(false);
        expect(settingsNoneTrusted(4, 0, false)).toBe(false);
        // This device saw a sequence or a document before.
        expect(settingsNoneTrusted(0, 2, false)).toBe(false);
        expect(settingsNoneTrusted(0, 0, true)).toBe(false);
    });

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

    test('an own identity served below the highest key version seen is refused', () => {
        rememberIdentitySeen(MAYA, 3, 2);
        rememberIdentitySeen(MAYA, 2, 2);
        expect(identitySeen(MAYA)).toBe(3);
        const seen = { keyVersion: identitySeen(MAYA), identityVersion: identityVersionSeen(MAYA) };
        expect(identityRolledBack({ keyVersion: 2, identityVersion: 2 }, seen)).toBe(true);
        expect(identityRolledBack({ keyVersion: 3, identityVersion: 2 }, seen)).toBe(false);
        expect(identityRolledBack({ keyVersion: 4, identityVersion: 2 }, seen)).toBe(false);
        // Another account's marks are its own.
        expect(identitySeen(SAM)).toBe(0);
    });

    test('the version 1 form of an identity this device has seen upgraded is refused at the same key version', () => {
        // The upgrade keeps the key version: only the identity version tells them apart.
        rememberIdentitySeen(MAYA, 3, 2);
        const seen = { keyVersion: identitySeen(MAYA), identityVersion: identityVersionSeen(MAYA) };
        expect(identityRolledBack({ keyVersion: 3, identityVersion: 1 }, seen)).toBe(true);
        // Nor at a higher key version: no version 1 identity can follow a version 2 one.
        expect(identityRolledBack({ keyVersion: 4, identityVersion: 1 }, seen)).toBe(true);
        // A device that has only ever seen version 1 lets it through, to upgrade it.
        rememberIdentitySeen(SAM, 3, 1);
        const sams = { keyVersion: identitySeen(SAM), identityVersion: identityVersionSeen(SAM) };
        expect(identityRolledBack({ keyVersion: 3, identityVersion: 1 }, sams)).toBe(false);
        // And a mark is never lowered by a later, lower write.
        rememberIdentitySeen(MAYA, 3, 1);
        expect(identityVersionSeen(MAYA)).toBe(2);
    });
});

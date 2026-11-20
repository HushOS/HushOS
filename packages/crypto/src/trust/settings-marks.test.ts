import { describe, expect, test } from 'vitest';
import { familyCheckOf, settingsMarks, settingsPinOf } from './settings-marks';

/*
 * The settings members acceptance reads as marks, read as the core reads them
 * (crates/hushos-core/src/ledger_settings.rs): `groups` and `familyChecks`
 * only from a plain object. Spreading an array or a string would file its
 * items under "0", "1", …: a check record nobody made, which keeps a family
 * from first use on one twin and not the other.
 */
describe('settings marks', () => {
    const ACCOUNT = '00000001-abcd-4abc-8abc-abcdefabcdef';
    const GROUP = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
    const read = (settings: Record<string, unknown>) => settingsMarks(null, ACCOUNT, settings);

    test('family checks that are no object are no checks, whatever the probe', () => {
        // The input the fuzz differential reported, probed by the index it would spread to and by a family id.
        for (const familyChecks of [[{}], 'ab', 7, null]) {
            const marks = read({ version: 2, contacts: {}, familyChecks });
            for (const id of ['0', GROUP])
                expect(familyCheckOf(marks, id), JSON.stringify([familyChecks, id])).toEqual({
                    checked: false,
                    pairMarks: [],
                });
        }
        // An object's record is still one.
        const filed = read({
            version: 2,
            familyChecks: { [GROUP]: { how: 'before', rosterVersion: 2 } },
        });
        expect(familyCheckOf(filed, GROUP)).toEqual({ checked: true, pairMarks: [] });
    });

    test('group pins that are no object are no pins', () => {
        const pin = { rosterVersion: 2 };
        for (const groups of [[pin], 'ab'])
            for (const id of ['0', GROUP])
                expect(
                    settingsPinOf(read({ version: 2, groups }), id),
                    JSON.stringify([groups, id]),
                ).toBeNull();
        expect(settingsPinOf(read({ version: 2, groups: { [GROUP]: pin } }), GROUP)).toEqual(pin);
    });
});

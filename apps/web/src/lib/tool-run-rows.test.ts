import { describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/auth-client', () => ({ authClient: { store: { subscribe: () => () => {} } } }));
vi.mock('@/lib/device-data', () => ({ onSignedOutElsewhere: () => () => {} }));

import { forgetOnLeaving, toolRunRows } from './tool-run-rows';

/* A run's row names a file: it goes with the account, in whichever tab and however the account goes. */
describe('a run’s rows are forgotten when the account leaves this tab', () => {
    function rig() {
        let listener:
            | ((
                  state: { unlockedUserId: string | null },
                  previous: { unlockedUserId: string | null },
              ) => void)
            | null = null;
        let elsewhere: (() => unknown) | null = null;
        const forget = vi.fn();
        forgetOnLeaving(
            { subscribe: (each) => ((listener = each), () => {}) },
            (each) => (elsewhere = each),
            forget,
        );
        return {
            change: (from: string | null, to: string | null) =>
                listener!({ unlockedUserId: to }, { unlockedUserId: from }),
            elsewhere: () => elsewhere!(),
            forget,
        };
    }

    test('on a lock, another account unlocking, and another tab signing out; not on the first unlock', () => {
        const lock = rig();
        lock.change(null, 'maya');
        expect(lock.forget).not.toHaveBeenCalled();
        lock.change('maya', null);
        expect(lock.forget).toHaveBeenCalledOnce();
        const switched = rig();
        switched.change('maya', 'sam');
        expect(switched.forget).toHaveBeenCalledOnce();
        const remote = rig();
        remote.elsewhere();
        expect(remote.forget).toHaveBeenCalledOnce();
    });

    test('a Stop confirmed after the run ended leaves its row as it ended', () => {
        const cancel = vi.fn();
        const row = toolRunRows.add(
            {
                title: 'Making Trip.pdf',
                cancelQuestion: '',
                cancelWarning: '',
                phase: 'making',
                line: '',
                progress: null,
                uploadId: null,
            },
            cancel,
        );
        row.update({ phase: 'done', line: 'Saved in My files' });
        toolRunRows.cancel(row.id);
        expect(cancel).not.toHaveBeenCalled();
        expect(toolRunRows.getState().find((each) => each.id === row.id)?.phase).toBe('done');
        toolRunRows.forget();
        expect(toolRunRows.getState()).toEqual([]);
    });
});

import { describe, expect, test, vi } from 'vitest';

vi.mock('@/lib/auth-client', () => ({ authClient: { store: { subscribe: () => () => {} } } }));
vi.mock('@/lib/device-data', () => ({ onSignedOutElsewhere: () => () => {} }));
/* The transfer manager's list, as far as rows go: an upload is removed only once it has settled. */
const uploads = vi.hoisted(() => new Map<string, { name: string; status: string }>());
vi.mock('@/lib/transfers', () => ({
    transfers: {
        cancel: async (id: string) => {
            const upload = uploads.get(id);
            if (upload && upload.status === 'uploading') upload.status = 'cancelled';
        },
        remove: (id: string) => {
            const upload = uploads.get(id);
            if (upload && upload.status !== 'uploading') uploads.delete(id);
        },
    },
}));

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

    test('a lock takes the PDF’s name off the screen: its row and the upload it claimed, saved or on its way', async () => {
        uploads.set('up-saved', { name: 'Trip.pdf', status: 'done' });
        uploads.set('up-going', { name: 'Holiday.pdf', status: 'uploading' });
        const blank = { cancelQuestion: '', cancelWarning: '', line: '', progress: null } as const;
        toolRunRows.add(
            { ...blank, title: 'Making Trip.pdf', phase: 'done', uploadId: 'up-saved' },
            () => {},
        );
        toolRunRows.add(
            { ...blank, title: 'Making Holiday.pdf', phase: 'saving', uploadId: 'up-going' },
            () => {},
        );
        toolRunRows.forget();
        await vi.waitFor(() => expect(uploads.size).toBe(0));
        expect(toolRunRows.getState()).toEqual([]);
        expect([...uploads.values()].map((upload) => upload.name)).toEqual([]);
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

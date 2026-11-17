import { describe, expect, test, vi } from 'vitest';
import { holdPageWhile } from './leave-guard';

/*
 * Leaving the page asks once while anything would be lost: an upload or a tool's
 * result waiting to upload (lib/transfers.ts), or a tool's result not yet handed
 * over (lib/tools/run.ts). Fails if either is forgotten, if the page is held
 * when neither holds anything, or if two listeners would show two prompts.
 */
describe('the one leave prompt', () => {
    const leave = () => {
        const event = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
    };

    test('asks while either holds something, and only then, through one listener', () => {
        const added = vi.spyOn(window, 'addEventListener');
        let uploading = false;
        let unreleased = 0;
        const letGoUploads = holdPageWhile(() => uploading);
        const letGoTools = holdPageWhile(() => unreleased > 0);
        expect(added.mock.calls.filter(([type]) => type === 'beforeunload')).toHaveLength(1);
        expect(leave()).toBe(false);
        uploading = true;
        expect(leave()).toBe(true);
        uploading = false;
        unreleased = 2;
        expect(leave()).toBe(true);
        unreleased = 0;
        expect(leave()).toBe(false);
        letGoUploads();
        letGoTools();
    });
});

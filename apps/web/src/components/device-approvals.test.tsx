import type { ApprovalPrompt } from '@hushos/auth/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * Another device's request to confirm it's you, in the app (docs/two-step-design.md 12). The
 * line that says one is waiting must show on a server that no longer lets accounts turn the
 * step on, since such an account is still asked for it; and the prompt must never show a name a
 * stranger chose as if it were one of the account's own devices.
 */

const asked = (over: Partial<ApprovalPrompt> = {}): ApprovalPrompt => ({
    id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
    purpose: 'login',
    class: 'unknown',
    device: { kind: 'web', name: 'Maya’s Laptop' },
    location: null,
    selfNamed: true,
    chosen: false,
    createdAt: '2026-11-14T10:00:00.000Z',
    expiresAt: '2026-11-14T10:05:00.000Z',
    tokenDigest: 'A'.repeat(43),
    commitment: 'B'.repeat(43),
    approverKey: null,
    reveal: null,
    ...over,
});
const api = {
    approvals: vi.fn<() => Promise<ApprovalPrompt[]>>(),
    openApproval: vi.fn(() => new Promise<never>(() => {})),
};
vi.mock('@/lib/auth-client', () => ({ authClient: api }));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: { add: vi.fn() } }));
// This server does not let accounts turn the step on (TWO_STEP_ENABLED is off).
const enabled = vi.fn(() => false);
vi.mock('@/lib/two-step', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    useTwoStepEnabled: () => enabled(),
}));
const { ApprovalBanner } = await import('./device-approvals');

const view = () =>
    render(
        <QueryClientProvider
            client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
            <ApprovalBanner />
        </QueryClientProvider>,
    );

beforeEach(() => {
    api.approvals.mockReset();
    api.openApproval.mockClear();
    localStorage.clear();
});

describe('another device waiting for an answer', () => {
    test('is shown and can be answered where the server no longer offers the step', async () => {
        api.approvals.mockResolvedValue([asked()]);
        view();
        expect(
            await screen.findByText('Another device is asking to confirm it’s you'),
        ).toBeTruthy();
        expect(api.approvals).toHaveBeenCalled();
        await userEvent.setup().click(screen.getByRole('button', { name: 'Answer' }));
        expect(await screen.findByRole('dialog')).toBeTruthy();
        expect(api.openApproval).toHaveBeenCalledTimes(1);
    });

    test('a name the asking device chose is shown as its own words, and a known device’s as its name', async () => {
        const person = userEvent.setup();
        // Someone with the password calls their browser by the name of the owner's laptop.
        api.approvals.mockResolvedValue([asked({ location: 'near Lyon, France' })]);
        const first = view();
        await person.click(await screen.findByRole('button', { name: 'Answer' }));
        expect(
            await screen.findByRole('heading', {
                name: 'Sign-in on a new device calling itself “Maya’s Laptop”, near Lyon, France',
            }),
        ).toBeTruthy();
        expect(screen.queryByText(/asked for this device/)).toBeNull();
        first.unmount();

        // The account's own laptop, turning the method on and asking for this device.
        api.approvals.mockResolvedValue([
            asked({ purpose: 'device-approval', class: 'change', selfNamed: false, chosen: true }),
        ]);
        view();
        await person.click(await screen.findByRole('button', { name: 'Answer' }));
        expect(
            await screen.findByRole('heading', {
                name: 'Turn on Approve on another device on Maya’s Laptop',
            }),
        ).toBeTruthy();
        expect(screen.getByText('The other device asked for this device to approve.')).toBeTruthy();
    });
});

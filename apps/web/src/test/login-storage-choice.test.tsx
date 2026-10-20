import { DeviceStorageUnreadable } from '@hushos/auth/client';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

/*
 * The sign-in page when this browser's device key could not be read: "Sign in as a new device"
 * beside "Try again". The choice belongs to the press that made it; one that fails validation
 * must not turn the next "Try again" into a new device. Kept outside src/routes so TanStack
 * does not take it for a route; the router is stood in for, the page is the real one.
 */
const login =
    vi.fn<
        (email: string, password: string, options?: { asNewDevice?: boolean }) => Promise<void>
    >();
vi.mock('@tanstack/react-router', () => ({
    createFileRoute: () => (options: Record<string, unknown>) => ({
        ...options,
        useSearch: () => ({}),
    }),
    redirect: vi.fn(),
    useRouter: () => ({
        options: {
            context: { queryClient: { clear: vi.fn(), fetchQuery: vi.fn(async () => null) } },
        },
        navigate: vi.fn(async () => {}),
    }),
    Link: ({ children }: { children: ReactNode }) => <a href="/">{children}</a>,
}));
vi.mock('@/lib/auth-client', () => ({
    authClient: {
        login: (...args: Parameters<typeof login>) => login(...args),
        session: async () => ({ user: null }),
        takeRemovedNotice: () => false,
    },
}));
vi.mock('@/lib/session', () => ({ ensureSessionUser: vi.fn(), sessionQueryOptions: {} }));
vi.mock('@/lib/social', () => ({ cardMeta: () => [], publicOrigin: () => 'http://localhost' }));
vi.mock('@/lib/sounds', () => ({ cue: vi.fn() }));
const { Route } = await import('@/routes/login/route');
const LoginPage = (Route as unknown as { component: () => ReactNode }).component;

beforeEach(() => {
    login.mockReset();
    login.mockRejectedValueOnce(new DeviceStorageUnreadable('timeout'));
    login.mockResolvedValue(undefined);
});

async function refusedOnce() {
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.type(screen.getByLabelText('Email'), 'maya@example.com');
    const password = screen.getByLabelText('Password');
    await user.type(password, 'correct horse');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('button', { name: 'Sign in as a new device' });
    expect(screen.getByText(/didn’t answer in time/)).toBeInTheDocument();
    expect(login).toHaveBeenLastCalledWith('maya@example.com', 'correct horse', {
        asNewDevice: false,
    });
    return { user, password };
}

describe('signing in when the device key could not be read', () => {
    test('a new-device press that fails validation does not make the next try a new device', async () => {
        const { user, password } = await refusedOnce();
        await user.clear(password);
        await user.click(screen.getByRole('button', { name: 'Sign in as a new device' }));
        await screen.findByText('Enter your password.');
        expect(login).toHaveBeenCalledTimes(1);

        await user.type(password, 'correct horse');
        await user.click(screen.getByRole('button', { name: 'Try again' }));
        await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(2));
        expect(login).toHaveBeenLastCalledWith('maya@example.com', 'correct horse', {
            asNewDevice: false,
        });
    });

    test('the new-device press signs in as a new device', async () => {
        const { user } = await refusedOnce();
        await user.click(screen.getByRole('button', { name: 'Sign in as a new device' }));
        await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(2));
        expect(login).toHaveBeenLastCalledWith('maya@example.com', 'correct horse', {
            asNewDevice: true,
        });
    });
});

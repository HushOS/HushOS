import { createServerFn } from '@tanstack/react-start';
import {
    getCookie,
    getRequestProtocol,
    setCookie,
    setResponseHeader,
} from '@tanstack/react-start/server';

export type Theme = 'light' | 'dark' | 'system';

export function isTheme(value: unknown): value is Theme {
    return value === 'light' || value === 'dark' || value === 'system';
}

export const getThemeServerFn = createServerFn().handler(() => {
    setResponseHeader('Cache-Control', 'private, no-store');
    const theme = getCookie('hushos-theme');
    return isTheme(theme) ? theme : 'system';
});

export const setThemeServerFn = createServerFn({ method: 'POST' })
    .validator((value: unknown) => {
        if (!isTheme(value)) throw new Error('Invalid theme preference.');
        return value;
    })
    .handler(({ data }) => {
        setCookie('hushos-theme', data, {
            path: '/',
            maxAge: 60 * 60 * 24 * 365,
            sameSite: 'lax',
            httpOnly: true,
            secure: getRequestProtocol() === 'https',
        });
    });

/* The sidebar writes `sidebar_state` itself; the server reads it so the first paint matches. */
export const getSidebarStateServerFn = createServerFn().handler(() => {
    setResponseHeader('Cache-Control', 'private, no-store');
    return getCookie('sidebar_state') !== 'false';
});

import { useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';

/*
 * theme-color as the page actually paints: body's background (identities.css,
 * Browser edges), whatever the route, the identity, the chosen appearance or the
 * computer's light and dark. Safari reads body itself; Chrome on Android and an
 * installed app colour their bars from theme-color, so the two stay one colour.
 * The server's tags are right for the first paint; this follows every change after.
 */
export function ThemeColor() {
    const path = useRouterState({ select: (state) => state.location.pathname });
    useEffect(() => {
        let frame = 0;
        const sync = () => {
            cancelAnimationFrame(frame);
            // After the new route or class has painted, so body's colour is the new one.
            frame = requestAnimationFrame(() => {
                const colour = getComputedStyle(document.body).backgroundColor;
                for (const meta of document.querySelectorAll<HTMLMetaElement>(
                    'meta[name="theme-color"]',
                ))
                    if (meta.content !== colour) meta.content = colour;
            });
        };
        sync();
        const queries = ['(prefers-color-scheme: dark)', '(prefers-contrast: more)'].map((query) =>
            matchMedia(query),
        );
        for (const query of queries) query.addEventListener('change', sync);
        // The appearance and high contrast switches change the root's classes in place.
        const observer = new MutationObserver(sync);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class'],
        });
        return () => {
            cancelAnimationFrame(frame);
            for (const query of queries) query.removeEventListener('change', sync);
            observer.disconnect();
        };
    }, [path]);
    return null;
}

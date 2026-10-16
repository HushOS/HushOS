import { useRouter } from '@tanstack/react-router';
import { useEffect } from 'react';

/*
 * theme-color as the page actually paints: body's background (identities.css,
 * Browser edges), whatever the route, the identity, the chosen appearance or the
 * computer's light and dark. Safari reads body itself; Chrome on Android and an
 * installed app colour their bars from theme-color, so the two stay one colour.
 * The server's tags carry the plain ground, so a public page in light (white or an
 * identity's colour) shows that ground until this runs after hydration; from then
 * on this follows every change.
 */
export function ThemeColor() {
    const router = useRouter();
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
        // When a navigation has rendered its page, not when it starts: a route still
        // loading would otherwise be sampled as the page it is leaving.
        const unsubscribe = router.subscribe('onRendered', sync);
        // The app's body changes colour at md (identities.css, Browser edges).
        const queries = [
            '(prefers-color-scheme: dark)',
            '(prefers-contrast: more)',
            '(min-width: 48rem)',
        ].map((query) => matchMedia(query));
        for (const query of queries) query.addEventListener('change', sync);
        // The appearance and high contrast switches change the root's classes in place.
        const observer = new MutationObserver(sync);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['class'],
        });
        return () => {
            cancelAnimationFrame(frame);
            unsubscribe();
            for (const query of queries) query.removeEventListener('change', sync);
            observer.disconnect();
        };
    }, [router]);
    return null;
}

import { useEffect, useRef } from 'react';

/*
 * Runs when the browser brings the page back from its back-forward cache, as it
 * does after the back button from an external site. React state survives that
 * trip, so a busy flag set just before a redirect would leave the page stuck on
 * "Opening…" unless something clears it here.
 */
export function usePageRestored(onRestore: () => void) {
    const latest = useRef(onRestore);
    useEffect(() => {
        latest.current = onRestore;
    }, [onRestore]);
    useEffect(() => {
        const handle = (event: PageTransitionEvent) => {
            if (event.persisted) latest.current();
        };
        window.addEventListener('pageshow', handle);
        return () => window.removeEventListener('pageshow', handle);
    }, []);
}

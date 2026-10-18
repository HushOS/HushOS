import { useSyncExternalStore } from 'react';

const MOBILE_BREAKPOINT = 768;
const DESKTOP_BREAKPOINT = 1024;

/* Whether `query` matches; false on the server and the first client render, which hydrate alike. */
function useMediaQuery(query: string) {
    return useSyncExternalStore(
        (onChange) => {
            const media = window.matchMedia(query);
            media.addEventListener('change', onChange);
            return () => media.removeEventListener('change', onChange);
        },
        () => window.matchMedia(query).matches,
        () => false,
    );
}

export function useIsMobile() {
    return useMediaQuery(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
}

/* Between a phone and a desk: 768 to 1023px wide. */
export function useIsTablet() {
    return useMediaQuery(
        `(min-width: ${MOBILE_BREAKPOINT}px) and (max-width: ${DESKTOP_BREAKPOINT - 1}px)`,
    );
}

'use client';

import Script from 'next/script';

import { clientEnvs } from '@/env/client';
import { PlausibleArgs, TrackEvent } from '@/lib/types';

const excludedPages = ['/drive**'];

export function Analytics() {
    if (!clientEnvs.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL) {
        return null;
    }

    return (
        <Script
            strategy='afterInteractive'
            data-domain={clientEnvs.NEXT_PUBLIC_DOMAIN}
            src={clientEnvs.NEXT_PUBLIC_PLAUSIBLE_SCRIPT_URL}
            data-exclude={excludedPages.join(', ')}
            onLoad={() => {
                window.plausible =
                    window.plausible ||
                    function () {
                        window.plausible = () => {};
                        (window.plausible.q = window.plausible?.q || []).push(
                            arguments as unknown as PlausibleArgs
                        );
                    };
            }}
        />
    );
}

export function trackEvent(event: TrackEvent) {
    if (typeof window === 'undefined') {
        return;
    }

    window.plausible?.(event);
}

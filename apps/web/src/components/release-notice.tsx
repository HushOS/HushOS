import { useLocation } from '@tanstack/react-router';
import { RefreshCwIcon } from 'lucide-react';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { reloadIfStale, useReleaseStale } from '@/lib/release';
import { useTransfers } from '@/lib/transfers';

/*
 * The app after a deploy: the page reloads itself on the next navigation once
 * nothing is uploading, and says so meanwhile, so nobody is left on a page the
 * server no longer speaks to. An upload in flight is never interrupted; the
 * journal would bring it back, but there is no need to make it.
 */
export function ReleaseNotice() {
    const stale = useReleaseStale();
    const { active } = useTransfers();
    const { pathname } = useLocation();
    useEffect(() => {
        reloadIfStale(active > 0);
    }, [pathname, active, stale]);
    if (!stale) return null;
    return (
        <div
            aria-live="polite"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-muted/60 px-5 py-2 text-sm sm:px-8"
        >
            <span>
                HushOS was updated.{' '}
                {active > 0
                    ? 'The page will reload once your uploads finish.'
                    : 'The page reloads when you open another section, or now.'}
            </span>
            <Button
                size="xs"
                variant="outline"
                disabled={active > 0}
                onClick={() => window.location.reload()}
            >
                <RefreshCwIcon aria-hidden="true" />
                Reload now
            </Button>
        </div>
    );
}

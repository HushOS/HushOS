import { RefreshCwIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useReleaseStale } from '@/lib/release';
import { useTransfers } from '@/lib/transfers';

/*
 * The app after a deploy: a line says so and offers a reload, and that is
 * all. The page never reloads itself: a reload mid-upload lost or doubled
 * transfers, and a reload always locks the vault, which read as being thrown
 * out. The server refuses a client that is too old, so a stale page fails
 * clearly rather than oddly.
 */
export function ReleaseNotice() {
    const stale = useReleaseStale();
    const { active } = useTransfers();
    if (!stale) return null;
    return (
        <div
            aria-live="polite"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule bg-muted px-5 py-2 text-sm sm:px-6"
        >
            <span>
                HushOS was updated.{' '}
                {active > 0
                    ? 'Reload once your uploads finish to get the new version.'
                    : 'Reload when convenient to get the new version.'}
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

import { XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import {
    dismissWebPushAsk,
    shouldOfferWebPush,
    turnOnWebPush,
    WEB_PUSH_CHANGED,
} from '@/lib/web-push';

/*
 * The once-only offer to turn notifications on in this browser (docs/devices-design.md 5,
 * Settings): a line in the app shell with Turn on, which asks the browser's permission from the
 * click (lib/web-push.ts turnOnWebPush, as Account's switch does), and a close button. Shown only
 * where it can work and nothing was decided (shouldOfferWebPush). Closing it, or a Turn on that
 * fails (a declined prompt, a browser with no push service), puts it away for good on this browser
 * for this account; Account → Notifications still turns them on.
 */
export function NotificationsAsk({ userId }: { userId: string }) {
    const [shown, setShown] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let current = true;
        const check = () =>
            void shouldOfferWebPush(userId)
                .then((offer) => current && setShown(offer))
                .catch(() => {});
        check();
        // Turned on from Account meanwhile, or the browser's permission changed there: asked again.
        window.addEventListener(WEB_PUSH_CHANGED, check);
        return () => {
            current = false;
            window.removeEventListener(WEB_PUSH_CHANGED, check);
        };
    }, [userId]);

    if (!shown) return null;

    function close() {
        dismissWebPushAsk(userId);
        setShown(false);
    }

    async function turnOn() {
        setBusy(true);
        try {
            await turnOnWebPush(userId);
            setShown(false);
        } catch (cause) {
            close();
            toast.add({
                type: 'error',
                title: 'Notifications didn’t turn on',
                description: `${cause instanceof Error ? cause.message : 'Please try again.'} You can turn them on later in Account.`,
            });
        } finally {
            setBusy(false);
        }
    }

    return (
        <section
            aria-label="Notifications"
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule bg-muted py-2 ps-5 pe-2 text-sm sm:ps-6"
        >
            <span className="min-w-0 flex-1">
                Get notified about new sign-ins and things shared with you
            </span>
            <div className="flex items-center gap-1">
                {/* Outline, as the release notice's: the page under it keeps its one blue button. */}
                <Button size="xs" variant="outline" disabled={busy} onClick={() => void turnOn()}>
                    Turn on
                </Button>
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Close"
                    disabled={busy}
                    onClick={close}
                    className="text-muted-foreground hover:text-foreground"
                >
                    <XIcon />
                </Button>
            </div>
        </section>
    );
}

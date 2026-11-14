import type { DeviceAsk as Asked, DeviceAskState } from '@hushos/auth/client';
import { useEffect, useRef, useState } from 'react';
import { QrCode } from '@/components/qr-code';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';

/*
 * Asking another device to approve a step (docs/two-step-design.md 12): at a sign-in, before a
 * change, and when the method is turned on. This browser commits first and shows a QR code of
 * that; once a device opens the request it shows the code, two digits and a word, for the
 * person to type there. Nothing is sent until a press asks for it: a form that merely opens on
 * this method must not spend the day's requests.
 */

const POLL_MS = 2_000;
const ENDED = {
    replaced: 'Another sign-in replaced this request.',
    over: 'This request timed out.',
    refused: 'Your other device didn’t approve this.',
} as const;

export function DeviceAsk({
    token,
    purpose,
    approved,
    onApproved,
    auto = false,
    disabled = false,
}: {
    /*
     * The step token the request runs from, and what the step is for. A new token is a new
     * request: render this with the token as its `key`, so nothing of an earlier one is left.
     */
    token: string;
    purpose: string;
    /* The request the other device approved, once it has: the step is then answered with it. */
    approved: string;
    onApproved: (requestId: string) => void;
    /* The press that brought the person here already asked: start without another one. */
    auto?: boolean;
    disabled?: boolean;
}) {
    const [asked, setAsked] = useState<Asked | null>(null);
    const [held, setHeld] = useState<DeviceAskState | null>(null);
    const [starting, setStarting] = useState(auto);
    const [problem, setProblem] = useState('');
    // The request this component last made: a reply for an earlier one is dropped.
    const [run] = useState(() => ({ latest: 0 }));
    const told = useRef(onApproved);
    useEffect(() => {
        told.current = onApproved;
    });

    async function request() {
        const mine = ++run.latest;
        try {
            const made = await authClient.askAnotherDevice({ token }, purpose);
            if (mine !== run.latest) return;
            setAsked(made);
            setHeld({ state: 'waiting' });
        } catch (cause) {
            if (mine === run.latest) setProblem(authError(cause));
        } finally {
            if (mine === run.latest) setStarting(false);
        }
    }
    function ask() {
        setStarting(true);
        setProblem('');
        setHeld(null);
        setAsked(null);
        void request();
    }
    useEffect(() => {
        if (auto) void request();
        return () => {
            // Whatever is still on its way belongs to a form that is gone.
            run.latest++;
        };
        // Once, when this opens: a new token remounts it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // An approval the step did not take after all (it refused it) is not shown as one: back to asking.
    const state = !approved && held?.state === 'approved' ? null : held;
    const waiting = state?.state === 'waiting' || state?.state === 'code';
    useEffect(() => {
        if (!asked || !waiting) return;
        const mine = run.latest;
        let busy = false;
        const look = async () => {
            if (busy) return;
            busy = true;
            try {
                const next = await asked.poll();
                if (mine !== run.latest) return;
                setHeld(next);
                if (next.state === 'approved') told.current(asked.requestId);
            } catch (cause) {
                // The token is over, or the request is: nothing more will come of asking.
                const status = (cause as { status?: unknown } | null)?.status;
                if (mine === run.latest && typeof status === 'number' && status < 500) {
                    setHeld(null);
                    setAsked(null);
                    setProblem(authError(cause));
                }
            } finally {
                busy = false;
            }
        };
        void look();
        const timer = setInterval(() => void look(), POLL_MS);
        return () => clearInterval(timer);
    }, [asked, waiting, run]);

    if (approved)
        return (
            <output data-device-ask="approved" className="text-sm font-semibold text-success">
                Approved on your other device
            </output>
        );
    if (!asked || !state)
        return (
            <div className="flex flex-col gap-2" data-device-ask="idle">
                {problem && (
                    <p role="alert" className="text-[13px] text-destructive">
                        {problem}
                    </p>
                )}
                <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || starting}
                    onClick={ask}
                    className="self-start"
                >
                    {starting ? 'Asking' : problem ? 'Ask again' : 'Use another device'}
                </Button>
            </div>
        );
    if (state.state === 'ended')
        return (
            <div className="flex flex-col gap-2" data-device-ask="ended">
                <p role="alert" className="text-[13px] text-destructive">
                    {ENDED[state.ended]}
                </p>
                <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || starting}
                    onClick={ask}
                    className="self-start"
                >
                    Ask again
                </Button>
            </div>
        );
    return (
        <div className="flex flex-col gap-3" data-device-ask={state.state}>
            {state.state === 'code' ? (
                <div className="flex flex-col gap-1">
                    <span className="text-[13px] font-semibold">Code for your other device</span>
                    <output
                        data-device-code
                        aria-live="polite"
                        className="font-mono text-[28px] leading-9 font-semibold tracking-[0.04em]"
                    >
                        {state.code}
                    </output>
                </div>
            ) : (
                <p className="text-sm">Open HushOS on another device and choose Answer.</p>
            )}
            {/* Square modules at whole pixels: a phone's camera reads this off the screen. */}
            <div className="self-start rounded-md border border-rule bg-white p-2">
                <QrCode
                    value={asked.qr}
                    kind="recovery"
                    cell={4}
                    title="QR code for your other device"
                />
            </div>
        </div>
    );
}

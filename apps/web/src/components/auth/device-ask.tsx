import type { DeviceAsk as Asked, DeviceAskState } from '@hushos/auth/client';
import { useEffect, useRef, useState } from 'react';
import { QrCode } from '@/components/marks/qr-code';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth/auth-client';
import { authError } from '@/lib/platform/form';

/*
 * Asking another device to approve a step (docs/two-step-design.md 12): at a sign-in, before a
 * change, and when the method is turned on. This browser commits first and shows a QR code of
 * that; once a device opens the request it shows the code, two digits and a word, for the
 * person to type there. A sign-in step that opens on this method asks at once (it is the
 * account's usual way); a dialog that merely opens on it waits for a press, so it does not spend
 * the day's requests. Either way a step asks once: coming back to it shows the same request.
 *
 * Turning the method on (`approver`) is answered the other way round. This browser shows no
 * code and no QR code: the device that approves draws a code and shows it, and the person types
 * it here. The approval alone turns nothing on, and this browser cannot check what is typed
 * (the code is in nothing it holds): the form that turns the method on asks for it and sends
 * it, and the server compares.
 */

const POLL_MS = 2_000;
const ENDED = {
    replaced: 'Another sign-in replaced this request.',
    over: 'This request timed out.',
    refused: 'Your other device didn’t approve this.',
} as const;

/* The request the form last opened with, by its token and purpose: made once however often it mounts. */
let opening: { key: string; made: Promise<Asked> } | null = null;

export function DeviceAsk({
    token,
    purpose,
    approved,
    onApproved,
    auto = false,
    disabled = false,
    approver,
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
    /*
     * Turning the method on: the device the person chose to approve. Only it is asked, the
     * screen says which one to pick up, and the code is that device's to show, not this one's.
     */
    approver?: { id: string; name: string };
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

    /*
     * `again`: a press asked, so a new request is made whatever came before. Otherwise this is
     * the request the form opened with, and it is made once: React mounts a form twice in
     * development, and a second request would replace the first and spend the day's count.
     */
    async function request(again: boolean) {
        const mine = ++run.latest;
        const key = `${token}:${purpose}`;
        try {
            const asking =
                !again && opening?.key === key
                    ? opening.made
                    : authClient.askAnotherDevice({ token }, purpose, approver?.id);
            opening = { key, made: asking };
            const made = await asking;
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
        void request(true);
    }
    useEffect(() => {
        if (auto) void request(false);
        return () => {
            // Whatever is still on its way belongs to a form that is gone.
            run.latest++;
        };
        // Once, when this opens: a new token remounts it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // An approval the step did not take after all (it refused it) is not shown as one: back to asking.
    const state = !approved && held?.state === 'approved' ? null : held;
    const waiting =
        state?.state === 'waiting' || state?.state === 'code' || state?.state === 'opened';
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

    // Turning the method on: the approval is half of it, and the form asks for the code now.
    if (approved && approver) return null;
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
                    {starting ? 'Asking' : problem || approver ? 'Ask again' : 'Use another device'}
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
    if (approver)
        return (
            <p className="text-sm" data-device-ask={state.state}>
                Open HushOS on {approver.name} and choose Answer.
            </p>
        );
    // A device opened the request, by its prompt or by the QR code: that code has done its part.
    // One panel the width of the form for both: the QR code until a device opens the request,
    // then the code in its place, with where things stand beneath.
    const panel =
        'flex flex-col items-center gap-3 rounded-xl border border-rule bg-muted/50 px-5 py-6 text-center';
    if (state.state === 'code')
        return (
            <div className={panel} data-device-ask="code">
                <p className="text-[13px] text-muted-foreground">Code for your other device</p>
                <output
                    data-device-code
                    aria-live="polite"
                    className="font-mono text-4xl leading-none font-semibold tracking-[0.04em]"
                >
                    {state.code}
                </output>
                <p className="text-[13px] text-muted-foreground">Waiting for approval</p>
            </div>
        );
    return (
        <div className={panel} data-device-ask={state.state}>
            <p className="text-[13px] text-balance text-muted-foreground">
                Choose Answer in HushOS on another device,{' '}
                <span className="sm:block">or scan this with your phone.</span>
            </p>
            {/* Square modules at whole pixels: a phone's camera reads this off the screen. */}
            <div className="rounded-lg bg-white p-2">
                <QrCode
                    value={asked.qr}
                    kind="recovery"
                    cell={3}
                    title="QR code for your other device"
                />
            </div>
        </div>
    );
}

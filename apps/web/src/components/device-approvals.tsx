import { DeviceStepError, type ApprovalPrompt, type OpenedApproval } from '@hushos/auth/client';
import type { approvalWords, normalizeApprovalCode } from '@hushos/crypto/device-approval';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { Setting } from '@/components/settings';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui/toast';
import { approvalAsks, approvalsQueryOptions } from '@/lib/approvals';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';
import { useTwoStepEnabled } from '@/lib/two-step';

/*
 * Answering another device's request to confirm it's you (docs/two-step-design.md 12): a line in
 * the app while one is waiting, rows under Your devices, and the dialog that answers. The person
 * types the code the other screen shows, two digits and a word; only an exact match is signed
 * with this browser's device key. A browser has no camera to count on, so it types; the phones
 * scan too.
 */

const WAITING_MS = 30_000;
const ANSWERING_MS = 2_000;

/* The requests this browser may answer, asked for again every so often while the page is seen. */
function useApprovals(every: number) {
    const enabled = useTwoStepEnabled();
    return useQuery({
        ...approvalsQueryOptions,
        enabled,
        refetchInterval: every,
        refetchOnWindowFocus: true,
    });
}

/*
 * How a typed code is read, and what its word could become: the word list behind both is
 * fetched when a dialog first opens, not with the app.
 */
type Codes = {
    approvalWords: typeof approvalWords;
    normalizeApprovalCode: typeof normalizeApprovalCode;
};
function useCodes(wanted: boolean) {
    const [codes, setCodes] = useState<Codes | null>(null);
    useEffect(() => {
        if (!wanted || codes) return;
        let current = true;
        void import('@hushos/crypto/device-approval').then((loaded) => current && setCodes(loaded));
        return () => {
            current = false;
        };
    }, [wanted, codes]);
    return codes;
}
/* The words a typed beginning could become; none once the word is whole and the only one. */
function wordsFor(codes: Codes | null, typed: string) {
    const word = /^\s*\d{2}[\s-]*([a-z]+)$/i.exec(typed)?.[1]?.toLowerCase() ?? '';
    const found = codes && word ? codes.approvalWords(word) : [];
    return found.length === 1 && found[0] === word ? [] : found;
}

function AnswerDialog({ asked, onClose }: { asked: ApprovalPrompt | null; onClose: () => void }) {
    const id = useId();
    const queryClient = useQueryClient();
    const open = asked !== null;
    const listed = useQuery({
        ...approvalsQueryOptions,
        enabled: open,
        refetchInterval: ANSWERING_MS,
    });
    const [opened, setOpened] = useState<OpenedApproval | null>(null);
    const [typed, setTyped] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const codes = useCodes(open);
    const words = wordsFor(codes, typed);
    const wellFormed = codes?.normalizeApprovalCode(typed) != null;
    const field = useRef<HTMLInputElement>(null);
    const requestId = asked?.id ?? null;

    // Opening is this browser's own value going in: once, when the dialog opens on a request.
    // (The dialog is keyed by the request, so nothing of an earlier one is left in it.)
    useEffect(() => {
        if (!asked) return;
        let current = true;
        void authClient.openApproval(asked).then(
            (next) => current && setOpened(next),
            (cause: unknown) => current && setError(authError(cause)),
        );
        return () => {
            current = false;
        };
        // Only when the dialog opens on a request.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requestId]);

    const now = listed.data?.find((prompt) => prompt.id === requestId) ?? null;
    const reveal = now?.reveal ?? null;
    // Gone from the list: it timed out, was answered another way, or another device has it.
    const over = open && listed.isSuccess && !listed.isFetching && now === null && !pending;
    const done = () => {
        // An approval can turn the step on for this browser too, or add a device to the list:
        // everything Account shows of the account is read again.
        void queryClient.invalidateQueries({ queryKey: ['account'] });
        onClose();
    };

    async function approve() {
        if (!opened || !reveal) return;
        setPending(true);
        setError('');
        try {
            await authClient.approveRequest(opened, reveal, typed);
            cue('success');
            toast.add({ type: 'success', title: 'Approved' });
            done();
        } catch (cause) {
            cue('error');
            // A code that did not match, or a device that did not match its request, ended it.
            if (cause instanceof DeviceStepError && cause.reason !== 'unsupported') {
                toast.add({ type: 'error', title: cause.message });
                done();
            } else setError(authError(cause));
        } finally {
            setPending(false);
        }
    }
    async function end(reason: 'denied' | 'not-me') {
        if (!requestId) return;
        setPending(true);
        setError('');
        try {
            await authClient.denyApproval(requestId, reason);
            toast.add({
                type: 'success',
                title: 'Denied',
                ...(reason === 'not-me'
                    ? { description: 'If you didn’t start this, change your password.' }
                    : {}),
            });
            done();
        } catch (cause) {
            setError(authError(cause));
        } finally {
            setPending(false);
        }
    }

    return (
        <Dialog open={open} onOpenChange={(next) => !next && !pending && onClose()}>
            <DialogContent className="sm:max-w-[480px]">
                <form
                    noValidate
                    aria-busy={pending}
                    className="contents"
                    data-approval-answer
                    onSubmit={(event) => {
                        event.preventDefault();
                        void approve();
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>
                            {asked
                                ? approvalAsks(asked.purpose, asked.device.name, asked.location)
                                : ''}
                        </DialogTitle>
                    </DialogHeader>
                    {over ? (
                        <p role="alert" className="text-sm">
                            This request is over.
                        </p>
                    ) : reveal ? (
                        <div className="flex flex-col gap-1.5">
                            <label htmlFor={id} className="text-[13px] font-semibold">
                                Code on the other device
                            </label>
                            <Input
                                id={id}
                                ref={field}
                                // oxlint-disable-next-line jsx-a11y/no-autofocus -- the one field the dialog asks for
                                autoFocus
                                autoComplete="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                placeholder="47 river"
                                maxLength={16}
                                value={typed}
                                readOnly={pending}
                                onChange={(event) => {
                                    setTyped(event.target.value);
                                    setError('');
                                }}
                                className="font-mono text-[15px]"
                            />
                            {words.length > 0 && (
                                <div className="flex flex-wrap gap-1.5" data-approval-words>
                                    {words.map((word) => (
                                        <Button
                                            key={word}
                                            type="button"
                                            size="xs"
                                            variant="outline"
                                            disabled={pending}
                                            onClick={() => {
                                                setTyped(`${typed.trim().slice(0, 2)} ${word}`);
                                                field.current?.focus();
                                            }}
                                        >
                                            {word}
                                        </Button>
                                    ))}
                                </div>
                            )}
                        </div>
                    ) : (
                        <output className="text-sm text-muted-foreground">
                            Waiting for the other device
                        </output>
                    )}
                    {error && (
                        <p role="alert" className="text-[13px] text-destructive">
                            {error}
                        </p>
                    )}
                    <DialogFooter>
                        {over ? (
                            <Button type="button" variant="outline" onClick={onClose}>
                                Close
                            </Button>
                        ) : (
                            <>
                                <Button
                                    type="button"
                                    variant="destructive-outline"
                                    disabled={pending}
                                    onClick={() => void end('not-me')}
                                >
                                    This wasn’t me
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    disabled={pending}
                                    onClick={() => void end('denied')}
                                >
                                    Deny
                                </Button>
                                <Button
                                    type="submit"
                                    disabled={pending || !reveal || !opened || !wellFormed}
                                >
                                    {pending ? 'Checking' : 'Approve'}
                                </Button>
                            </>
                        )}
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    );
}

/* One line in the app while another device waits for an answer. */
export function ApprovalBanner() {
    const waiting = useApprovals(WAITING_MS);
    const [answering, setAnswering] = useState<ApprovalPrompt | null>(null);
    const first = waiting.data?.[0];
    return (
        <>
            {first && !answering && (
                <section
                    aria-label="Another device is waiting"
                    data-approval-banner
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule bg-muted py-2 ps-5 pe-2 text-sm sm:ps-8 sm:pe-6"
                >
                    <span className="min-w-0 flex-1">
                        Another device is asking to confirm it’s you
                    </span>
                    <Button size="xs" variant="outline" onClick={() => setAnswering(first)}>
                        Answer
                    </Button>
                </section>
            )}
            <AnswerDialog
                key={answering?.id ?? 'closed'}
                asked={answering}
                onClose={() => setAnswering(null)}
            />
        </>
    );
}

/* The requests waiting, as rows of Your devices: what is asked and by which device, and Answer. */
export function ApprovalRows() {
    const waiting = useApprovals(5_000);
    const [answering, setAnswering] = useState<ApprovalPrompt | null>(null);
    return (
        <>
            {waiting.data?.map((asked) => (
                <Setting
                    key={asked.id}
                    data={{ 'data-approval': asked.id }}
                    action={
                        <Button variant="outline" onClick={() => setAnswering(asked)}>
                            Answer
                        </Button>
                    }
                >
                    <span className="font-semibold">
                        {approvalAsks(asked.purpose, asked.device.name, asked.location)}
                    </span>
                </Setting>
            ))}
            <AnswerDialog
                key={answering?.id ?? 'closed'}
                asked={answering}
                onClose={() => setAnswering(null)}
            />
        </>
    );
}

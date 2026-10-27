import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { DeclineInvitation } from '@/components/families/decline-invitation';
import { RotateCcwIcon } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { useDrive } from '@/components/drive/drive-shell';
import { ForkAlert } from '@/components/families/family-alerts';
import { CompareGuidance } from '@/components/families/word-list';
import { FingerprintWords } from '@/components/fingerprint-words';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ownFingerprintQueryOptions } from '@/lib/contacts';
import {
    afterMembershipChange,
    familiesQueryOptions,
    familyContext,
    familyQueryOptions,
    firstName,
} from '@/lib/families';
import type { JoinMark, RosterFork } from '@hushos/crypto';
import { errorCopy, mismatchCopy, wrongWordsCopy } from '@/lib/groups/copy';
import { confirmJoin, joinStatus, type JoinOutcome } from '@/lib/groups/join';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/_drive/families/$groupId/join')({
    head: () => ({ meta: [{ title: 'Join a family · HushOS' }] }),
    component: JoinFamily,
});

/*
 * The newcomer's side (docs/groups-design.md 3.2; join.ts):
 * 1. read your twelve words to the person letting you in, and wait while they
 *    check them and let you in;
 * 2. when their screen shows a join code, they read it out: this device shows
 *    the code it works out with two words hidden, at positions it picks for
 *    this showing; the person checks the other ten and types the two. "They
 *    match" joins only if the two are the code's, with the code as this
 *    device's mark. Wrong typed words keep nothing; the first time for a code
 *    they say, calmly and without saying which, that one of them is wrong,
 *    and again for the same code they say, as "They don't match" does, not to
 *    use the family yet. The page never says the person was let in: when
 *    route 2 says so is the server's call, which is why the two words are
 *    typed.
 * Waiting and comparing survive a reload: the code is worked out again, with
 * new hidden positions, unless a wrong pair held them for that code.
 */

type Step =
    | { kind: 'loading' }
    /* `n` tells one entry into waiting from the next, so polling starts again each time. */
    | { kind: 'waiting'; n: number }
    /*
     * `hidden`: the two positions this showing hides. `changed`: an earlier code no longer
     * holds. `wrong`: the typed pair was not the code's (never which word).
     */
    | {
          kind: 'compare';
          mark: JoinMark;
          hidden: [number, number];
          session: number;
          changed?: boolean;
          wrong?: boolean;
      }
    | { kind: 'mismatch' }
    | { kind: 'fork'; fork: RosterFork };

const POLL_MS = 3_000;

function JoinFamily() {
    const { groupId } = Route.useParams();
    const { userId } = useDrive();
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const ctx = familyContext(userId);
    const families = useQuery(familiesQueryOptions(userId));
    const summary = families.data?.find((family) => family.id === groupId);
    // Route 3 answers someone who accepted: who manages the family.
    const detail = useQuery({
        ...familyQueryOptions(userId, groupId),
        enabled: Boolean(summary),
        refetchInterval: 5_000,
    });
    const [step, setStep] = useState<Step>({ kind: 'loading' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    // The two hidden words as typed, for the showing on screen.
    const [typed, setTyped] = useState<[string, string]>(['', '']);
    const started = useRef(false);

    const family = summary?.name ?? 'the family';
    const managers = (detail.data?.members ?? []).filter(
        (member) => member.state === 'active' && member.roles.includes('members'),
    );
    const only = managers.length === 1 ? managers[0]! : null;
    const them = only ? firstName(only.name) : 'the person letting you in';
    // Names are the server's word: the first time one is shown, its address goes beside it.
    const themFull = only
        ? `${only.name}${only.email ? ` (${only.email})` : ''}`
        : 'the person letting you in';

    async function joined() {
        cue('success');
        toast.add({ type: 'success', title: `You’re in ${family}` });
        await afterMembershipChange(queryClient, userId);
        await navigate({ to: '/app/family', replace: true });
    }

    /* Each answer from join.ts, as a step. */
    function show(outcome: JoinOutcome | { status: 'member' }) {
        setError('');
        switch (outcome.status) {
            case 'joined':
                return void joined();
            case 'member':
                // This device already holds the family: nothing to join.
                return void navigate({ to: '/app/family', replace: true });
            case 'waiting':
                return setStep((current) =>
                    current.kind === 'waiting' ? current : { kind: 'waiting', n: Date.now() },
                );
            case 'compare':
                if (outcome.changed) cue('error');
                setTyped(['', '']);
                return setStep({
                    kind: 'compare',
                    mark: outcome.mark,
                    hidden: outcome.hidden,
                    session: outcome.session,
                    changed: outcome.changed,
                });
            case 'wrong-words':
                // Most likely misheard: the same showing stays, both words to be read again.
                cue('error');
                return setStep((current) =>
                    current.kind === 'compare' ? { ...current, wrong: true } : current,
                );
            case 'mismatch':
                // Wrong again for the same code, its positions held: the alarm, not a typo.
                cue('error');
                return setStep({ kind: 'mismatch' });
            case 'fork':
                return setStep({ kind: 'fork', fork: outcome.fork });
        }
    }

    async function resume() {
        setError('');
        try {
            show(await joinStatus(ctx, groupId));
        } catch (cause) {
            // The retry button belongs to the loading step: whatever step this came from.
            setStep({ kind: 'loading' });
            setError(errorCopy(cause, { family }));
        }
    }

    useEffect(() => {
        if (started.current || !summary) return;
        started.current = true;
        void resume();
        // Started once the family is known; later list refreshes don't restart it.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [summary]);

    async function match() {
        if (step.kind !== 'compare') return;
        setBusy(true);
        setError('');
        try {
            show(
                await confirmJoin(
                    ctx,
                    groupId,
                    { mark: step.mark, hidden: step.hidden, session: step.session },
                    typed,
                ),
            );
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family }));
        } finally {
            setBusy(false);
        }
    }

    // Waiting: route 2 polled through joinStatus until the person is let in.
    useEffect(() => {
        if (step.kind !== 'waiting') return;
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = async () => {
            try {
                const outcome = await joinStatus(ctx, groupId);
                if (!active) return;
                if (outcome.status !== 'waiting') return show(outcome);
                setError('');
            } catch (cause) {
                if (active) setError(errorCopy(cause, { family }));
            }
            if (active) timer = setTimeout(() => void tick(), POLL_MS);
        };
        timer = setTimeout(() => void tick(), POLL_MS);
        return () => {
            active = false;
            clearTimeout(timer);
        };
        // One loop per entry into the waiting step.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [step.kind === 'waiting' ? step.n : 0]);

    // Each step's heading takes focus as the step changes, so a keyboard or screen reader
    // carries on from there rather than from the top of the page.
    const stepHeading = useRef<HTMLHeadingElement>(null);
    const stepKey =
        step.kind === 'waiting'
            ? `waiting:${step.n}`
            : step.kind === 'compare'
              ? `compare:${step.hidden.join(',')}:${step.mark.code.join(' ')}`
              : step.kind;
    useEffect(() => {
        if (stepKey !== 'loading') stepHeading.current?.focus();
    }, [stepKey]);
    const status =
        step.kind === 'waiting'
            ? `Read your twelve words to ${them}, then wait for their join code.`
            : step.kind === 'compare'
              ? 'Compare the join code, and type the two hidden words.'
              : step.kind === 'mismatch'
                ? `Don’t use ${family} yet.`
                : step.kind === 'fork'
                  ? `${family}’s member list was shown differently to you.`
                  : '';

    if (families.isPending) return <SkeletonRows rows={3} />;
    if (families.isError || !summary)
        return (
            <EmptyState
                title="This family couldn’t be opened"
                body={
                    families.isError
                        ? errorCopy(families.error)
                        : 'You haven’t accepted an invitation to it, or it has ended.'
                }
            >
                <Link to="/app/family" className="text-sm font-semibold text-primary underline">
                    Family
                </Link>
            </EmptyState>
        );

    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                back={<Link to="/app/family">Family</Link>}
                title={`Join ${family}`}
                description={`Do this with ${themFull} on a call or in person. It takes a minute.`}
            />
            {/* Always on the page, so each change of step is announced. */}
            <p aria-live="polite" className="sr-only">
                {status}
            </p>
            <div className="flex max-w-[640px] flex-col gap-6 px-5 pb-10 sm:px-8">
                {error && (
                    <Alert variant="warning">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                )}
                {step.kind === 'loading' && !error && (
                    <output className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Spinner className="size-4" />
                        Opening
                    </output>
                )}
                {step.kind === 'loading' && error && (
                    <div>
                        <Button variant="outline" onClick={() => void resume()}>
                            <RotateCcwIcon />
                            Try again
                        </Button>
                    </div>
                )}
                {step.kind === 'waiting' && (
                    <>
                        <OwnWords userId={userId} them={them} headingRef={stepHeading} />
                        <section className="flex flex-col items-start gap-2">
                            <h2 className="flex items-center gap-2 text-[15px] font-semibold">
                                <Spinner className="size-4 text-muted-foreground" />
                                Waiting for {them} to let you in
                            </h2>
                            <p className="text-sm text-muted-foreground">
                                Keep this page open. When {them}’s screen shows a join code, they’ll
                                read it to you. Check the words match and type the two that are
                                hidden.
                            </p>
                        </section>
                    </>
                )}
                {step.kind === 'compare' && (
                    <section className="flex flex-col gap-3" aria-label="Join code">
                        <h2
                            ref={stepHeading}
                            tabIndex={-1}
                            className="text-[17px] font-bold outline-none"
                        >
                            Compare the join code
                        </h2>
                        {step.changed && (
                            <Alert variant="warning">
                                <AlertDescription>
                                    {family}’s member list changed since the code you compared.
                                    Compare this one with {them}.
                                </AlertDescription>
                            </Alert>
                        )}
                        <p className="text-[15px]">
                            {them}’s screen shows the join code now. Ask them to read it to you,
                            check the words match, and type the two that are hidden.
                        </p>
                        <HiddenCode
                            shown={step.mark.code.map((word, at) =>
                                step.hidden.includes(at) ? null : word,
                            )}
                            hidden={step.hidden}
                            typed={typed}
                            wrong={step.wrong ?? false}
                            onType={(next) => {
                                setTyped(next);
                                if (step.wrong) setStep({ ...step, wrong: undefined });
                            }}
                        />
                        {step.wrong && (
                            // The calm retry: a typo is likely, so an error line by the fields, never the alarm.
                            <p role="alert" data-wrong-words className="text-sm text-destructive">
                                {wrongWordsCopy(them)}
                            </p>
                        )}
                        <CompareGuidance />
                        <div className="flex flex-wrap gap-2">
                            <Button
                                disabled={busy || typed.some((word) => !word.trim())}
                                onClick={() => void match()}
                            >
                                {busy ? 'Joining' : 'They match'}
                            </Button>
                            <Button
                                variant="outline"
                                disabled={busy}
                                onClick={() => {
                                    cue('error');
                                    setStep({ kind: 'mismatch' });
                                }}
                            >
                                They don’t match
                            </Button>
                        </div>
                    </section>
                )}
                {step.kind === 'mismatch' && (
                    <Alert variant="destructive" data-mismatch>
                        <AlertTitle>
                            <h2 ref={stepHeading} tabIndex={-1} className="outline-none">
                                Don’t use {family} yet
                            </h2>
                        </AlertTitle>
                        <AlertDescription>
                            <p>{mismatchCopy(them)}</p>
                            <p className="mt-2">
                                First check that {them} is reading your join code, not someone
                                else’s, and that you typed the two hidden words as they read them.
                                Then compare again: nothing was saved on this device.
                            </p>
                            <Button
                                variant="outline"
                                className="mt-3"
                                onClick={() => {
                                    setStep({ kind: 'loading' });
                                    void resume();
                                }}
                            >
                                Compare again
                            </Button>
                        </AlertDescription>
                    </Alert>
                )}
                {step.kind === 'fork' && (
                    <>
                        <h2 ref={stepHeading} tabIndex={-1} className="sr-only">
                            Member list shown differently
                        </h2>
                        <ForkAlert family={family} fork={step.fork} />
                    </>
                )}
                {/* A way back out while they wait: quiet, beneath the steps (DeclineInvitation). */}
                {summary.state === 'accepted' && (
                    <div className="border-t border-rule pt-4">
                        <DeclineInvitation
                            userId={userId}
                            groupId={groupId}
                            family={family}
                            onDeclined={() => navigate({ to: '/app/family' })}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

/* Step 1: this account's own twelve words, which the person letting you in checks. */
function OwnWords({
    userId,
    them,
    headingRef,
}: {
    userId: string;
    them: string;
    headingRef: RefObject<HTMLHeadingElement | null>;
}) {
    const own = useQuery({ ...ownFingerprintQueryOptions(userId), staleTime: 0 });
    return (
        <section className="flex flex-col gap-3" aria-label="Your twelve words">
            <h2 ref={headingRef} tabIndex={-1} className="text-[17px] font-bold outline-none">
                Read your twelve words to {them}
            </h2>
            <p className="text-sm text-muted-foreground">
                They check them against what their screen shows for you.
            </p>
            {own.isPending ? (
                <Spinner className="size-4 text-muted-foreground" />
            ) : own.isError ? (
                <p role="alert" className="text-sm text-destructive">
                    {errorCopy(own.error)}
                </p>
            ) : (
                <FingerprintWords fingerprint={own.data} />
            )}
            <CompareGuidance />
        </section>
    );
}

/*
 * The join code with two words hidden: a field for each, typed as the person
 * letting you in reads them. The hidden words are not in the page at all.
 */
function HiddenCode({
    shown,
    hidden,
    typed,
    wrong,
    onType,
}: {
    /* The code with the hidden words already taken out (null). */
    shown: readonly (string | null)[];
    hidden: readonly [number, number];
    typed: readonly [string, string];
    /* The typed pair was not the code's: both fields are marked, never just one. */
    wrong: boolean;
    onType: (typed: [string, string]) => void;
}) {
    return (
        <ol
            aria-label="Join code"
            data-kind="join-code"
            data-words={shown.map((word) => word ?? '?').join(' ')}
            data-hidden={hidden.map((at) => at + 1).join(' ')}
            className="grid w-full grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-1.5"
        >
            {shown.map((word, at) => {
                const slot = hidden.indexOf(at);
                return (
                    <li
                        key={at}
                        className="flex items-baseline gap-1.5 rounded-md bg-muted px-2.5 py-2"
                    >
                        <span
                            aria-hidden="true"
                            className="w-4 text-right text-[11px] text-muted-foreground tabular-nums"
                        >
                            {at + 1}
                        </span>
                        {word !== null || slot < 0 ? (
                            <span className="text-[15px] font-medium">{word}</span>
                        ) : (
                            <input
                                aria-label={`Word ${at + 1}`}
                                aria-invalid={wrong || undefined}
                                autoComplete="off"
                                autoCorrect="off"
                                autoCapitalize="none"
                                spellCheck={false}
                                value={typed[slot]}
                                onChange={(event) => {
                                    const next: [string, string] = [typed[0], typed[1]];
                                    next[slot] = event.target.value;
                                    onType(next);
                                }}
                                className="w-full min-w-0 rounded-sm border border-input bg-background px-1.5 text-[15px] font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive aria-invalid:ring-1 aria-invalid:ring-destructive"
                            />
                        )}
                    </li>
                );
            })}
        </ol>
    );
}

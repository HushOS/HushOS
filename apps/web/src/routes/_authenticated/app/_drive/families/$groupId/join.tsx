import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { RotateCcwIcon, TriangleAlertIcon } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { EmptyState, SkeletonRows } from '@/components/drive/file-list';
import { useDrive } from '@/components/drive/drive-shell';
import { CodeEntry } from '@/components/families/code-entry';
import { ForkAlert } from '@/components/families/family-alerts';
import { CompareGuidance, WordList } from '@/components/families/word-list';
import { FingerprintWords } from '@/components/fingerprint-words';
import { Spinner } from '@/components/motion';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { ownFingerprintQueryOptions } from '@/lib/contacts';
import {
    afterFamilyChange,
    familiesQueryOptions,
    familyContext,
    familyQueryOptions,
    firstName,
} from '@/lib/families';
import type { RosterFork, GroupPublicKey } from '@hushos/crypto';
import { errorCopy } from '@/lib/groups/copy';
import {
    enterJoinCode,
    familyWords,
    finishJoin,
    joinProgress,
    wordsMatch,
} from '@/lib/groups/join';
import { cue } from '@/lib/sounds';

export const Route = createFileRoute('/_authenticated/app/_drive/families/$groupId/join')({
    head: () => ({ meta: [{ title: 'Join a family · HushOS' }] }),
    component: JoinFamily,
});

/*
 * The newcomer's side (the 1c plan, "Words check and join code"; join.ts):
 * 1. read your own twelve words to the person letting you in, and compare the
 *    family's twelve words with theirs;
 * 2. type the join code they read out, for the member list that lets you in;
 * 3. wait until they have, then this device checks the family from its start
 *    with the code as a mark.
 * Each step survives a reload. A code that doesn't match is typed again: this
 * device can't tell a typo from a different history, and says so.
 */

type Step =
    | { kind: 'loading' }
    | { kind: 'words'; words: string[]; firstKeys: GroupPublicKey }
    | { kind: 'mismatch' }
    /* `version`: the member list the last typed code was for, when it didn't match. */
    | { kind: 'code'; before: boolean; error: string; mismatch?: boolean; version?: number }
    /* `n` tells one entry into waiting from the next, so polling starts again each time. */
    /* `later`: the first check waits a poll interval (back from a check that said to recheck). */
    | { kind: 'waiting'; n: number; later?: boolean }
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
    // Route 3 answers someone who accepted: who manages the family, and the head the code is for.
    const detail = useQuery({
        ...familyQueryOptions(userId, groupId),
        enabled: Boolean(summary),
        refetchInterval: 5_000,
    });
    const [step, setStep] = useState<Step>({ kind: 'loading' });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
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
    // Waiting to be let in, the code is for the member list after the newest; once let in (a
    // code that didn't match only says so then), for the one that did it, which the other
    // person's screen names.
    const admitted = summary?.state === 'active';
    const nextVersion = detail.data ? detail.data.head.version + 1 : null;
    // Worded when shown, so it names whoever the page knows by then.
    const codeError =
        step.kind !== 'code'
            ? ''
            : step.mismatch
              ? `The join code didn’t match. Check it with ${them} again. If it still doesn’t match after you’ve both read it carefully, HushOS may be showing you a different member list than ${them} sees: don’t use this family until you’ve sorted it out together.`
              : step.error;

    async function joined() {
        cue('success');
        toast.add({ type: 'success', title: `You’re in ${family}` });
        await afterFamilyChange(queryClient, userId);
        await navigate({ to: '/app/families/$groupId', params: { groupId }, replace: true });
    }

    /* Where to resume: the record this device kept, then the words the server serves. */
    async function resume(options: { fromPoll?: boolean } = {}) {
        setError('');
        try {
            const progress = await joinProgress(ctx, groupId);
            if (progress.status === 'checked' && progress.joinMark)
                return setStep({ kind: 'waiting', n: Date.now(), later: options.fromPoll });
            if (progress.status === 'checked')
                return setStep({ kind: 'code', before: false, error: '' });
            // The words were compared over other first keys than the server serves now: that
            // check no longer holds, and nothing typed since does either (joinProgress cleared it).
            if (progress.status === 'keys-changed') {
                cue('error');
                setError(
                    `The family’s keys changed since you compared the words. Compare them again with ${them}, and if they don’t match, don’t join.`,
                );
            }
            const words = await familyWords(ctx, groupId);
            if (words.status === 'already-checked') {
                // An active member whose devices already hold the family: nothing to join.
                if (summary?.state === 'active')
                    return void navigate({
                        to: '/app/families/$groupId',
                        params: { groupId },
                        replace: true,
                    });
                // Checked before (a rejoin): the marks decide, so only the code is needed.
                await wordsMatch(ctx, groupId, words.firstKeys);
                return setStep({ kind: 'code', before: true, error: '' });
            }
            setStep({ kind: 'words', words: words.words, firstKeys: words.firstKeys });
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
        if (step.kind !== 'words') return;
        setBusy(true);
        setError('');
        try {
            setError('');
            const checked = await wordsMatch(ctx, groupId, step.firstKeys);
            if (checked.status === 'fork') return setStep({ kind: 'fork', fork: checked.fork });
            setStep({ kind: 'code', before: checked.status === 'already-checked', error: '' });
        } catch (cause) {
            cue('error');
            setError(
                cause instanceof Error && /keys changed/.test(cause.message)
                    ? cause.message
                    : `Couldn’t check ${family}. Try again.`,
            );
        } finally {
            setBusy(false);
        }
    }

    async function saveCode(code: string[], rosterVersion: number) {
        setBusy(true);
        try {
            await enterJoinCode(ctx, groupId, { rosterVersion, code });
            setStep({ kind: 'waiting', n: Date.now() });
        } catch (cause) {
            cue('error');
            setStep({ kind: 'code', before: false, error: errorCopy(cause, { family }) });
        } finally {
            setBusy(false);
        }
    }

    // Waiting: route 2 polled through finishJoin until the person is let in.
    useEffect(() => {
        if (step.kind !== 'waiting') return;
        let active = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const tick = async () => {
            try {
                const outcome = await finishJoin(ctx, groupId);
                if (!active) return;
                setError('');
                switch (outcome.status) {
                    case 'joined':
                        return void joined();
                    case 'code-mismatch':
                        cue('error');
                        void families.refetch();
                        return setStep({
                            kind: 'code',
                            before: false,
                            version: outcome.fork.version,
                            mismatch: true,
                            error: '',
                        });
                    case 'fork':
                        return setStep({ kind: 'fork', fork: outcome.fork });
                    case 'needs-check':
                        return void resume({ fromPoll: true });
                    case 'waiting':
                        break;
                }
            } catch (cause) {
                if (active) setError(errorCopy(cause, { family }));
            }
            if (active) timer = setTimeout(() => void tick(), POLL_MS);
        };
        if (step.later) timer = setTimeout(() => void tick(), POLL_MS);
        else void tick();
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
    const stepKey = step.kind === 'waiting' ? `waiting:${step.n}` : step.kind;
    useEffect(() => {
        if (stepKey !== 'loading') stepHeading.current?.focus();
    }, [stepKey]);
    const status =
        step.kind === 'words'
            ? 'Compare the twelve words.'
            : step.kind === 'code'
              ? // A code that didn't match is said once, by its own alert under the fields.
                codeError
                  ? ''
                  : 'Type the join code.'
              : step.kind === 'waiting'
                ? `Waiting for ${them} to let you in.`
                : step.kind === 'mismatch'
                  ? `Don’t join ${family} yet.`
                  : step.kind === 'fork'
                    ? `${family}’s member list was shown differently to you.`
                    : '';

    if (families.isPending) return <SkeletonRows rows={3} />;
    if (families.isError || !summary)
        return (
            <EmptyState
                icon={TriangleAlertIcon}
                tone="danger"
                title="This family couldn’t be opened"
                body={
                    families.isError
                        ? errorCopy(families.error)
                        : 'You haven’t accepted an invitation to it, or it has ended.'
                }
            >
                <Link to="/app/families" className="text-sm font-semibold text-primary underline">
                    Families
                </Link>
            </EmptyState>
        );

    return (
        <div className="flex flex-1 flex-col">
            <PageHeader
                back={<Link to="/app/families">Families</Link>}
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
                {step.kind === 'words' && (
                    <WordsStep
                        headingRef={stepHeading}
                        userId={userId}
                        them={them}
                        words={step.words}
                        busy={busy}
                        onMatch={() => void match()}
                        onMismatch={() => setStep({ kind: 'mismatch' })}
                    />
                )}
                {step.kind === 'mismatch' && (
                    <Alert variant="destructive">
                        <AlertTitle>
                            <h2 ref={stepHeading} tabIndex={-1} className="outline-none">
                                Don’t join {family} yet
                            </h2>
                        </AlertTitle>
                        <AlertDescription>
                            <p>
                                The words don’t match, so HushOS may be showing you a different
                                family than {them} sees. Tell {them}, and compare them again once
                                you’ve both reloaded.
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
                {step.kind === 'code' && (
                    <section className="flex flex-col gap-3" aria-label="Join code">
                        <h2
                            ref={stepHeading}
                            tabIndex={-1}
                            className="text-[17px] font-bold outline-none"
                        >
                            Type the join code
                        </h2>
                        <p className="text-[15px]">
                            {step.before
                                ? `You’ve checked ${family} before. Enter the join code ${them} reads to you.`
                                : `${them[0]!.toUpperCase()}${them.slice(1)} reads you a join code once you’ve both checked the words. Type it here.`}
                        </p>
                        {admitted || step.version !== undefined ? (
                            <CodeEntry
                                key={`admitted:${codeError}`}
                                // The other screen shows the newest member list's code by default.
                                rosterVersion={Math.max(
                                    step.version ?? 1,
                                    detail.data?.head.version ?? 1,
                                )}
                                versionEditable
                                pending={busy}
                                error={codeError}
                                onSubmit={(code, version) => void saveCode(code, version)}
                            />
                        ) : nextVersion === null ? (
                            <Spinner className="size-4 text-muted-foreground" />
                        ) : (
                            <CodeEntry
                                key={`waiting:${codeError}`}
                                rosterVersion={nextVersion}
                                pending={busy}
                                error={codeError}
                                onSubmit={(code, version) => void saveCode(code, version)}
                            />
                        )}
                    </section>
                )}
                {step.kind === 'waiting' && (
                    <section className="flex flex-col items-start gap-3">
                        <h2
                            ref={stepHeading}
                            tabIndex={-1}
                            className="flex items-center gap-2 text-[15px] font-semibold outline-none"
                        >
                            <Spinner className="size-4 text-muted-foreground" />
                            Waiting for {them} to let you in
                        </h2>
                        <p className="text-sm text-muted-foreground">
                            Keep this page open. It moves on by itself once they have.
                        </p>
                        <Button
                            variant="ghost"
                            onClick={() => setStep({ kind: 'code', before: false, error: '' })}
                        >
                            Enter the join code again
                        </Button>
                    </section>
                )}
                {step.kind === 'fork' && (
                    <>
                        <h2 ref={stepHeading} tabIndex={-1} className="sr-only">
                            Member list shown differently
                        </h2>
                        <ForkAlert family={family} fork={step.fork} />
                    </>
                )}
            </div>
        </div>
    );
}

const screenOf = (name: string) =>
    name.startsWith('the ') ? `the screen of ${name}` : `${name}’s screen`;

function WordsStep({
    headingRef,
    userId,
    them,
    words,
    busy,
    onMatch,
    onMismatch,
}: {
    headingRef: RefObject<HTMLHeadingElement | null>;
    userId: string;
    them: string;
    words: string[];
    busy: boolean;
    onMatch: () => void;
    onMismatch: () => void;
}) {
    const own = useQuery({ ...ownFingerprintQueryOptions(userId), staleTime: 0 });
    return (
        <>
            <section className="flex flex-col gap-3" aria-label="Your twelve words">
                <h2 ref={headingRef} tabIndex={-1} className="text-[17px] font-bold outline-none">
                    Read your twelve words to {them}
                </h2>
                {own.isPending ? (
                    <Spinner className="size-4 text-muted-foreground" />
                ) : own.isError ? (
                    <p role="alert" className="text-sm text-destructive">
                        {errorCopy(own.error)}
                    </p>
                ) : (
                    <FingerprintWords fingerprint={own.data} />
                )}
            </section>
            <section className="flex flex-col gap-3" aria-label="The family’s twelve words">
                <h2 className="text-[17px] font-bold">The family’s twelve words</h2>
                <p className="text-sm text-muted-foreground">
                    Compare these with {screenOf(them)}, word for word.
                </p>
                <WordList words={words} label="The family’s twelve words" kind="family-words" />
                <CompareGuidance />
                <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={onMatch}>
                        {busy ? 'Checking…' : 'They match'}
                    </Button>
                    <Button variant="outline" disabled={busy} onClick={onMismatch}>
                        They don’t match
                    </Button>
                </div>
            </section>
        </>
    );
}

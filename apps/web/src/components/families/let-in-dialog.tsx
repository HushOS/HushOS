import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { FingerprintWords } from '@/components/fingerprint-words';
import { Spinner } from '@/components/motion';
import { PersonAvatar } from '@/components/person-avatar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { lookupContact, pinContact, readSettingsForWrite, type Lookup } from '@/lib/contacts';
import { formatDay } from '@/lib/drive';
import {
    afterMembershipChange,
    familiesQueryOptions,
    familyContext,
    familyKeys,
    firstName,
    pendingQueryOptions,
    type PendingPerson,
} from '@/lib/families';
import { GroupApiError, groupsApi } from '@/lib/groups/api';
import { errorCopy, leftDueCopy, outcomeCopy } from '@/lib/groups/copy';
import { memberJoinCode } from '@/lib/groups/join';
import { dropKeptAdmission, letIn, type OutboxEntry } from '@/lib/groups/outbox';
import { cue } from '@/lib/sounds';
import { SeatHelp, SeatNote } from './family-billing';
import { CompareGuidance, WordList } from './word-list';

/*
 * "Let Sam in" (docs/groups-design.md 3.2). One check, the blue button, then
 * one comparison:
 *
 * 1. Sam's twelve words, read from Sam's screen. "They match" saves Sam as
 *    someone you checked (a version 3 pin), which the member list entry is
 *    built from. The keys looked up must be the ones route 16 served for Sam.
 * 2. "Let them in" signs the admitting member list over that pin and sends it
 *    (letIn). A family that changed meanwhile (409 stale) is signed again over
 *    the new head and sent, a couple of times at most.
 * 3. Once it landed, the join code of the member list that let Sam in, worked
 *    out from this device's committed chain (the stored roster, never the
 *    staged one), for Sam to compare with their screen.
 *
 * "Not now" turns Sam down. A send with no answer stays on this device and
 * goes again later; the code is then under Members ("Show Sam's join code").
 */

type Props = {
    userId: string;
    groupId: string;
    family: string;
    person: PendingPerson;
    names: Record<string, string>;
    /* Why nobody can be let in right now (a departure to finish first), said before any check. */
    blocked?: string | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
};

/* A `seats` refusal's reason and, when the bank wants a confirmation, where. */
function seatOf(data: unknown) {
    const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
    return {
        reason: typeof body.reason === 'string' ? body.reason : 'full',
        url: typeof body.url === 'string' ? body.url : null,
    };
}

/* Whether the looked-up keys are the ones route 16 served for this person: the same server, asked twice. */
function sameKeys(lookup: Lookup, person: PendingPerson) {
    const served = person.identity;
    const found = lookup.contact;
    return (
        served !== null &&
        found.userId === person.userId &&
        found.keyVersion === served.keyVersion &&
        found.encryptionPublicKey === served.encryptionPublicKey &&
        found.signingPublicKey === served.signingPublicKey &&
        found.mlDsaPublicKey === served.mlDsaPublicKey &&
        found.kemPublicKey === served.kemPublicKey
    );
}

export function LetInDialog(props: Props) {
    return (
        <Dialog open={props.open} onOpenChange={props.onOpenChange}>
            <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto overscroll-contain sm:max-w-[600px]">
                {props.open && <LetIn {...props} />}
            </DialogContent>
        </Dialog>
    );
}

function LetIn({ userId, groupId, family, person, names, blocked, onOpenChange }: Props) {
    const queryClient = useQueryClient();
    const ctx = familyContext(userId);
    const first = firstName(person.name);
    const [personChecked, setPersonChecked] = useState(false);
    const [personMismatch, setPersonMismatch] = useState(false);
    // The join code once Sam is in, from the committed chain.
    const [admitted, setAdmitted] = useState<string[] | null>(null);
    const [busy, setBusy] = useState<'pin' | 'send' | 'decline' | null>(null);
    const [error, setError] = useState('');
    const [note, setNote] = useState('');
    // A kept admission sealed to keys Sam no longer has as checked: dropped only on Maya's say.
    const [keptOther, setKeptOther] = useState<OutboxEntry | null>(null);
    // "Sam says they don't match", after Sam is in.
    const [notMatching, setNotMatching] = useState(false);
    // Refused for want of a place: why, and the bank's confirmation page when it wants one.
    const [seat, setSeat] = useState<{ reason: string; url: string | null } | null>(null);
    const roles =
        useQuery(familiesQueryOptions(userId)).data?.find((at) => at.id === groupId)?.roles ?? [];

    const lookup = useQuery({
        queryKey: ['families', userId, 'family', groupId, 'lookup', person.userId],
        queryFn: async () => {
            const found = await lookupContact(queryClient, userId, person.email);
            if (!sameKeys(found, person))
                throw new Error(
                    `HushOS showed two different sets of keys for ${first}. Don’t let them in now; try again later.`,
                );
            return found;
        },
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
    });
    // Only the admin's own words check counts: a pin taken on a family's word (trustedVia) does not.
    const alreadyChecked =
        lookup.data !== undefined &&
        lookup.data.pinned !== null &&
        !(lookup.data.pinned as { trustedVia?: unknown }).trustedVia &&
        !lookup.data.changed &&
        !lookup.data.stale;
    const changedSince = lookup.data?.changed ? lookup.data.pinned : null;
    const personDone = personChecked || alreadyChecked;

    async function theyMatch() {
        if (!lookup.data) return;
        setBusy('pin');
        setError('');
        try {
            await pinContact(queryClient, userId, lookup.data);
            setPersonChecked(true);
            cue('success');
            focusStep(2);
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family, person: first }));
        } finally {
            setBusy(null);
        }
    }

    /*
     * The join code of the member list that let Sam in, from this device's committed chain, once
     * Sam's entry there is the keys Maya's pin holds (someone else may have let them in, with
     * other keys): otherwise no code, and a warning.
     */
    async function showCode(message = '') {
        // The worker compares with the contact pin in the settings it opened, never one passed in.
        await readSettingsForWrite(userId);
        const { code, pinMatches } = await memberJoinCode(ctx, groupId, person.userId);
        if (pinMatches !== true)
            throw new Error(
                `${first} is in ${family}, but not with the keys you checked. Don’t compare a join code with them yet: ask whether their account changed, and check their words again.`,
            );
        setAdmitted(code);
        setNote(message);
        focusStep(3);
    }

    /* "Let them in": signed over Sam's checked keys and sent; a stale answer signs it again. */
    async function letThemIn() {
        setBusy('send');
        setError('');
        setNote('');
        setSeat(null);
        try {
            for (let attempt = 0; attempt < 3; attempt++) {
                const fresh = (
                    await queryClient.fetchQuery({
                        ...pendingQueryOptions(userId, groupId),
                        staleTime: 0,
                    })
                ).find((at) => at.userId === person.userId);
                if (!fresh?.identity) {
                    // Let in meanwhile (another manager, or a send this device never heard back
                    // from): their code is the one to compare.
                    if (attempt > 0) {
                        await showCode(`${first} was let in meanwhile. This is their join code.`);
                        cue('success');
                        return;
                    }
                    throw new Error(`${first} isn’t waiting to join any more.`);
                }
                const { settings } = await readSettingsForWrite(userId);
                const pin = settings.contacts[person.userId];
                if (!pin) throw new Error(`Check ${first}’s words first.`);
                // The worker admits over the contact pin in the settings it just opened.
                const staged = await letIn(
                    ctx,
                    groupId,
                    {
                        kind: 'admit',
                        userId: person.userId,
                        served: fresh.identity,
                        roles: fresh.roles,
                    },
                    pin,
                );
                if (staged.status === 'kept-other-keys') {
                    setKeptOther(staged.entry);
                    return;
                }
                if (staged.status === 'not-synced' && staged.sync.status === 'fork')
                    throw new Error(
                        `The member list of ${family} was shown differently to you. Don’t let anyone in until that’s sorted.`,
                    );
                if (staged.status !== 'sent')
                    throw new Error(`Couldn’t check ${family}. Try again.`);
                const outcome = staged.outcome;
                void afterMembershipChange(queryClient, userId);
                switch (outcome.status) {
                    case 'landed':
                        cue('success');
                        await showCode(
                            attempt > 0
                                ? `The member list of ${family} changed while you were letting ${first} in, so HushOS signed it again.`
                                : '',
                        );
                        return;
                    case 'stale':
                        // Dropped and synced by the outbox: signed again over the new head.
                        continue;
                    case 'pending':
                        toast.add({
                            type: 'info',
                            title: 'Saved on this device',
                            description: `HushOS couldn’t reach the server. ${first} is let in once it can; then compare the join code from Members.`,
                        });
                        onOpenChange(false);
                        return;
                    case 'membership-moved':
                        cue('error');
                        setError(
                            outcome.code === 'left-due'
                                ? leftDueCopy(outcome.data, { names })
                                : (outcomeCopy(outcome, { family, person: first, names }) ?? ''),
                        );
                        return;
                    default:
                        cue('error');
                        if (outcome.status === 'refused' && outcome.code === 'seats')
                            setSeat(seatOf(outcome.data));
                        setError(outcomeCopy(outcome, { family, person: first, names }) ?? '');
                        return;
                }
            }
            throw new Error(`The member list of ${family} keeps changing. Try again in a moment.`);
        } catch (cause) {
            cue('error');
            if (cause instanceof GroupApiError && cause.code === 'seats')
                setSeat(seatOf(cause.data));
            setError(errorCopy(cause, { family, person: first, names }));
        } finally {
            setBusy(null);
        }
    }

    /* Maya drops the kept admission with the old keys; Sam is still waiting, so it never landed. */
    async function dropAndLetIn() {
        if (!keptOther) return;
        setBusy('send');
        setError('');
        try {
            const fresh = (
                await queryClient.fetchQuery({
                    ...pendingQueryOptions(userId, groupId),
                    staleTime: 0,
                })
            ).find((at) => at.userId === person.userId);
            if (!fresh) throw new Error(`${first} isn’t waiting to join any more.`);
            await dropKeptAdmission(ctx, keptOther);
            setKeptOther(null);
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family, person: first, names }));
            setBusy(null);
            return;
        }
        setBusy(null);
        await letThemIn();
    }

    async function notNow() {
        setBusy('decline');
        setError('');
        try {
            await groupsApi.decline(groupId, person.userId);
            cue('close');
            toast.add({
                type: 'success',
                title: `${first} won’t join ${family}`,
                description: 'You can invite them again.',
            });
            void queryClient.invalidateQueries({ queryKey: familyKeys.pending(userId, groupId) });
            onOpenChange(false);
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family, person: first }));
        } finally {
            setBusy(null);
        }
    }

    // A finished step hands focus to the next one's heading, so nobody starts again at the top.
    const steps = useRef<HTMLOListElement>(null);
    const focusStep = (n: number) =>
        requestAnimationFrame(() =>
            steps.current?.querySelector<HTMLElement>(`[data-step="${n}"] h3`)?.focus(),
        );
    // Compare again: the pressed button goes with the warning, so focus moves to the step's heading
    // at once; a frame later the dialog has already taken it back.
    const compareAgain = (n: number, reset: () => void) => {
        flushSync(reset);
        steps.current?.querySelector<HTMLElement>(`[data-step="${n}"] h3`)?.focus();
    };
    const [confirmingDecline, setConfirmingDecline] = useState(false);
    // A refusal lands just above the pinned footer: brought into view, wherever the card is scrolled.
    const refusal = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (error || seat) refusal.current?.scrollIntoView({ block: 'nearest' });
    }, [error, seat]);

    return (
        <>
            <DialogHeader>
                <DialogTitle>Let {first} in</DialogTitle>
                <DialogDescription>
                    Do this with {first} on a call or in person. Check their words, let them in,
                    then compare a join code.
                </DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-3">
                <PersonAvatar name={person.name} seed={person.userId} size={44} />
                <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[15px] font-semibold">{person.name}</span>
                    <span className="truncate text-[13px] text-muted-foreground">
                        {person.email}
                    </span>
                </div>
            </div>
            {blocked && !admitted && (
                <p
                    role="alert"
                    className="rounded-xl bg-warning-soft px-3.5 py-3 text-sm text-foreground"
                >
                    {blocked}
                </p>
            )}
            <CompareGuidance />
            <ol ref={steps} className="flex flex-col gap-6">
                <Step
                    n={1}
                    title={`${first}’s twelve words`}
                    done={personDone || Boolean(admitted)}
                    doneLine={
                        personChecked
                            ? `They match. ${first} is saved as someone you checked.`
                            : alreadyChecked
                              ? `You checked ${first}’s words on ${formatDay(lookup.data!.pinned!.pinnedAt)}.`
                              : `You checked ${first}’s words.`
                    }
                >
                    {lookup.isPending ? (
                        <Spinner className="size-4 text-muted-foreground" />
                    ) : lookup.isError ? (
                        <p role="alert" className="text-sm text-destructive">
                            {errorCopy(lookup.error)}
                        </p>
                    ) : !lookup.data.upgraded ? (
                        <p className="text-sm text-muted-foreground">
                            {first} needs to sign in to HushOS once more before you can compare
                            words.
                        </p>
                    ) : personMismatch ? (
                        // The hard alarm, as the newcomer's screen gives it: they may not be who they say.
                        <Alert variant="destructive" data-mismatch="words">
                            <AlertTitle>Don’t let {first} in yet</AlertTitle>
                            <AlertDescription>
                                <p>
                                    First check that {first} is reading the words on their own join
                                    screen, then compare again: nothing was saved. If they still
                                    don’t match, check the email address with them; if it’s right,
                                    HushOS may not be showing you their real keys.
                                </p>
                                <Button
                                    variant="outline"
                                    className="mt-3"
                                    onClick={() => compareAgain(1, () => setPersonMismatch(false))}
                                >
                                    Compare again
                                </Button>
                            </AlertDescription>
                        </Alert>
                    ) : (
                        <div className="flex flex-col gap-3">
                            {changedSince ? (
                                <p className="rounded-xl bg-accent px-3.5 py-3 text-sm text-accent-foreground">
                                    {first}’s account has changed since you checked it on{' '}
                                    {formatDay(changedSince.pinnedAt)}. That can be a new phone or a
                                    reset, or someone pretending. Compare their words before you let
                                    them in.
                                </p>
                            ) : (
                                <p className="text-sm text-muted-foreground">
                                    Ask {first} to read you the twelve words on their join screen.
                                </p>
                            )}
                            {lookup.data.fingerprint && (
                                <FingerprintWords fingerprint={lookup.data.fingerprint} />
                            )}
                            <div className="flex flex-wrap gap-2">
                                <Button
                                    variant="outline"
                                    disabled={busy !== null}
                                    onClick={() => void theyMatch()}
                                >
                                    {busy === 'pin' ? 'Saving' : 'They match'}
                                </Button>
                                <Button
                                    variant="ghost"
                                    disabled={busy !== null}
                                    onClick={() => setPersonMismatch(true)}
                                >
                                    They don’t match
                                </Button>
                            </div>
                        </div>
                    )}
                </Step>
                <Step
                    n={2}
                    title={`Let ${first} in`}
                    done={Boolean(admitted)}
                    doneLine={`${first} is in ${family}.`}
                >
                    <p className="text-sm text-muted-foreground">
                        Once their words match, let them in. Their screen then shows a join code.
                    </p>
                </Step>
                <Step n={3} title="Compare the join code" done={false}>
                    {admitted ? (
                        <div className="flex flex-col gap-3">
                            {note && <output className="block text-sm font-medium">{note}</output>}
                            <p className="text-sm text-muted-foreground">
                                Read all twelve words to {first}. Two are hidden on {first}’s
                                screen; {first} types those.
                            </p>
                            <WordList words={admitted} label="Join code" kind="join-code" />
                            {notMatching ? (
                                // The same hard alarm the newcomer sees for the same moment.
                                <Alert variant="destructive" data-mismatch="join-code">
                                    <AlertTitle>
                                        Don’t share anything with {first} through {family} yet
                                    </AlertTitle>
                                    <AlertDescription>
                                        <p>
                                            First check that {first} is on their own join screen and
                                            that you both read this code, word for word. If it still
                                            doesn’t match, HushOS may be showing {first} a different
                                            member list.
                                        </p>
                                        <p className="mt-2">
                                            {first} is in the member list of {family}, but their
                                            device won’t use the family until the codes match, so
                                            their folders stay closed to them. Sort it out together.
                                            If you can’t, close this and choose Remove from family
                                            in {first}’s row under Members.
                                        </p>
                                        <Button
                                            variant="outline"
                                            className="mt-3"
                                            onClick={() =>
                                                compareAgain(3, () => setNotMatching(false))
                                            }
                                        >
                                            Compare again
                                        </Button>
                                    </AlertDescription>
                                </Alert>
                            ) : (
                                <Button
                                    variant="ghost"
                                    className="self-start"
                                    onClick={() => setNotMatching(true)}
                                >
                                    {first} says they don’t match
                                </Button>
                            )}
                        </div>
                    ) : (
                        <p className="text-sm text-muted-foreground">
                            After you let {first} in, the two of you compare it here.
                        </p>
                    )}
                </Step>
            </ol>
            {keptOther && !admitted && (
                <div
                    role="alert"
                    className="flex flex-col items-start gap-2 rounded-xl bg-warning-soft px-3.5 py-3 text-sm text-foreground"
                >
                    <p>
                        An earlier “Let them in” for {first}, made before their account changed,
                        hasn’t reached the server, and it is for their old keys. Drop it and let
                        them in with the keys you just checked.
                    </p>
                    <Button
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void dropAndLetIn()}
                    >
                        Drop it and let them in
                    </Button>
                </div>
            )}
            <div ref={refusal} className="flex flex-col gap-3 empty:hidden">
                {error && (
                    <p role="alert" className="text-sm text-destructive">
                        {error}
                    </p>
                )}
                {seat && !admitted && (
                    <SeatHelp
                        userId={userId}
                        groupId={groupId}
                        roles={roles}
                        reason={seat.reason}
                        url={seat.url}
                        onChoosePlan={() => {
                            onOpenChange(false);
                            requestAnimationFrame(() =>
                                document
                                    .getElementById('choose-plan')
                                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
                            );
                        }}
                    />
                )}
            </div>
            {!admitted && !seat && personDone && (
                <SeatNote userId={userId} groupId={groupId} first={first} />
            )}
            {/*
             * Pinned to the foot of the scrolling card, so its actions stay in reach on a phone.
             * The card's scroll padding is its height, so what is scrolled into view (a refusal)
             * lands above it rather than under it.
             */}
            <div
                ref={(footer) => {
                    const card = footer?.parentElement;
                    if (!footer || !card) return;
                    const pad = () => (card.style.scrollPaddingBottom = `${footer.offsetHeight}px`);
                    pad();
                    const observer = new ResizeObserver(pad);
                    observer.observe(footer);
                    return () => {
                        observer.disconnect();
                        card.style.scrollPaddingBottom = '';
                    };
                }}
                className="sticky -bottom-6 z-10 -mx-6 -mb-6 flex flex-wrap justify-end gap-2 border-t border-rule bg-popover px-6 pt-4 pb-6 sm:-bottom-7 sm:-mx-7 sm:-mb-7 sm:px-7 sm:pb-7"
            >
                {admitted ? (
                    <Button onClick={() => onOpenChange(false)}>Done</Button>
                ) : (
                    <>
                        <Button
                            variant="outline"
                            disabled={busy !== null}
                            onClick={() => setConfirmingDecline(true)}
                        >
                            {busy === 'decline' ? 'Turning down' : 'Not now'}
                        </Button>
                        <Button
                            // A departure to finish first: the server would refuse the admission.
                            disabled={
                                !personDone ||
                                busy !== null ||
                                Boolean(blocked) ||
                                Boolean(keptOther)
                            }
                            onClick={() => void letThemIn()}
                        >
                            {busy === 'send' ? 'Letting them in' : 'Let them in'}
                        </Button>
                    </>
                )}
            </div>
            <AlertDialog open={confirmingDecline} onOpenChange={setConfirmingDecline}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Turn {first} down?</AlertDialogTitle>
                        <AlertDialogDescription>
                            They’ll need a new invitation to join {family}. To decide later, close
                            this instead: nothing is lost.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            onClick={() => {
                                setConfirmingDecline(false);
                                void notNow();
                            }}
                        >
                            Turn down
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

function Step({
    n,
    title,
    done,
    doneLine,
    children,
}: {
    n: number;
    title: string;
    done: boolean;
    doneLine?: string;
    children: ReactNode;
}) {
    return (
        <li className="flex flex-col gap-2.5" data-step={n} data-done={done || undefined}>
            <h3
                tabIndex={-1}
                className="flex items-center gap-2 text-[15px] font-semibold outline-none"
            >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[13px] tabular-nums">
                    {done ? <CheckIcon className="size-3.5" aria-hidden="true" /> : n}
                </span>
                {title}
                {done && <span className="sr-only">, done</span>}
            </h3>
            {done && doneLine ? (
                <p className="pl-8 text-sm text-muted-foreground">{doneLine}</p>
            ) : (
                <div className="pl-8">{children}</div>
            )}
        </li>
    );
}

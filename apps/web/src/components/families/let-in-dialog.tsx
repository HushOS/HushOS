import type { ContactPin } from '@hushos/crypto/contacts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckIcon } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { FingerprintWords } from '@/components/fingerprint-words';
import { Spinner } from '@/components/motion';
import { PersonAvatar } from '@/components/person-avatar';
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
import { Checkbox } from '@/components/ui/checkbox';
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
    afterFamilyChange,
    familyContext,
    familyKeys,
    firstName,
    pendingQueryOptions,
    pinnedFamilyWords,
    type PendingPerson,
} from '@/lib/families';
import { groupsApi } from '@/lib/groups/api';
import { errorCopy, leftDueCopy, outcomeCopy } from '@/lib/groups/copy';
import {
    confirmAdmission,
    dropAdmission,
    stageChange,
    waitingAdmission,
    type OutboxEntry,
} from '@/lib/groups/outbox';
import { cue } from '@/lib/sounds';
import { CompareGuidance, WordList } from './word-list';

/*
 * "Let Sam in" (the 1c plan, "The admin's dialog"). Three checks, in order,
 * and one blue button:
 *
 * 1. Sam's twelve words, read from Sam's screen. "They match" saves Sam as
 *    someone you checked (a version 3 pin), which the member list entry is
 *    built from. The keys looked up must be the ones route 16 served for Sam.
 * 2. The family's twelve words, which Sam reads from their screen.
 * 3. Only then is the admitting member list signed (kept on this device,
 *    never sent by itself), and its join code shown for Sam to type.
 *
 * "Let them in" sends it once all three are ticked. A family that changed
 * meanwhile (409 stale) gets a new member list and a new code, read again.
 * Closing the dialog keeps the signed change: reopening, even after a reload,
 * comes back to the same code. "Not now" drops it and turns Sam down.
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
            <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-[600px]">
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
    const [familyChecked, setFamilyChecked] = useState(false);
    const [codeTyped, setCodeTyped] = useState(false);
    // undefined: whatever an earlier visit left waiting (below); null: none, or dropped since.
    const [entryState, setEntry] = useState<OutboxEntry | null | undefined>(undefined);
    const [busy, setBusy] = useState<'pin' | 'stage' | 'send' | 'decline' | null>(null);
    const [error, setError] = useState('');
    const [note, setNote] = useState('');

    // An admission signed before (this tab or an earlier visit) comes back at its join code.
    const waiting = useQuery({
        queryKey: ['families', userId, 'family', groupId, 'waiting', person.userId],
        queryFn: () => waitingAdmission(ctx, groupId, person.userId),
        staleTime: 0,
        gcTime: 0,
        retry: false,
    });
    const entry = entryState === undefined ? (waiting.data ?? null) : entryState;
    // A waiting admission was signed only after both word checks: they were done then.
    const resumed = entryState === undefined && Boolean(waiting.data);

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
        enabled: !waiting.isPending && entry === null,
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
    const personDone = personChecked || alreadyChecked || resumed;
    const familyDone = familyChecked || resumed;

    const familyWords = useQuery({
        queryKey: ['families', userId, 'family', groupId, 'words'],
        queryFn: () => pinnedFamilyWords(userId, groupId),
        enabled: !waiting.isPending && entry === null,
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
    });

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

    /* Signs the admitting member list over Sam's checked keys, kept awaiting the code check. */
    async function stage(message = '') {
        setBusy('stage');
        setError('');
        setNote(message);
        setCodeTyped(false);
        try {
            const fresh = (
                await queryClient.fetchQuery({
                    ...pendingQueryOptions(userId, groupId),
                    staleTime: 0,
                })
            ).find((at) => at.userId === person.userId);
            if (!fresh?.identity) throw new Error(`${first} isn’t waiting to join any more.`);
            const { settings } = await readSettingsForWrite(userId);
            const pin = settings.contacts[person.userId];
            if (!pin) throw new Error(`Check ${first}’s words first.`);
            const staged = await stageChange(ctx, groupId, {
                kind: 'admit',
                userId: person.userId,
                pin: pin as unknown as ContactPin,
                served: fresh.identity,
                roles: fresh.roles,
            });
            if (staged.status === 'awaiting-check') {
                setEntry(staged.entry);
                focusStep(3);
                return;
            }
            if (staged.status === 'not-synced' && staged.sync.status === 'fork')
                throw new Error(
                    `${family}’s member list was shown differently to you. Don’t let anyone in until that’s sorted.`,
                );
            throw new Error(`Couldn’t check ${family}. Try again.`);
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family, person: first, names }));
        } finally {
            setBusy(null);
        }
    }

    async function letIn() {
        if (!entry) return;
        setBusy('send');
        setError('');
        setNote('');
        try {
            const outcome = await confirmAdmission(ctx, entry);
            void afterFamilyChange(queryClient, userId);
            switch (outcome.status) {
                case 'landed':
                    cue('success');
                    toast.add({ type: 'success', title: `${first} is in ${family}` });
                    onOpenChange(false);
                    return;
                case 'stale':
                    // Dropped and synced by the outbox: a new member list and a new code, read again.
                    setPersonChecked(true);
                    setFamilyChecked(true);
                    setEntry(null);
                    setBusy(null);
                    await stage(
                        `The family changed while you were checking. Read ${first} the new join code.`,
                    );
                    return;
                case 'pending':
                    toast.add({
                        type: 'info',
                        title: 'Saved on this device',
                        description: `HushOS couldn’t reach the server. ${first} is let in once it can.`,
                    });
                    onOpenChange(false);
                    return;
                case 'membership-moved':
                    setEntry(null);
                    setError(
                        outcome.code === 'left-due'
                            ? leftDueCopy(outcome.data, { names })
                            : (outcomeCopy(outcome, { family, person: first, names }) ?? ''),
                    );
                    return;
                case 'dropped':
                    setEntry(null);
                    setError(outcomeCopy(outcome) ?? '');
                    void waiting.refetch();
                    return;
                default:
                    setEntry(null);
                    cue('error');
                    setError(outcomeCopy(outcome, { family, person: first, names }) ?? '');
            }
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family, person: first, names }));
        } finally {
            setBusy((current) => (current === 'send' ? null : current));
        }
    }

    async function notNow() {
        setBusy('decline');
        setError('');
        try {
            const current = entry ?? (await waitingAdmission(ctx, groupId, person.userId));
            if (current) await dropAdmission(ctx, current);
            await groupsApi.decline(groupId, person.userId);
            cue('droplet');
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
    const [confirmingDecline, setConfirmingDecline] = useState(false);

    const loading = waiting.isPending;
    return (
        <>
            <DialogHeader>
                <DialogTitle>Let {first} in</DialogTitle>
                <DialogDescription>
                    Do this with {first} on a call or in person. Three checks, then they’re in.
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
            {blocked && (
                <p
                    role="alert"
                    className="rounded-xl bg-warning-soft px-3.5 py-3 text-sm text-foreground"
                >
                    {blocked}
                </p>
            )}
            <CompareGuidance />
            {loading ? (
                <output className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                    <Spinner className="size-4" />
                    Opening
                </output>
            ) : (
                <ol ref={steps} className="flex flex-col gap-6">
                    <Step
                        n={1}
                        title={`${first}’s twelve words`}
                        done={personDone}
                        doneLine={
                            entry
                                ? `You checked ${first}’s words.`
                                : alreadyChecked
                                  ? `You checked ${first}’s words on ${formatDay(lookup.data!.pinned!.pinnedAt)}.`
                                  : `They match. ${first} is saved as someone you checked.`
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
                        ) : changedSince && !personChecked ? (
                            <div className="flex flex-col gap-3">
                                <p className="rounded-xl bg-accent px-3.5 py-3 text-sm text-accent-foreground">
                                    {first}’s account has changed since you checked it on{' '}
                                    {formatDay(changedSince.pinnedAt)}. That can be a new phone or a
                                    reset, or someone pretending. Compare their words before you let
                                    them in.
                                </p>
                                {lookup.data.fingerprint && (
                                    <FingerprintWords fingerprint={lookup.data.fingerprint} />
                                )}
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        variant="outline"
                                        disabled={busy !== null || personMismatch}
                                        onClick={() => void theyMatch()}
                                    >
                                        {busy === 'pin' ? 'Saving…' : 'They match'}
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        disabled={busy !== null}
                                        onClick={() => setPersonMismatch(true)}
                                    >
                                        They don’t match
                                    </Button>
                                </div>
                                {personMismatch && (
                                    <p role="alert" className="text-sm text-destructive">
                                        Don’t let {first} in. Check the email address with them; if
                                        it’s right, HushOS may not be showing you their real keys.
                                    </p>
                                )}
                            </div>
                        ) : personMismatch ? (
                            <p role="alert" className="text-sm text-destructive">
                                Don’t let {first} in. Check the email address with them; if it’s
                                right, HushOS may not be showing you their real keys.
                            </p>
                        ) : (
                            <div className="flex flex-col gap-3">
                                <p className="text-sm text-muted-foreground">
                                    Ask {first} to open Your twelve words (in the account menu) and
                                    read them to you.
                                </p>
                                {lookup.data.fingerprint && (
                                    <FingerprintWords fingerprint={lookup.data.fingerprint} />
                                )}
                                <div className="flex flex-wrap gap-2">
                                    <Button
                                        variant="outline"
                                        disabled={busy !== null}
                                        onClick={() => void theyMatch()}
                                    >
                                        {busy === 'pin' ? 'Saving…' : 'They match'}
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
                        title="The family’s twelve words"
                        done={familyDone && Boolean(entry)}
                        doneLine={`${first} said the family’s words match.`}
                    >
                        {familyWords.isPending ? (
                            <Spinner className="size-4 text-muted-foreground" />
                        ) : familyWords.isError ? (
                            <p role="alert" className="text-sm text-destructive">
                                {errorCopy(familyWords.error)}
                            </p>
                        ) : (
                            <div className="flex flex-col gap-3">
                                <p className="text-sm text-muted-foreground">
                                    Compare these with {first}’s screen, word for word.
                                </p>
                                <WordList
                                    words={familyWords.data}
                                    label="The family’s twelve words"
                                    kind="family-words"
                                />
                                <label className="flex items-center gap-2.5 text-sm">
                                    <Checkbox
                                        checked={familyDone}
                                        disabled={!personDone}
                                        onCheckedChange={(checked) =>
                                            setFamilyChecked(checked === true)
                                        }
                                    />
                                    {first} says they match
                                </label>
                            </div>
                        )}
                    </Step>
                    <Step n={3} title="Join code" done={false}>
                        {entry?.joinCode ? (
                            <div className="flex flex-col gap-3">
                                {note && (
                                    <output className="block text-sm font-medium">{note}</output>
                                )}
                                <p className="text-sm text-muted-foreground">
                                    Read this to {first}. They type it on their screen and check
                                    that it says member list {entry.joinCode.rosterVersion} too.
                                </p>
                                <p className="text-[15px] font-semibold">
                                    Join code for member list {entry.joinCode.rosterVersion}
                                </p>
                                <WordList
                                    words={entry.joinCode.code}
                                    label="Join code"
                                    kind="join-code"
                                />
                                <label className="flex items-center gap-2.5 text-sm">
                                    <Checkbox
                                        checked={codeTyped}
                                        onCheckedChange={(checked) =>
                                            setCodeTyped(checked === true)
                                        }
                                    />
                                    {first} typed the join code
                                </label>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-2">
                                <p className="text-sm text-muted-foreground">
                                    Once both of you have checked the words, HushOS makes a join
                                    code for {first} to type.
                                </p>
                                <Button
                                    variant="outline"
                                    className="self-start"
                                    disabled={
                                        !personDone ||
                                        !familyDone ||
                                        busy !== null ||
                                        Boolean(blocked)
                                    }
                                    onClick={() => void stage()}
                                >
                                    {busy === 'stage' ? 'Making the code…' : 'Show join code'}
                                </Button>
                            </div>
                        )}
                    </Step>
                </ol>
            )}
            {error && (
                <p role="alert" className="text-sm text-destructive">
                    {error}
                </p>
            )}
            <div className="flex flex-wrap justify-end gap-2 border-t border-rule pt-4">
                <Button
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => setConfirmingDecline(true)}
                >
                    {busy === 'decline' ? 'Turning down…' : 'Not now'}
                </Button>
                <Button
                    // A departure to finish first: the server would refuse, and the signed admission go.
                    disabled={
                        !entry ||
                        !personDone ||
                        !familyDone ||
                        !codeTyped ||
                        busy !== null ||
                        Boolean(blocked)
                    }
                    onClick={() => void letIn()}
                >
                    {busy === 'send' ? 'Letting them in…' : 'Let them in'}
                </Button>
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

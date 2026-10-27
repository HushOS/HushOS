import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, RotateCcwIcon } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { firstName } from '@/components/drive/add-someone';
import { FingerprintWords } from '@/components/fingerprint-words';
import { Spinner } from '@/components/motion';
import {
    AlertDialog,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { lookupContact, notUpgradedWords, pinContact, type Lookup } from '@/lib/contacts';
import { driveError, driveKeys, formatDay } from '@/lib/drive';
import { vouchLine } from '@/lib/family-pin';
import { afterTrustChanged } from '@/lib/integrity';
import { stopSharingWithPerson } from '@/lib/rotation';
import { cue } from '@/lib/sounds';

/* Who is being checked: from a contact, a share row, a mark or the changed-account notice. */
export type Checking = { email: string; name: string };

/*
 * A check asked for by something that may not stay on screen: a mark clears
 * the moment its writer is added, and the check offered next must outlive it.
 * The drive shell hosts it (CheckContactHost).
 */
let requested: Checking | null = null;
const listeners = new Set<() => void>();
export function requestCheck(person: Checking | null) {
    requested = person;
    for (const listener of listeners) listener();
}
export function CheckContactHost({ userId }: { userId: string }) {
    const person = useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => requested,
        () => null,
    );
    return (
        <CheckContactDialog
            userId={userId}
            person={person}
            onOpenChange={(open) => !open && requestCheck(null)}
        />
    );
}

/*
 * Check it's Maya (docs/optional-verification.md 6.6), the advanced door: the
 * twelve words over the keys HushOS serves for them now, read against the
 * ones on their own device. They match makes the pin verified (over new keys,
 * it is also a Continue); They don't match saves nothing, and offers Stop
 * sharing with Maya, the remedy for shares sealed to keys that were not theirs.
 */
export function CheckContactDialog({
    userId,
    person,
    onOpenChange,
    onChecked,
}: {
    userId: string;
    person: Checking | null;
    onOpenChange: (open: boolean) => void;
    onChecked?: () => void;
}) {
    return (
        <Dialog open={person !== null} onOpenChange={onOpenChange}>
            <DialogContent
                className="sm:max-w-[480px]"
                onClick={(event) => event.stopPropagation()}
            >
                {person && (
                    <CheckContact
                        key={person.email}
                        userId={userId}
                        person={person}
                        onDone={() => onOpenChange(false)}
                        onChecked={onChecked}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function CheckContact({
    userId,
    person,
    onDone,
    onChecked,
}: {
    userId: string;
    person: Checking;
    onDone: () => void;
    onChecked?: () => void;
}) {
    const queryClient = useQueryClient();
    const found = useQuery({
        queryKey: ['contacts', 'check', userId, person.email],
        queryFn: () => lookupContact(queryClient, userId, person.email),
        staleTime: Infinity,
        gcTime: 0,
        retry: false,
    });
    const [mismatch, setMismatch] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const [stopping, setStopping] = useState(false);
    const name = firstName(found.data?.contact.name ?? person.name);

    async function theyMatch(lookup: Lookup) {
        setSaving(true);
        setError('');
        try {
            await pinContact(queryClient, userId, lookup);
            // What they wrote now reads as verified, and what waited on them runs.
            afterTrustChanged(queryClient);
            void queryClient.invalidateQueries({ queryKey: driveKeys.shared });
            cue('success');
            toast.add({ type: 'success', title: `${name} verified` });
            onChecked?.();
            onDone();
        } catch (cause) {
            cue('error');
            setError(cause instanceof Error ? cause.message : 'That wasn’t saved. Try again.');
        } finally {
            setSaving(false);
        }
    }

    async function stopSharing(contactId: string) {
        setSaving(true);
        try {
            await stopSharingWithPerson(queryClient, contactId);
            cue('droplet');
            toast.add({ type: 'success', title: `Stopped sharing with ${name}` });
            onDone();
        } catch (cause) {
            cue('error');
            toast.add({
                type: 'error',
                title: 'Couldn’t stop sharing',
                description: driveError(cause),
            });
        } finally {
            setSaving(false);
        }
    }

    const lookup = found.data;
    const replacedAt = lookup?.pinned?.keysReplacedAt ?? null;
    const vouched = lookup?.pinned ? vouchLine(lookup.pinned) : null;

    return (
        <>
            <DialogHeader>
                <DialogTitle>Check it’s {name}</DialogTitle>
                <DialogDescription>
                    {mismatch
                        ? `These don’t match. Check ${name}’s email address with them. If it’s right and they still don’t match, you can stop sharing with ${name} for now and share again once they do.`
                        : `Ask ${name} to open Contacts in HushOS and choose Your twelve words. If theirs match these, it’s really them. Do it in person or on a call.`}
                </DialogDescription>
            </DialogHeader>
            {found.isPending && (
                <output className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
                    <Spinner className="size-4" />
                    Getting their words
                </output>
            )}
            {found.isError && (
                <div className="flex flex-col items-start gap-3">
                    <p role="alert" className="text-sm text-destructive">
                        {driveError(found.error)}
                    </p>
                    <Button variant="outline" onClick={() => void found.refetch()}>
                        <RotateCcwIcon />
                        Try again
                    </Button>
                </div>
            )}
            {lookup && !lookup.upgraded && (
                <p className="text-sm leading-snug text-muted-foreground">
                    {notUpgradedWords(lookup.contact.name)}
                </p>
            )}
            {lookup?.fingerprint && !mismatch && (
                <div className="flex flex-col gap-3">
                    {vouched && (
                        <p data-vouched className="text-[13px] text-muted-foreground">
                            {vouched}
                        </p>
                    )}
                    {replacedAt && (
                        <p data-followed className="text-[13px] text-muted-foreground">
                            {name} updated their account on {formatDay(replacedAt)}.
                        </p>
                    )}
                    <FingerprintWords fingerprint={lookup.fingerprint} pairs />
                    <details className="group">
                        <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[13px] font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                            Technical details
                            <ChevronDownIcon
                                aria-hidden="true"
                                className="size-3.5 transition-transform group-open:rotate-180"
                            />
                        </summary>
                        <p className="mt-2 text-[13px] text-muted-foreground">
                            These words are worked out from {name}’s four public keys. Comparing
                            them confirms the keys HushOS gave your device are theirs.
                        </p>
                        <p
                            data-fingerprint={lookup.fingerprint}
                            className="mt-2 rounded-md bg-muted px-3 py-2 font-mono text-[13px] leading-relaxed wrap-anywhere"
                        >
                            {lookup.fingerprint}
                        </p>
                    </details>
                </div>
            )}
            {error && (
                <p role="alert" className="text-[13px] text-destructive">
                    {error}
                </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
                {!lookup?.fingerprint ? (
                    <Button variant="outline" onClick={onDone}>
                        {lookup ? 'Done' : 'Cancel'}
                    </Button>
                ) : mismatch ? (
                    <>
                        {lookup.pinned && (
                            <Button
                                variant="outline"
                                disabled={saving}
                                onClick={() => setStopping(true)}
                            >
                                Stop sharing with {name}
                            </Button>
                        )}
                        <Button onClick={onDone}>Done</Button>
                    </>
                ) : (
                    <>
                        <Button
                            variant="outline"
                            disabled={saving}
                            onClick={() => {
                                cue('error');
                                setMismatch(true);
                            }}
                        >
                            They don’t match
                        </Button>
                        <Button disabled={saving} onClick={() => void theyMatch(lookup)}>
                            {saving ? 'Saving…' : 'They match'}
                        </Button>
                    </>
                )}
            </div>
            <AlertDialog open={stopping} onOpenChange={setStopping}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Stop sharing with {name}?</AlertDialogTitle>
                        <AlertDialogDescription>
                            {name} can’t open anything you’ve shared with them any more, including
                            what you add to those folders later. You can share again once your words
                            match.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <Button
                            variant="destructive"
                            onClick={() => {
                                setStopping(false);
                                if (lookup) void stopSharing(lookup.contact.userId);
                            }}
                        >
                            Stop sharing
                        </Button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

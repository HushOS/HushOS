import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import { Spinner } from '@/components/motion';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { familyContext, firstName } from '@/lib/families';
import { familyCheckCode, familyCheckMatch, olderAppCode } from '@/lib/family-trust';
import { errorCopy } from '@/lib/groups/copy';
import { afterTrustChanged } from '@/lib/integrity';
import { cue } from '@/lib/sounds';
import { WordList } from './word-list';

/*
 * Check it's Sam, in a family (docs/optional-verification.md 3.4, 6.10): one
 * comparison between two members. The family is synced first ("Getting the
 * latest"), then both screens show the same twelve words, worked out from the
 * member list that let the later of the two in and both accounts. They match
 * on each side writes that side's records; They don't match writes nothing.
 * For a phone on the older app (iOS 0.10.0), whose screen asks for two hidden
 * words, the old join code is read to it from here, one way: nothing is
 * saved on this device from that.
 */

export type FamilyMemberRef = { userId: string; name: string; email: string };

type Stage = 'words' | 'mismatch' | 'older';

export function FamilyCheckDialog({
    userId,
    groupId,
    family,
    member,
    me,
    organizer,
    onClose,
    onChecked,
    onCheckWords,
}: {
    userId: string;
    groupId: string;
    family: string;
    member: FamilyMemberRef;
    /* This person's own first name, as the other screen names them. */
    me: string;
    /* Who to ask for help when the words differ: the organizer, or null when it's this person. */
    organizer: string | null;
    onClose: () => void;
    /* They match went through: `verified` when this device now holds them as checked. */
    onChecked?: (result: { verified: boolean }) => void;
    /* Their own twelve words (6.6), for a device that can't check the family with them. */
    onCheckWords: () => void;
}) {
    const queryClient = useQueryClient();
    const ctx = familyContext(userId);
    const who = firstName(member.name);
    const [stage, setStage] = useState<Stage>('words');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');
    const code = useQuery({
        queryKey: ['families', userId, 'family', groupId, 'pair-code', member.userId],
        queryFn: () => familyCheckCode(ctx, groupId, member.userId),
        staleTime: 0,
        gcTime: 0,
        retry: false,
    });
    const older = useQuery({
        queryKey: ['families', userId, 'family', groupId, 'older-code', member.userId],
        queryFn: () => olderAppCode(ctx, groupId, member.userId),
        enabled: stage === 'older',
        staleTime: 0,
        gcTime: 0,
        retry: false,
    });
    const shown = code.data?.status === 'code' ? code.data : null;

    async function theyMatch() {
        if (!shown) return;
        setSaving(true);
        setError('');
        try {
            const result = await familyCheckMatch(queryClient, userId, ctx, groupId, member, {
                rosterVersion: shown.rosterVersion,
                code: shown.code,
            });
            if (!result.checked) {
                // The family moved on this device since the words were shown: worked out again.
                cue('error');
                setError('The family changed meanwhile. Compare these words again.');
                void code.refetch();
                return;
            }
            afterTrustChanged(queryClient);
            void queryClient.invalidateQueries({ queryKey: ['families', userId] });
            cue('success');
            toast.add({
                type: 'success',
                title: result.verified
                    ? `You and ${who} checked each other`
                    : `You and ${who} see the same family`,
            });
            onChecked?.(result);
            onClose();
        } catch (cause) {
            cue('error');
            setError(errorCopy(cause, { family, person: who }));
        } finally {
            setSaving(false);
        }
    }

    const help = organizer ? `ask ${organizer} to help` : 'contact support';

    return (
        <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
            <DialogContent className="sm:max-w-[520px]" data-family-check={member.email}>
                {stage === 'older' ? (
                    <>
                        <DialogHeader>
                            <DialogTitle>Help {who} finish joining</DialogTitle>
                            <DialogDescription>
                                {who} is using an older version of HushOS. Read these twelve words
                                to {who} so their phone can finish joining. This doesn’t check {who}{' '}
                                on your side; to do that, ask {who} to update HushOS, or compare{' '}
                                {who}’s own twelve words in Contacts.
                            </DialogDescription>
                        </DialogHeader>
                        {older.isPending ? (
                            <Pending />
                        ) : older.isError ? (
                            <Failed
                                error={errorCopy(older.error, { family })}
                                retry={() => void older.refetch()}
                            />
                        ) : (
                            <WordList words={older.data} label="Twelve words" kind="older-code" />
                        )}
                        <DialogFooter>
                            <Button onClick={onClose}>Done</Button>
                        </DialogFooter>
                    </>
                ) : (
                    <>
                        <DialogHeader>
                            <DialogTitle>Check it’s {who}</DialogTitle>
                            <DialogDescription>
                                {stage === 'mismatch'
                                    ? `These don’t match. Make sure you’re both in ${family}, reload, and compare again. If they still don’t match, ${help}.`
                                    : shown
                                      ? `Ask ${who} to open ${family} and choose Check it’s ${me} beside your name. If the twelve words on both screens match, you’ve checked each other.`
                                      : null}
                            </DialogDescription>
                        </DialogHeader>
                        {code.isPending && <Pending />}
                        {code.isError && (
                            <Failed
                                error={errorCopy(code.error, { family })}
                                retry={() => void code.refetch()}
                            />
                        )}
                        {code.data?.status === 'own-entry-wrong' && (
                            <p className="text-sm leading-snug" data-own-entry-wrong>
                                This device can’t check the family with {who}. You can check {who}’s
                                own twelve words instead.
                            </p>
                        )}
                        {code.data?.status === 'not-admitted' && (
                            <p className="text-sm leading-snug text-muted-foreground">
                                {who} isn’t in {family} on this device yet. Try again in a moment.
                            </p>
                        )}
                        {shown && stage === 'words' && (
                            <div className="flex flex-col gap-3">
                                <WordList
                                    words={shown.code}
                                    label="Twelve words"
                                    kind="pair-code"
                                />
                                <button
                                    type="button"
                                    onClick={() => setStage('older')}
                                    className="w-fit cursor-pointer text-[13px] font-semibold text-primary outline-hidden hover:underline focus-visible:underline"
                                >
                                    {who}’s screen asks for two missing words
                                </button>
                                <details className="group">
                                    <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-[13px] font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                                        Technical details
                                        <ChevronDownIcon
                                            aria-hidden="true"
                                            className="size-3.5 transition-transform group-open:rotate-180"
                                        />
                                    </summary>
                                    <p className="mt-2 text-[13px] text-muted-foreground">
                                        These words are worked out from the family’s member list as
                                        it was when {who} joined, and from your two accounts. When
                                        they match, your devices see the same family, and each
                                        confirms the other’s keys.
                                    </p>
                                    <dl className="mt-2 flex flex-col gap-1 text-[13px]">
                                        <div className="flex gap-2">
                                            <dt className="text-muted-foreground">
                                                Member list version
                                            </dt>
                                            <dd className="font-mono tabular-nums">
                                                {shown.rosterVersion}
                                            </dd>
                                        </div>
                                        {code.data && 'rosterDigest' in code.data && (
                                            <div className="flex flex-col">
                                                <dt className="text-muted-foreground">
                                                    Member list digest
                                                </dt>
                                                <dd className="font-mono break-all">
                                                    {code.data.rosterDigest}
                                                </dd>
                                            </div>
                                        )}
                                    </dl>
                                </details>
                            </div>
                        )}
                        {error && (
                            <p role="alert" className="text-[13px] text-destructive">
                                {error}
                            </p>
                        )}
                        {code.data?.status === 'own-entry-wrong' ? (
                            <DialogFooter>
                                <Button variant="outline" onClick={onClose}>
                                    Cancel
                                </Button>
                                <Button onClick={onCheckWords}>Check {who}’s words</Button>
                            </DialogFooter>
                        ) : stage === 'mismatch' || !shown ? (
                            <DialogFooter>
                                <Button onClick={onClose}>Done</Button>
                            </DialogFooter>
                        ) : (
                            <DialogFooter>
                                <Button
                                    variant="outline"
                                    disabled={saving}
                                    onClick={() => {
                                        cue('error');
                                        setStage('mismatch');
                                    }}
                                >
                                    They don’t match
                                </Button>
                                <Button disabled={saving} onClick={() => void theyMatch()}>
                                    {saving ? 'Saving' : 'They match'}
                                </Button>
                            </DialogFooter>
                        )}
                    </>
                )}
            </DialogContent>
        </Dialog>
    );
}

function Pending() {
    return (
        <output className="flex min-h-11 items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Getting the latest
        </output>
    );
}

function Failed({ error, retry }: { error: string; retry: () => void }) {
    return (
        <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-sm text-destructive">
                {error}
            </p>
            <Button variant="outline" onClick={retry}>
                <RotateCcwIcon />
                Try again
            </Button>
        </div>
    );
}

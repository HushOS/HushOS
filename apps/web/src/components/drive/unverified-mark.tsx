import type { DriveNode } from '@hushos/drive/client';
import type { Signer } from '@hushos/drive/api';
import { integrityIssues, signersFromPins, type IntegrityIssue } from '@hushos/drive/trust';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { ShieldAlertIcon, ShieldQuestionIcon } from 'lucide-react';
import { useState } from 'react';
import { AccountChangedDialog } from '@/components/drive/account-changed';
import { AddSomeone, firstName } from '@/components/drive/add-someone';
import { CheckContactDialog, requestCheck, type Checking } from '@/components/drive/check-contact';
import { useFamilyArea } from '@/components/drive/family-area';
import { TrustAsFamily } from '@/components/drive/trust-as-family';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { toast } from '@/components/ui/toast';
import { useAuthView } from '@/lib/auth-view';
import { settingsQueryOptions, type AccountChange } from '@/lib/contacts';
import { familyWord, pinName, pinOf, pinsById } from '@/lib/family-pin';
import {
    afterTrustChanged,
    checkSignerAgain,
    issueLines,
    markLabel,
    retryChecks,
    savedLine,
    type SignerNames,
} from '@/lib/integrity';
import { seenLine } from '@/lib/integrity-lines';

/*
 * Who this person can name as a writer: themselves, and their contacts,
 * verified or first-seen. Read from their own pins only; the server names a
 * writer by account id and nothing more. Loaded only where a mark shows.
 * Inside a family folder, the family's members as the server names them
 * come too, each with their address: the member list vouches for keys, not
 * names, and the words say so.
 */
export function useSignerNames(userId: string | null, enabled: boolean): SignerNames {
    const area = useFamilyArea();
    const settings = useQuery({
        ...settingsQueryOptions(userId ?? ''),
        enabled: enabled && userId !== null,
    });
    const contacts = settings.data?.settings.contacts;
    const checked = useQuery({
        queryKey: ['contacts', 'checked', userId, settings.dataUpdatedAt],
        queryFn: async () => {
            // One pin per person whatever case their id is in, their own check first.
            const pins = pinsById(contacts ?? {});
            const verified = await signersFromPins(
                Object.fromEntries([...pins.values()].map((pin) => [pin.userId, pin])),
            );
            // A pin taken on a family's word is named as that: the server's name, with the
            // address and the family beside it, never as someone whose words were compared.
            return Object.fromEntries(
                Object.keys(verified).map((id) => [
                    id.toLowerCase(),
                    pinName(pins.get(id.toLowerCase())!),
                ]),
            );
        },
        enabled: enabled && contacts !== undefined,
        staleTime: Infinity,
    });
    // The families whose word this person took for someone: a record vouched for that way says so.
    const vouchers: Record<string, string> = {};
    const vouched: NonNullable<SignerNames['vouched']> = {};
    for (const pin of pinsById(contacts ?? {}).values())
        if (pin.trustedVia) {
            vouchers[pin.trustedVia] = familyWord(pin)!;
            vouched[pin.userId.toLowerCase()] = {
                name: pin.name,
                email: pin.email,
                family: familyWord(pin)!,
            };
        }
    return {
        userId,
        checked: checked.data ?? {},
        vouchers,
        vouched,
        ...(area ? { family: { name: area.family, members: area.members } } : {}),
    };
}

/*
 * The neutral line in Info and the viewer for a copy saved from a link: who
 * saved it and that the original's writer is unknown. No mark, no warning
 * colour; nothing at all when the item carries a mark or was not saved.
 */
export function SavedFromLinkLine({
    node,
    className,
}: {
    node: Pick<DriveNode, 'metadataSigner' | 'currentVersion' | 'integrity'>;
    className?: string;
}) {
    const userId = useAuthView((state) => state.unlockedUserId);
    const saved =
        node.integrity?.metadata === 'saved-from-link' ||
        node.integrity?.version === 'saved-from-link';
    const names = useSignerNames(userId, saved);
    const text = saved ? savedLine(node, names) : null;
    if (!text) return null;
    return (
        <p data-integrity-saved className={cn('text-[13px] text-muted-foreground', className)}>
            {text}
        </p>
    );
}

/*
 * Info's "Added by" for an item whose writer this person's devices first saw
 * and nobody checked (docs/optional-verification.md 2.6, 6.4): their name,
 * then "Not verified" in muted text with Check it's Maya. No mark: nothing is
 * wrong, it just hasn't been checked. Null for anything else.
 */
export function useSeenBy(
    node: Pick<DriveNode, 'metadataSigner' | 'currentVersion' | 'integrity'>,
): { name: string; email: string | null } | null {
    const userId = useAuthView((state) => state.unlockedUserId);
    const area = useFamilyArea();
    const names = useSignerNames(userId, true);
    const settings = useQuery({
        ...settingsQueryOptions(userId ?? ''),
        enabled: userId !== null,
    });
    const seen = seenLine(node, names);
    if (!seen) return null;
    const pin = pinOf(settings.data?.settings.contacts ?? {}, seen.signer.id)?.pin;
    const member = area?.members[seen.signer.id.toLowerCase()];
    return { name: seen.name, email: pin?.email ?? member?.email ?? null };
}
export function SeenBy({ seen }: { seen: { name: string; email: string | null } }) {
    const userId = useAuthView((state) => state.unlockedUserId);
    const [checking, setChecking] = useState<Checking | null>(null);
    const email = seen.email;
    return (
        <span data-integrity-seen className="flex flex-col">
            <span>{seen.name}</span>
            <span className="text-[13px] text-muted-foreground">
                Not verified
                {email && userId && (
                    <>
                        {' '}
                        {/* The dot goes with the way to check, so a narrow column never strands it. */}
                        <span className="whitespace-nowrap">
                            ·{' '}
                            <Button
                                variant="link"
                                className="text-[13px] font-semibold"
                                onClick={() => setChecking({ email, name: seen.name })}
                            >
                                Check it’s {firstName(seen.name)}
                            </Button>
                        </span>
                    </>
                )}
            </span>
            {userId && (
                <CheckContactDialog
                    userId={userId}
                    person={checking}
                    onOpenChange={(open) => !open && setChecking(null)}
                />
            )}
        </span>
    );
}

/*
 * The mark on an item whose name or current version can't be confirmed
 * (docs/optional-verification.md 6.12): Unverified, or Couldn't check when the
 * check itself could not run (the trust set did not load, or the check
 * threw). A first-seen writer's records carry none. One small mark per item,
 * whatever failed; hover or a click says which case it is, calmly, naming the
 * writer only from this person's own pins, with the way out where there is
 * one: "Check who wrote this" for a writer nobody can name (their email, then
 * Check it's them), "Check it's Maya" for a contact whose account looks
 * different, "Check again" for a contact whose signature does not hold, "Try
 * again" for a check that did not run. Verified items, and anything with
 * nothing to check (a link visitor's view), show nothing. It warns; it never
 * stops the item opening. In a row or on a card it is a shield beside the
 * name (`variant="icon"`), so it never takes the name's room; Info and the
 * viewer, which have room, show the word.
 */
export function UnverifiedMark({
    node,
    issues: given,
    variant = 'badge',
    className,
}: {
    node?: Pick<DriveNode, 'name' | 'metadataSigner' | 'currentVersion' | 'integrity'>;
    /* For a record other than an item's current state, such as an earlier version. */
    issues?: IntegrityIssue[];
    variant?: 'badge' | 'icon';
    className?: string;
}) {
    const issues = given ?? (node ? integrityIssues(node) : []);
    const area = useFamilyArea();
    const queryClient = useQueryClient();
    const userId = useAuthView((state) => state.unlockedUserId);
    const names = useSignerNames(userId, issues.length > 0);
    const settings = useQuery({
        ...settingsQueryOptions(userId ?? ''),
        enabled: issues.length > 0 && userId !== null,
    });
    const [open, setOpen] = useState(false);
    // Who wrote it, for someone nobody can name yet: their email, then Check it's them.
    const [finding, setFinding] = useState<Signer | null>(null);
    const [checking, setChecking] = useState<Checking | null>(null);
    const [reviewing, setReviewing] = useState<AccountChange | null>(null);
    const [busy, setBusy] = useState(false);
    if (!issues.length) return null;
    const lines = issueLines(issues, names);
    const action = lines.find((entry) => entry.action)?.action ?? null;
    const worst = issues[0]!.integrity;
    const label = markLabel(issues);
    // A writer already in contacts is checked by their address; anyone else is found first.
    const contact =
        action?.kind === 'check'
            ? (pinOf(settings.data?.settings.contacts ?? {}, action.signer.id)?.pin ?? null)
            : null;

    async function again(signer: Signer, name: string) {
        if (!userId) return;
        setBusy(true);
        try {
            const outcome = await checkSignerAgain(queryClient, userId, signer);
            const first = firstName(name);
            if (outcome === 'followed')
                toast.add({ type: 'success', title: `${first} updated their account` });
            else if (outcome === 'changed') {
                const pin = pinOf(settings.data?.settings.contacts ?? {}, signer.id)?.pin;
                if (pin) setReviewing({ contactId: pin.userId, name: pin.name, email: pin.email });
            } else if (outcome === 'recheck')
                toast.add({
                    type: 'error',
                    title: `${first} needs to sign in to HushOS once more`,
                });
            else
                toast.add({
                    type: 'error',
                    title: `Nothing changed for ${first}`,
                    description: `HushOS still couldn’t confirm this was written by ${first}.`,
                });
        } catch (cause) {
            toast.add({
                type: 'error',
                title: 'Couldn’t check again',
                description: cause instanceof Error ? cause.message : undefined,
            });
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Popover open={open} onOpenChange={setOpen}>
                <PopoverTrigger
                    openOnHover
                    delay={150}
                    data-integrity={worst}
                    aria-label={`${label}: ${lines.map((entry) => entry.text).join(' ')}`}
                    onClick={(event) => {
                        // A click keeps it open; hover already opened it, so the default would shut it.
                        event.stopPropagation();
                        event.preventBaseUIHandler();
                        setOpen(true);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    className={cn(
                        variant === 'icon'
                            ? 'relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-warning outline-none transition-colors after:absolute after:-inset-2.5 hover:bg-warning-soft focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring data-popup-open:bg-warning-soft'
                            : 'eyebrow inline-flex h-5 shrink-0 cursor-pointer items-center rounded-xs border border-transparent bg-warning-soft px-1.5 whitespace-nowrap text-warning outline-none transition-colors hover:border-warning/40 focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-ring data-popup-open:border-warning/40',
                        className,
                    )}
                >
                    {variant === 'icon' ? (
                        worst === 'unchecked' ? (
                            <ShieldQuestionIcon aria-hidden="true" className="size-4" />
                        ) : (
                            <ShieldAlertIcon aria-hidden="true" className="size-4" />
                        )
                    ) : (
                        label
                    )}
                </PopoverTrigger>
                <PopoverContent
                    className="flex w-72 flex-col gap-2 p-3"
                    data-integrity-details
                    onClick={(event) => event.stopPropagation()}
                >
                    <p className="text-sm font-semibold">{label}</p>
                    {lines.map((entry) => (
                        <p key={entry.text} className="text-[13px] leading-snug">
                            {entry.text}
                        </p>
                    ))}
                    {action && userId && (
                        <Button
                            variant="outline"
                            className="mt-1 self-start"
                            disabled={busy}
                            onClick={(event) => {
                                event.stopPropagation();
                                setOpen(false);
                                if (action.kind === 'check') {
                                    if (contact)
                                        setChecking({ email: contact.email, name: contact.name });
                                    else setFinding(action.signer);
                                } else if (action.kind === 'again')
                                    void again(action.signer, action.name);
                                else void retryChecks(queryClient, userId);
                            }}
                        >
                            {action.kind === 'check'
                                ? contact
                                    ? `Check it’s ${firstName(contact.name)}`
                                    : 'Check who wrote this'
                                : action.kind === 'again'
                                  ? busy
                                      ? 'Checking…'
                                      : 'Check again'
                                  : 'Try again'}
                        </Button>
                    )}
                    {/*
                     * Outside a family's folders, a writer nobody checked who is in one of this
                     * person's families: their pin can be taken on the family's word, as an
                     * explicit act (design 2.8).
                     */}
                    {!area && userId && action?.kind === 'check' && worst === 'unknown-signer' && (
                        <TrustAsFamily userId={userId} signer={action.signer} open={open} />
                    )}
                </PopoverContent>
            </Popover>
            {userId && (
                <>
                    <Dialog
                        open={finding !== null}
                        onOpenChange={(next) => !next && setFinding(null)}
                    >
                        <DialogContent
                            className="sm:max-w-[480px]"
                            onClick={(event) => event.stopPropagation()}
                        >
                            <DialogHeader>
                                <DialogTitle>Check who wrote this</DialogTitle>
                                <DialogDescription>
                                    Enter the email they use for HushOS. Once they’re in your
                                    contacts, what they add and change shows as theirs.
                                </DialogDescription>
                            </DialogHeader>
                            {finding && (
                                <AddSomeone
                                    userId={userId}
                                    writer={finding.id}
                                    onCancel={() => setFinding(null)}
                                    onAdded={(pin) => {
                                        setFinding(null);
                                        toast.add({
                                            type: 'success',
                                            title: `${firstName(pin.name)} added`,
                                        });
                                        // Then, if they like, the words: the advanced door. Hosted by
                                        // the shell, since this mark clears now that they're added.
                                        requestCheck({ email: pin.email, name: pin.name });
                                    }}
                                    onChanged={(change) => {
                                        setFinding(null);
                                        setReviewing(change);
                                    }}
                                />
                            )}
                        </DialogContent>
                    </Dialog>
                    <CheckContactDialog
                        userId={userId}
                        person={checking}
                        onOpenChange={(next) => !next && setChecking(null)}
                        onChecked={() => afterTrustChanged(queryClient)}
                    />
                    <AccountChangedDialog
                        userId={userId}
                        change={reviewing}
                        onOpenChange={(next) => !next && setReviewing(null)}
                    />
                </>
            )}
        </>
    );
}

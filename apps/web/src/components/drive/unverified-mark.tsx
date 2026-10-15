import type { DriveNode } from '@hushos/drive/client';
import type { Signer } from '@hushos/drive/api';
import { integrityIssues, signersFromPins, type IntegrityIssue } from '@hushos/drive/trust';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { ShieldAlertIcon, ShieldQuestionIcon } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { CheckContact } from '@/components/drive/check-contact';
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
import { authClient } from '@/lib/auth-client';
import { settingsQueryOptions } from '@/lib/contacts';
import {
    afterTrustChanged,
    checkSignerAgain,
    issueLines,
    markLabel,
    retryChecks,
    savedLine,
    type SignerNames,
} from '@/lib/integrity';

/*
 * Who this person can name as a writer: themselves, and the contacts whose
 * words they checked. Read from their own pins only; the server names a
 * writer by account id and nothing more. Loaded only where a mark shows.
 */
export function useSignerNames(userId: string | null, enabled: boolean): SignerNames {
    const settings = useQuery({
        ...settingsQueryOptions(userId ?? ''),
        enabled: enabled && userId !== null,
    });
    const contacts = settings.data?.settings.contacts;
    const checked = useQuery({
        queryKey: ['contacts', 'checked', userId, settings.dataUpdatedAt],
        queryFn: async () => {
            const verified = await signersFromPins(contacts ?? {});
            return Object.fromEntries(
                Object.keys(verified).map((id) => [id.toLowerCase(), contacts![id]!.name]),
            );
        },
        enabled: enabled && contacts !== undefined,
        staleTime: Infinity,
    });
    return { userId, checked: checked.data ?? {} };
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
    const userId = useStore(authClient.store, (state) => state.unlockedUserId);
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
 * The mark on an item whose name or current version this person cannot tie
 * to someone they checked: Unverified, or Couldn't check when the check
 * itself could not run (the trust set did not load, or the check threw). One
 * small mark per item, whatever failed; hover or a click says which case it
 * is, naming the writer only from this person's own pins, with the way out
 * where there is one: "Check their words" for a writer nobody checked,
 * "Check again" for a checked contact whose signature does not hold, "Try
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
    const queryClient = useQueryClient();
    const userId = useStore(authClient.store, (state) => state.unlockedUserId);
    const names = useSignerNames(userId, issues.length > 0);
    const [open, setOpen] = useState(false);
    const [checking, setChecking] = useState<Signer | null>(null);
    const [busy, setBusy] = useState(false);
    if (!issues.length) return null;
    const lines = issueLines(issues, names);
    const action = lines.find((entry) => entry.action)?.action ?? null;
    const worst = issues[0]!.integrity;
    const label = markLabel(issues);

    async function again(signer: Signer, name: string) {
        if (!userId) return;
        setBusy(true);
        try {
            const outcome = await checkSignerAgain(queryClient, userId, signer);
            if (outcome === 'followed')
                toast.add({
                    type: 'success',
                    title: `${name} replaced their sharing keys`,
                    description:
                        'The change is signed by their previous keys. Compare words in People you share with to be sure.',
                });
            else if (outcome === 'recheck')
                toast.add({
                    type: 'error',
                    title: `${name}’s keys were upgraded`,
                    description: 'Compare words with them again in People you share with.',
                });
            else if (outcome === 'changed')
                toast.add({
                    type: 'error',
                    title: `${name}’s keys have changed`,
                    description: 'Check it’s them in People you share with.',
                });
            else
                toast.add({
                    type: 'error',
                    title: `${name}’s keys haven’t changed`,
                    description: 'The signature doesn’t match them. Don’t trust this item.',
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
                            ? 'relative inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-warning outline-none transition-colors after:absolute after:-inset-2.5 hover:bg-warning-soft focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-popup-open:bg-warning-soft'
                            : 'eyebrow inline-flex h-5 shrink-0 cursor-pointer items-center rounded-xs border border-transparent bg-warning-soft px-1.5 whitespace-nowrap text-warning outline-none transition-colors hover:border-warning/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring data-popup-open:border-warning/40',
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
                            size="sm"
                            variant="outline"
                            className="mt-1 self-start"
                            disabled={busy}
                            onClick={(event) => {
                                event.stopPropagation();
                                if (action.kind === 'check') {
                                    setOpen(false);
                                    setChecking(action.signer);
                                } else if (action.kind === 'again')
                                    void again(action.signer, action.name);
                                else void retryChecks(queryClient, userId);
                            }}
                        >
                            {action.kind === 'check'
                                ? 'Check their words'
                                : action.kind === 'again'
                                  ? busy
                                      ? 'Checking…'
                                      : 'Check again'
                                  : 'Try again'}
                        </Button>
                    )}
                </PopoverContent>
            </Popover>
            {userId && (
                <Dialog
                    open={checking !== null}
                    onOpenChange={(next) => !next && setChecking(null)}
                >
                    <DialogContent
                        className="sm:max-w-[480px]"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <DialogHeader>
                            <DialogTitle>Check who wrote this</DialogTitle>
                            <DialogDescription>
                                Enter the email they use for HushOS. Once their words match, what
                                they add and change shows as verified.
                            </DialogDescription>
                        </DialogHeader>
                        {checking && (
                            <CheckContact
                                userId={userId}
                                writer={checking.id}
                                onCancel={() => setChecking(null)}
                                onAdded={(pin) => {
                                    setChecking(null);
                                    afterTrustChanged(queryClient);
                                    toast.add({ type: 'success', title: `${pin.name} checked` });
                                }}
                            />
                        )}
                    </DialogContent>
                </Dialog>
            )}
        </>
    );
}

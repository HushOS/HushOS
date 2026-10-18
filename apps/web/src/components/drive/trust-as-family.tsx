import type { Signer } from '@hushos/drive/api';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { capabilitiesQueryOptions } from '@/lib/families-shell';

/*
 * "Trust as Lindqvist family does", in the Unverified popover of an item
 * outside a family's folders (design 2.8, F12): a writer nobody checked who
 * is active in one of this person's families gets a pin written from the
 * family's member list, marked as the family's word (`trustedVia`). Only on
 * a server that serves families, and the families layer loads only once the
 * popover is open: a page full of marks asks nothing until then.
 */
export function TrustAsFamily({
    userId,
    signer,
    open,
}: {
    userId: string;
    signer: Signer;
    open: boolean;
}) {
    const queryClient = useQueryClient();
    const [busy, setBusy] = useState(false);
    const capabilities = useQuery({ ...capabilitiesQueryOptions, enabled: open });
    const vouching = useQuery({
        queryKey: ['families', userId, 'vouching', signer.id.toLowerCase()],
        queryFn: async () => (await import('@/lib/trust-as')).familyVouching(userId, signer.id),
        enabled: open && capabilities.data?.groups === true,
        staleTime: 5 * 60_000,
        retry: false,
    });
    const found = vouching.data;
    if (!found) return null;

    async function trust() {
        if (!found) return;
        setBusy(true);
        try {
            const { trustAsFamily } = await import('@/lib/trust-as');
            await trustAsFamily(queryClient, userId, found);
            toast.add({
                type: 'success',
                title: `${found.name} (${found.email}) is trusted as ${found.family} does`,
                description: `${found.family} vouches for these keys. Compare words with them in People you share with to check it yourself.`,
            });
        } catch (cause) {
            toast.add({
                type: 'error',
                title: 'Couldn’t trust them',
                description: cause instanceof Error ? cause.message : undefined,
            });
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="mt-1 flex flex-col gap-1.5 border-t border-rule pt-2" data-trust-as>
            <p className="text-[13px] leading-snug text-muted-foreground">
                In {found.family}: {found.name} ({found.email})
            </p>
            <Button
                variant="outline"
                className="self-start"
                disabled={busy}
                onClick={(event) => {
                    event.stopPropagation();
                    void trust();
                }}
            >
                {busy ? 'Trusting…' : `Trust as ${found.family} does`}
            </Button>
        </div>
    );
}

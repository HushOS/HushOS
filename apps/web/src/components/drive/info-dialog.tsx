import type { DriveNode } from '@hushos/drive/client';
import { ContactFlow, ContactFlowProvider, useFlowInPlace } from '@/components/drive/contact-flow';
import { ItemDetails, type ItemDetailsProps } from '@/components/drive/details-panel';
import { useAuthView } from '@/lib/auth-view';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';

/*
 * An item's details on a screen too narrow for the panel beside the list:
 * the same content, in a dialog. Check it's Maya and the rest of the contact
 * flow, from the Added by line or a mark, take this dialog's place rather
 * than open over it, and closing them comes back to Info.
 */
export function InfoDialog({
    node,
    open,
    onOpenChange,
    ...details
}: Omit<ItemDetailsProps, 'node' | 'heading'> & {
    node: DriveNode | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const userId = useAuthView((state) => state.unlockedUserId);
    const inPlace = useFlowInPlace();
    const flow = userId ? inPlace.flow : null;
    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next && flow) inPlace.back();
                else {
                    inPlace.back();
                    onOpenChange(next);
                }
            }}
        >
            <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-[520px]">
                {flow && userId ? (
                    <ContactFlow
                        userId={userId}
                        start={flow.start}
                        onDone={inPlace.back}
                        onResolved={flow.onResolved}
                    />
                ) : (
                    <ContactFlowProvider open={inPlace.open}>
                        <InfoBody node={node} details={details} onOpenChange={onOpenChange} />
                    </ContactFlowProvider>
                )}
            </DialogContent>
        </Dialog>
    );
}

function InfoBody({
    node,
    details,
    onOpenChange,
}: {
    node: DriveNode | null;
    details: Omit<ItemDetailsProps, 'node' | 'heading'>;
    onOpenChange: (open: boolean) => void;
}) {
    return (
        <>
            {node && (
                <ItemDetails
                    node={node}
                    nameFirst
                    heading={(name) => (
                        <DialogHeader>
                            {/* Info, then the name, as the panel beside the list reads; the close
                                    button shares Info's row, so the name has the full width. */}
                            <p className="text-sm font-semibold text-muted-foreground">Info</p>
                            <DialogTitle className="wrap-anywhere">{name}</DialogTitle>
                            <DialogDescription className="sr-only">
                                About this {node.kind === 'folder' ? 'folder' : 'file'}.
                            </DialogDescription>
                        </DialogHeader>
                    )}
                    {...details}
                />
            )}
            <DialogFooter>
                <Button variant="outline" onClick={() => onOpenChange(false)}>
                    Done
                </Button>
            </DialogFooter>
        </>
    );
}

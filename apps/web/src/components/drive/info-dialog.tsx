import type { DriveNode } from '@hushos/drive/client';
import { ItemDetails, type ItemDetailsProps } from '@/components/drive/details-panel';
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
 * the same content, in a dialog.
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
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-[520px]">
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
            </DialogContent>
        </Dialog>
    );
}

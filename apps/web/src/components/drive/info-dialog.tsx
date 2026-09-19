import type { DriveNode } from '@hushos/drive/client';
import { ItemDetails, type ItemDetailsProps } from '@/components/drive/details-panel';
import {
    Dialog,
    DialogContent,
    DialogDescription,
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
            <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-md">
                {node && (
                    <ItemDetails
                        node={node}
                        heading={(name) => (
                            <DialogHeader>
                                <DialogTitle className="wrap-anywhere">{name}</DialogTitle>
                                <DialogDescription>
                                    {node.kind === 'folder'
                                        ? 'What the app knows about this folder, and the key that protects it.'
                                        : 'What the app knows about this file, and the keys that protect it.'}
                                </DialogDescription>
                            </DialogHeader>
                        )}
                        {...details}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

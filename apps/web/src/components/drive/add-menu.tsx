import { FileUpIcon, FolderPlusIcon, FolderUpIcon, PlusIcon } from 'lucide-react';
import type { RefObject } from 'react';
import { keyLabel } from '@/components/drive/shortcuts';
import type { UploadPicker } from '@/components/drive/upload-controls';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuShortcut,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

/* Add, on a folder's title row and on Home's: a new folder, files or a whole folder, into one place. */
export function AddMenu({
    picker,
    onNewFolder,
}: {
    picker: RefObject<UploadPicker | null>;
    /* Null while New folder can't be used here (a family folder a key change has not reached). */
    onNewFolder: (() => void) | null;
}) {
    return (
        <DropdownMenu>
            {/* Only the + on a phone: a square, 36px and 44px to a finger. */}
            <DropdownMenuTrigger
                render={<Button className="max-sm:w-9 max-sm:px-0 max-sm:pointer-coarse:w-11" />}
            >
                <PlusIcon strokeWidth={2.4} />
                <span className="max-sm:sr-only">Add</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-56">
                <DropdownMenuItem disabled={!onNewFolder} onClick={() => onNewFolder?.()}>
                    <FolderPlusIcon aria-hidden="true" />
                    New folder
                    <DropdownMenuShortcut>{keyLabel('Shift')}N</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => picker.current?.pickFiles()}>
                    <FileUpIcon aria-hidden="true" />
                    Upload files
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => picker.current?.pickFolder()}>
                    <FolderUpIcon aria-hidden="true" />
                    Upload folder
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

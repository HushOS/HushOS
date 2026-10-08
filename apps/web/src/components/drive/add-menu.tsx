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
    onNewFolder: () => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger render={<Button className="pr-4.5 pl-3.5 max-sm:px-3" />}>
                <PlusIcon strokeWidth={2.4} />
                <span className="max-sm:sr-only">Add</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-56">
                <DropdownMenuItem onClick={onNewFolder}>
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

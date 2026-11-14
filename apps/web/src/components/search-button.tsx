import { cn } from 'cn';
import { SearchIcon } from 'lucide-react';
import { Kbd } from '@/components/drive/kbd';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { setPaletteOpen } from '@/lib/palette';

/*
 * Search, as an icon: it opens the command palette, as `/` and ⌘K do. On a desk it sits on the
 * brand's line in the sidebar; below that, in the page's compact top bar. Its tooltip names it
 * and its shortcut.
 */
export function SearchButton({
    side = 'bottom',
    className,
}: {
    side?: 'bottom' | 'right';
    className?: string;
}) {
    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <Button
                        variant="ghost"
                        size="icon"
                        aria-label="Search"
                        aria-keyshortcuts="/ Meta+K Control+K"
                        className={cn('text-muted-foreground hover:text-foreground', className)}
                    />
                }
                onClick={() => setPaletteOpen(true)}
            >
                <SearchIcon aria-hidden="true" className="size-[18px]" />
            </TooltipTrigger>
            <TooltipContent side={side}>
                Search
                <Kbd>/</Kbd>
            </TooltipContent>
        </Tooltip>
    );
}

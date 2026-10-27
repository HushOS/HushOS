import { cn } from 'cn';
import { ArrowUpRightIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Breakdown } from '@/dev/breakdown';

/*
 * The two alignment rules the app follows, as breakdowns: they show the rule and keep it
 * honest, since Measure reads the real rendering.
 */

const ITEMS = ['Itinerary.pdf', 'Budget.xlsx', 'Tickets'];

/*
 * A selected row inside a column. Box: the tint sits on the column's edge, so its words are
 * inset 12px from the heading's. Text: the tint hangs 12px outside the column and the
 * words line up with the heading, as the app's rows and menus do.
 */
export function AlignTextBreakdown() {
    return (
        <Breakdown
            id="align-text"
            title="Align the text, not the box"
            note="A tint is decoration; the words are what the eye lines up. Let the tint hang outside the column so the row's text sits on the heading's edge."
            options={[
                { value: 'box', label: 'Box' },
                { value: 'text', label: 'Text' },
            ]}
            mode="align"
        >
            {(version) => (
                <div className="w-72 rounded-xl border border-rule bg-card px-8 py-7 text-foreground shadow-sm sm:w-80">
                    <h3 data-measure-heading="" className="w-fit text-[17px] font-bold">
                        Lisbon 2026
                    </h3>
                    <p className="mt-1 text-[13px] text-muted-foreground">
                        3 items · Shared with Sam
                    </p>
                    <ul className="mt-4 flex flex-col gap-1 text-[15px] font-medium">
                        {ITEMS.map((item) => (
                            <li
                                key={item}
                                data-measure={item === 'Budget.xlsx' ? '' : undefined}
                                className={cn(
                                    'rounded-md px-3 py-2 transition-[margin] duration-500 ease-out-expo motion-reduce:transition-none',
                                    item === 'Budget.xlsx' && 'bg-accent text-accent-foreground',
                                    version === 'text' ? '-mx-3' : 'mx-0',
                                )}
                            >
                                {item}
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </Breakdown>
    );
}

/*
 * A trailing arrow, drawn twice life size. Geometric: the same 14px each side, but the
 * arrow's strokes sit about 4.5px inside its 16px box, so the right reads wider. Optical:
 * 4px less on the right, and both sides measure the same from what you see.
 */
export function OpticalNudgeBreakdown() {
    return (
        <Breakdown
            id="optical-nudge"
            title="Optical nudge"
            note="Equal padding isn't equal space: an icon's strokes sit inside its box. Measure from what's drawn, then take the difference off the icon's side."
            options={[
                { value: 'geometric', label: 'Geometric' },
                { value: 'optical', label: 'Optical' },
            ]}
            mode="padding"
            scale={2}
        >
            {(version) => (
                <div className="flex h-24 items-center justify-center">
                    <Button
                        data-measure=""
                        variant="outline"
                        className={cn(
                            'scale-200 transition-[color,background-color,border-color,transform,padding] duration-500 ease-out-expo motion-reduce:transition-none',
                            version === 'optical' && 'pr-2.5',
                        )}
                    >
                        Open
                        <ArrowUpRightIcon />
                    </Button>
                </div>
            )}
        </Breakdown>
    );
}

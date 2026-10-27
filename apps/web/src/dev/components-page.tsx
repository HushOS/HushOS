import type { ComponentType } from 'react';

import {
    FamilyGlanceDemo,
    FileRowsDemo,
    PageHeaderDemo,
    PeopleDemo,
    SettingsDemo,
} from '@/dev/demos/app';
import {
    BadgeDemo,
    ButtonDemo,
    ChoiceDemo,
    FieldDemo,
    InputDemo,
    ProgressDemo,
    SelectDemo,
} from '@/dev/demos/controls';
import { AlignTextBreakdown, OpticalNudgeBreakdown } from '@/dev/demos/breakdowns';
import { MotionDemo } from '@/dev/demos/motion';
import {
    CommandDemo,
    DialogDemo,
    MenuDemo,
    PopoverDemo,
    SheetDemo,
    ToastDemo,
} from '@/dev/demos/overlays';
import {
    AccordionDemo,
    AlertDemo,
    BreadcrumbDemo,
    CardDemo,
    ScrollAreaDemo,
    SidebarDemo,
} from '@/dev/demos/structure';

/*
 * Every demo, in page order. To add a component, write a `Demo` for it in demos/ and put
 * it here; the index at the top follows this list.
 */
const DEMOS: { id: string; title: string; Demo: ComponentType }[] = [
    { id: 'align-text', title: 'Align the text, not the box', Demo: AlignTextBreakdown },
    { id: 'optical-nudge', title: 'Optical nudge', Demo: OpticalNudgeBreakdown },
    { id: 'button', title: 'Button', Demo: ButtonDemo },
    { id: 'badge', title: 'Badge', Demo: BadgeDemo },
    { id: 'input', title: 'Input and textarea', Demo: InputDemo },
    { id: 'select', title: 'Select', Demo: SelectDemo },
    { id: 'choices', title: 'Checkbox, switch and radio', Demo: ChoiceDemo },
    { id: 'field', title: 'Field and label', Demo: FieldDemo },
    { id: 'progress', title: 'Progress, skeleton and separator', Demo: ProgressDemo },
    { id: 'alert', title: 'Alert', Demo: AlertDemo },
    { id: 'card', title: 'Card', Demo: CardDemo },
    { id: 'accordion', title: 'Accordion', Demo: AccordionDemo },
    { id: 'breadcrumb', title: 'Breadcrumb', Demo: BreadcrumbDemo },
    { id: 'scroll-area', title: 'Scroll area', Demo: ScrollAreaDemo },
    { id: 'sidebar', title: 'Sidebar', Demo: SidebarDemo },
    { id: 'dialog', title: 'Dialog and alert dialog', Demo: DialogDemo },
    { id: 'sheet', title: 'Sheet', Demo: SheetDemo },
    { id: 'menu', title: 'Dropdown and context menu', Demo: MenuDemo },
    { id: 'popover', title: 'Popover and tooltip', Demo: PopoverDemo },
    { id: 'command', title: 'Command palette', Demo: CommandDemo },
    { id: 'toast', title: 'Toast', Demo: ToastDemo },
    { id: 'motion', title: 'Motion', Demo: MotionDemo },
    { id: 'page-header', title: 'Page header', Demo: PageHeaderDemo },
    { id: 'file-rows', title: 'File list rows', Demo: FileRowsDemo },
    { id: 'people', title: 'Avatars and who can open', Demo: PeopleDemo },
    { id: 'settings', title: 'Settings rows and storage', Demo: SettingsDemo },
    { id: 'family-glance', title: 'Family plan glance', Demo: FamilyGlanceDemo },
];

export function ComponentsPage() {
    return (
        <>
            <nav aria-label="Components" className="border-b border-rule px-5 py-4 sm:px-8">
                <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                    {DEMOS.map((demo) => (
                        <li key={demo.id}>
                            <a href={`#${demo.id}`} className="text-link">
                                {demo.title}
                            </a>
                        </li>
                    ))}
                </ul>
            </nav>
            {DEMOS.map(({ id, Demo }) => (
                <Demo key={id} />
            ))}
        </>
    );
}

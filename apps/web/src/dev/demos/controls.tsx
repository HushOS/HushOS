import { useDialKit } from 'dialkit';
import {
    ArrowRightIcon,
    ArrowUpRightIcon,
    CheckIcon,
    ChevronDownIcon,
    DownloadIcon,
    PlusIcon,
    Settings2Icon,
    UploadIcon,
} from 'lucide-react';
import { useId, useState, type CSSProperties } from 'react';

import { Spinner } from '@/components/motion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress, ProgressLabel, ProgressValue } from '@/components/ui/progress';
import { RadioGroup, RadioItem } from '@/components/ui/radio-group';
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Demo, Row, Sample, States, pxs } from '@/dev/demo';

/* An icon's tuned size and offset; a trailing icon also takes the optical nudge. */
function iconStyle(size: number, offsetY: number, nudgeX = 0): CSSProperties {
    return { width: size, height: size, transform: `translate(${nudgeX}px, ${offsetY}px)` };
}

const VARIANTS = [
    'default',
    'secondary',
    'outline',
    'ghost',
    'destructive',
    'destructive-outline',
    'link',
] as const;
const SIZES = ['xs', 'sm', 'default', 'lg'] as const;
const ICON_SIZES = ['icon-xs', 'icon-sm', 'icon', 'icon-lg'] as const;

export function ButtonDemo() {
    const dial = useDialKit(
        'Button',
        {
            height: [36, 24, 56],
            paddingX: [14, 0, 32],
            radius: [10, 0, 24, 1],
            gap: [8, 0, 20],
            icon: {
                size: [16, 10, 24],
                offsetY: [0, -3, 3, 0.5],
                trailingNudge: [0, -4, 4, 0.5],
            },
        },
        { id: 'button' },
    );
    const tuned: CSSProperties = {
        height: dial.height,
        paddingInline: pxs(dial.paddingX),
        borderRadius: dial.radius,
        gap: dial.gap,
    };
    const leading = iconStyle(dial.icon.size, dial.icon.offsetY);
    const trailing = iconStyle(dial.icon.size, dial.icon.offsetY, dial.icon.trailingNudge);
    return (
        <Demo
            id="button"
            title="Button"
            note="36px, 44px on touch. One blue button per screen; a row ends on it. The tuned row follows the Button panel and is the one Measure draws."
        >
            <Row label="Tuned">
                <Button data-measure="" style={tuned}>
                    <UploadIcon style={leading} />
                    Upload
                </Button>
                <Button data-measure="" variant="outline" style={tuned}>
                    Open
                    <ArrowUpRightIcon style={trailing} />
                </Button>
                <Button data-measure="" variant="ghost" style={tuned}>
                    More
                    <ChevronDownIcon style={trailing} />
                </Button>
                <Button data-measure="" variant="secondary" style={tuned}>
                    <PlusIcon style={leading} />
                    New folder
                </Button>
            </Row>
            {VARIANTS.map((variant) => (
                <Row key={variant} label={variant}>
                    {SIZES.map((size) => (
                        <Sample key={size} caption={size}>
                            <Button variant={variant} size={size}>
                                <DownloadIcon />
                                Download
                            </Button>
                        </Sample>
                    ))}
                    {variant !== 'link' &&
                        ICON_SIZES.map((size) => (
                            <Sample key={size} caption={size}>
                                <Button variant={variant} size={size} aria-label="Settings">
                                    <Settings2Icon />
                                </Button>
                            </Sample>
                        ))}
                </Row>
            ))}
            <Row label="row">
                <div className="w-full max-w-md rounded-xl border border-rule">
                    <Button variant="row" size="row">
                        Plan and storage
                        <ArrowRightIcon />
                    </Button>
                </div>
            </Row>
            <States states={['rest', 'hover', 'focus', 'disabled', 'busy']}>
                {({ state, ...props }) => (
                    <Button {...props}>
                        {state === 'busy' ? <Spinner /> : <UploadIcon />}
                        {state === 'busy' ? 'Uploading…' : 'Upload'}
                    </Button>
                )}
            </States>
            <States states={['rest', 'hover', 'focus', 'disabled', 'busy']}>
                {({ state, ...props }) => (
                    <Button variant="outline" {...props}>
                        {state === 'busy' ? 'Opening…' : 'Open'}
                        {state === 'busy' ? <Spinner /> : <ArrowUpRightIcon />}
                    </Button>
                )}
            </States>
        </Demo>
    );
}

const BADGES = ['default', 'secondary', 'outline', 'success', 'warning', 'destructive'] as const;

export function BadgeDemo() {
    const dial = useDialKit(
        'Badge',
        {
            height: [22, 16, 32],
            paddingX: [8, 0, 16],
            radius: [6, 0, 12],
            gap: [6, 0, 12],
            icon: { size: [12, 8, 16], offsetY: [0, -2, 2, 0.5] },
        },
        { id: 'badge', defaultCollapsed: true },
    );
    const tuned: CSSProperties = {
        height: dial.height,
        paddingInline: pxs(dial.paddingX),
        borderRadius: dial.radius,
        gap: dial.gap,
    };
    return (
        <Demo
            id="badge"
            title="Badge"
            note="Label size in sentence case. A state is its colour and a word."
        >
            <Row label="Variants">
                {BADGES.map((variant) => (
                    <Sample key={variant} caption={variant}>
                        <Badge variant={variant}>Shared</Badge>
                    </Sample>
                ))}
            </Row>
            <Row label="Tuned, with an icon">
                {BADGES.map((variant) => (
                    <Badge key={variant} variant={variant} style={tuned}>
                        {/* Wrapped: the badge sizes its own svg children with !important. */}
                        <span className="flex">
                            <CheckIcon style={iconStyle(dial.icon.size, dial.icon.offsetY)} />
                        </span>
                        Checked
                    </Badge>
                ))}
            </Row>
        </Demo>
    );
}

export function InputDemo() {
    const dial = useDialKit(
        'Input',
        {
            height: [44, 32, 56],
            paddingX: [14, 0, 24],
            radius: [10, 0, 20],
            fontSize: [14, 12, 17],
        },
        { id: 'input', defaultCollapsed: true },
    );
    const tuned: CSSProperties = {
        height: dial.height,
        paddingInline: pxs(dial.paddingX),
        borderRadius: dial.radius,
        fontSize: dial.fontSize,
    };
    return (
        <Demo
            id="input"
            title="Input and textarea"
            note="44px, the field edge, a 2px inset ring on focus, danger edge and ring when invalid. 16px text on phones."
        >
            <Row label="Tuned">
                <div className="w-full max-w-sm">
                    <Input placeholder="Folder name" style={tuned} />
                </div>
            </Row>
            <States states={['rest', 'hover', 'focus', 'disabled', 'invalid']}>
                {({ state, ...props }) => (
                    <Input
                        className="w-48"
                        defaultValue={state === 'rest' ? '' : 'Lisbon 2026'}
                        placeholder="Folder name"
                        {...props}
                    />
                )}
            </States>
            <States states={['rest', 'hover', 'focus', 'disabled', 'invalid']}>
                {({ state, ...props }) => (
                    <Textarea
                        className="w-48"
                        defaultValue={state === 'rest' ? '' : 'It shows someone else’s photos.'}
                        placeholder="What’s wrong with it?"
                        {...props}
                    />
                )}
            </States>
        </Demo>
    );
}

export function SelectDemo() {
    const [value, setValue] = useState<string | null>('view');
    const items = [
        { value: 'view', label: 'Can view' },
        { value: 'edit', label: 'Can edit' },
    ];
    return (
        <Demo
            id="select"
            title="Select"
            note="The role select in Share; a native-looking trigger that opens a menu."
        >
            <Row label="Open it">
                <div className="w-56">
                    <Select value={value} onValueChange={setValue} items={items}>
                        <SelectTrigger aria-label="Role">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {items.map((item) => (
                                <SelectItem key={item.value} value={item.value}>
                                    {item.label}
                                </SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                </div>
            </Row>
            <States states={['rest', 'hover', 'focus', 'disabled', 'invalid']}>
                {({ state, disabled, ...props }) => (
                    <div className="w-40">
                        <Select defaultValue="view" items={items} disabled={disabled}>
                            <SelectTrigger aria-label={`Role, ${state}`} {...props}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {items.map((item) => (
                                    <SelectItem key={item.value} value={item.value}>
                                        {item.label}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                )}
            </States>
        </Demo>
    );
}

export function ChoiceDemo() {
    return (
        <Demo
            id="choices"
            title="Checkbox, switch and radio"
            note="Checkbox 18px. A switch for a setting that applies at once; radios for one of a few."
        >
            <Row label="Checkbox">
                <Sample caption="Off">
                    <Checkbox aria-label="Off" />
                </Sample>
                <Sample caption="On">
                    <Checkbox aria-label="On" defaultChecked />
                </Sample>
                <Sample caption="Some">
                    <Checkbox aria-label="Some" indeterminate />
                </Sample>
            </Row>
            <States states={['rest', 'hover', 'focus', 'disabled', 'invalid']}>
                {({ state, ...props }) => (
                    <Checkbox aria-label={state} defaultChecked={state === 'focus'} {...props} />
                )}
            </States>
            <Row label="Switch">
                {(['default', 'sm'] as const).map((size) => (
                    <Sample key={size} caption={`${size}, off and on`}>
                        <span className="flex gap-4">
                            <Switch size={size} aria-label={`${size} off`} />
                            <Switch size={size} aria-label={`${size} on`} defaultChecked />
                        </span>
                    </Sample>
                ))}
            </Row>
            <States states={['rest', 'hover', 'focus', 'disabled', 'invalid']}>
                {({ state, ...props }) => <Switch aria-label={state} defaultChecked {...props} />}
            </States>
            <Row label="Radio">
                <RadioGroup defaultValue="month" aria-label="Billing">
                    <RadioItem value="month">Monthly</RadioItem>
                    <RadioItem value="year">Yearly</RadioItem>
                    <RadioItem value="never" disabled>
                        Disabled
                    </RadioItem>
                </RadioGroup>
            </Row>
        </Demo>
    );
}

export function FieldDemo() {
    const id = useId();
    return (
        <Demo id="field" title="Field and label" note="Label above, one hint or error line below.">
            <FieldGroup className="max-w-sm">
                <Field>
                    <FieldLabel htmlFor={`${id}-name`}>Name</FieldLabel>
                    <Input id={`${id}-name`} defaultValue="Maya Lindqvist" />
                    <FieldDescription>Shown to people you share with.</FieldDescription>
                </Field>
                <Field data-invalid="true">
                    <FieldLabel htmlFor={`${id}-email`}>Email</FieldLabel>
                    <Input id={`${id}-email`} defaultValue="maya@" aria-invalid />
                    <FieldError>Enter the whole address, like maya@example.com.</FieldError>
                </Field>
                <Field orientation="horizontal">
                    <Checkbox id={`${id}-terms`} />
                    <FieldLabel htmlFor={`${id}-terms`}>Keep me signed in</FieldLabel>
                </Field>
            </FieldGroup>
            <Row label="Label">
                <Label htmlFor={`${id}-name`}>Name</Label>
            </Row>
        </Demo>
    );
}

export function ProgressDemo() {
    return (
        <Demo
            id="progress"
            title="Progress, skeleton and separator"
            note="Progress for work that moves; skeletons while a list loads."
        >
            <div className="flex max-w-sm flex-col gap-5">
                {[0, 40, 100].map((value) => (
                    <Progress key={value} value={value}>
                        <ProgressLabel>Uploading 3 files</ProgressLabel>
                        <ProgressValue />
                    </Progress>
                ))}
            </div>
            <Row label="Skeleton">
                <span className="flex w-full max-w-sm items-center gap-4">
                    <Skeleton className="size-9 rounded-[22%]" />
                    <Skeleton className="h-3 w-1/2 rounded-full" />
                </span>
            </Row>
            <Row label="Separator">
                <div className="flex h-10 w-full max-w-sm items-center gap-4">
                    <span className="text-sm">Files</span>
                    <Separator orientation="vertical" />
                    <span className="text-sm">Shared</span>
                </div>
                <Separator className="max-w-sm" />
            </Row>
        </Demo>
    );
}

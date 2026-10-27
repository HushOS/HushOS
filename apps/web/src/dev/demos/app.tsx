import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useDialKit } from 'dialkit';
import { cn } from 'cn';
import { MoreHorizontalIcon, UploadIcon } from 'lucide-react';
import { useState } from 'react';

import { AccessCell, type Access } from '@/components/access-cell';
import { AccessMarker } from '@/components/drive/access';
import { FileMark } from '@/components/drive/file-mark';
import {
    EmptyState,
    RowMenuButton,
    RowName,
    SelectableMark,
    SkeletonRows,
} from '@/components/drive/file-list';
import { FamilyPlan } from '@/components/families/family-billing';
import { PageHeader } from '@/components/page-header';
import { PersonAvatar } from '@/components/person-avatar';
import { Done, Segmented, Setting, SettingsGroup } from '@/components/settings';
import { StorageMeter } from '@/components/storage-card';
import { Button, buttonVariants } from '@/components/ui/button';
import { Demo, Row, Sample, SheetFrame } from '@/dev/demo';
import { familyBillingQueryOptions, type FamilyGlance } from '@/lib/family-billing';

const GB = 1024 ** 3;

export function PageHeaderDemo() {
    const dial = useDialKit(
        'Page header',
        {
            paddingX: [32, 0, 48],
            paddingBottom: [24, 0, 48],
            titleSize: [28, 18, 40],
            actionGap: [8, 0, 24],
        },
        { id: 'page-header', defaultCollapsed: true },
    );
    const scope = '[data-tune="page-header"]';
    return (
        <Demo
            id="page-header"
            title="Page header"
            note="Title on the left at 20px rising to 28px, the page's few actions on the right, a line of context under it."
        >
            <style>{`@media (width >= 40rem) { ${scope} > div { padding-inline: ${dial.paddingX}px; padding-bottom: ${dial.paddingBottom}px; } ${scope} h1 { font-size: ${dial.titleSize}px; } }
${scope} h1 + div { gap: ${dial.actionGap}px; }`}</style>
            <SheetFrame className="pt-5">
                <div data-tune="page-header" data-measure="">
                    <PageHeader
                        back={<a href="#page-header">Family</a>}
                        title="Lisbon 2026"
                        description="You and Sam can open everything in this folder."
                    >
                        <Button variant="outline">Share</Button>
                        <Button>
                            <UploadIcon />
                            Upload
                        </Button>
                    </PageHeader>
                </div>
            </SheetFrame>
        </Demo>
    );
}

type Stub = {
    id: string;
    kind: 'file' | 'folder';
    name: string;
    changed: string;
    size: string;
    access?: Access;
};

const ROWS: Stub[] = [
    {
        id: 'lisbon',
        kind: 'folder',
        name: 'Lisbon 2026',
        changed: '12 Oct',
        size: '–',
        access: {
            people: [
                { id: 'sam', name: 'Sam' },
                { id: 'ana', name: 'Ana' },
            ],
            links: 1,
        },
    },
    { id: 'budget', kind: 'file', name: 'Budget.xlsx', changed: 'Yesterday', size: '48 KB' },
    {
        id: 'passport',
        kind: 'file',
        name: 'Passport scan with a long name that runs out of room.pdf',
        changed: '3 Sept',
        size: '2.1 MB',
        access: { people: [], links: 1 },
    },
    { id: 'notes', kind: 'file', name: 'Notes.md', changed: '1 Aug', size: '3 KB' },
];

/*
 * The file browser's rows (folder-view.tsx) with stub items: the same parts, columns and
 * classes, on the page sheet. One row selected, one hovered and one focused.
 */
export function FileRowsDemo() {
    const dial = useDialKit(
        'File row',
        {
            height: [56, 44, 72],
            paddingLeft: [32, 0, 48],
            markGap: [16, 4, 24],
            nameSize: [15, 13, 17],
        },
        { id: 'file-row', defaultCollapsed: true },
    );
    const [selected, setSelected] = useState<Set<string>>(new Set(['budget']));
    const toggle = (id: string) =>
        setSelected((current) => {
            const next = new Set(current);
            if (!next.delete(id)) next.add(id);
            return next;
        });
    const scope = '[data-tune="file-row"]';
    return (
        <Demo
            id="file-rows"
            title="File list rows"
            note="Rows of at least 56px with 36px marks and a rule between them; Who can open only where it differs. Budget is selected, the passport scan hovered and Notes focused."
        >
            <style>{`${scope} tbody tr { height: ${dial.height}px; }
@media (width >= 48rem) { ${scope} td:first-child > span > button:first-child { padding-left: ${dial.paddingLeft}px; padding-right: ${dial.markGap}px; } ${scope} td:first-child > span > span button { font-size: ${dial.nameSize}px; } }`}</style>
            <SheetFrame>
                <div data-tune="file-row" className="relative overflow-x-auto">
                    <table className="w-full min-w-[640px] table-fixed border-collapse text-left">
                        <thead>
                            <tr className="h-10 border-b border-rule text-[13px] text-muted-foreground">
                                <th className="pl-4 font-medium md:pl-8">Name</th>
                                <th className="w-44 font-medium">Who can open</th>
                                <th className="w-28 font-medium">Changed</th>
                                <th className="w-24 pr-2 text-right font-medium">Size</th>
                                <th className="w-16">
                                    <span className="sr-only">Actions</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {ROWS.map((row, index) => {
                                const isSelected = selected.has(row.id);
                                return (
                                    <tr
                                        key={row.id}
                                        aria-selected={isSelected}
                                        data-measure=""
                                        data-force={index === 2 ? 'hover' : undefined}
                                        className={cn(
                                            'group/row h-14 cursor-default border-b border-rule select-none last:border-0',
                                            isSelected ? 'bg-accent' : 'hover:bg-muted',
                                            index === 3 && 'ring-1 ring-ring ring-inset',
                                        )}
                                    >
                                        <td className="min-w-0 p-0">
                                            <RowName
                                                node={{
                                                    name: row.name,
                                                    metadataSigner: null,
                                                    currentVersion: null,
                                                    integrity: null,
                                                }}
                                                onSelect={() => toggle(row.id)}
                                                thumbnail={
                                                    <SelectableMark
                                                        name={row.name}
                                                        checked={isSelected}
                                                        onToggle={() => toggle(row.id)}
                                                    >
                                                        <FileMark
                                                            kind={row.kind}
                                                            name={row.name}
                                                            size="list"
                                                        />
                                                    </SelectableMark>
                                                }
                                                name={row.name}
                                            />
                                        </td>
                                        <td className="min-w-0 pr-4">
                                            <AccessCell access={row.access} inherited={false} />
                                        </td>
                                        <td className="text-[13px] text-muted-foreground tabular-nums">
                                            {row.changed}
                                        </td>
                                        <td className="pr-2 text-right text-[13px] text-muted-foreground tabular-nums">
                                            {row.size}
                                        </td>
                                        <td className="pr-3 text-right sm:pr-5">
                                            <RowMenuButton aria-label={`More for ${row.name}`}>
                                                <MoreHorizontalIcon />
                                            </RowMenuButton>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </SheetFrame>
            <Row label="Loading">
                <SheetFrame className="w-full">
                    <SkeletonRows rows={2} />
                </SheetFrame>
            </Row>
            <Row label="Empty">
                <SheetFrame className="w-full">
                    <EmptyState
                        title="Nothing here yet"
                        body="Upload files or make a folder to start."
                    >
                        <Button variant="outline">New folder</Button>
                        <Button>
                            <UploadIcon />
                            Upload files
                        </Button>
                    </EmptyState>
                </SheetFrame>
            </Row>
        </Demo>
    );
}

export function PeopleDemo() {
    const people = [
        { id: 'sam', name: 'Sam Okafor' },
        { id: 'ana', name: 'Ana Ribeiro' },
        { id: 'jo', name: 'Jo Lindqvist' },
        { id: 'li', name: 'Li Wei' },
        { id: 'max', name: 'Max Berg' },
    ];
    return (
        <Demo
            id="people"
            title="Avatars and who can open"
            note="Four tones tell people apart; the blue link icon marks anyone with the link."
        >
            <Row label="Avatars">
                {[22, 24, 36, 48].map((size) => (
                    <Sample key={size} caption={`${size}px`}>
                        <span className="flex gap-2">
                            {people.slice(0, 4).map((person) => (
                                <PersonAvatar
                                    key={person.id}
                                    name={person.name}
                                    seed={person.id}
                                    size={size}
                                />
                            ))}
                        </span>
                    </Sample>
                ))}
            </Row>
            <Row label="Who can open, in a row">
                <Sample caption="Only you">
                    <AccessCell access={undefined} inherited={false} />
                </Sample>
                <Sample caption="Inherited">
                    <AccessCell access={undefined} inherited />
                </Sample>
                <Sample caption="People and a link">
                    <AccessCell
                        access={{ people: people.slice(0, 2), links: 1 }}
                        inherited={false}
                    />
                </Sample>
                <Sample caption="Detail">
                    <AccessCell
                        access={{ people: people.slice(0, 2), links: 1 }}
                        inherited={false}
                        detail
                    />
                </Sample>
            </Row>
            <Row label="Beside a folder's title">
                <AccessMarker access={{ people, links: 1 }} onOpen={() => {}} />
                <AccessMarker
                    access={{ people: people.slice(0, 1), links: 0 }}
                    via="Family"
                    onOpen={() => {}}
                />
            </Row>
        </Demo>
    );
}

export function SettingsDemo() {
    const [period, setPeriod] = useState<'month' | 'year'>('year');
    return (
        <Demo
            id="settings"
            title="Settings rows and storage"
            note="A group with its title and rule; rows with the label left and the action right."
        >
            <SheetFrame className="px-5 py-6 sm:px-8">
                <div className="max-w-2xl">
                    <SettingsGroup title="Plan and storage" description="Family Plus, paid yearly.">
                        <Setting label="Storage">
                            <span className="flex flex-col gap-1.5">
                                1.5 GB of 2 GB used
                                <StorageMeter
                                    used={1.5 * GB}
                                    quota={2 * GB}
                                    parts={{ files: 1.1 * GB, versions: 0.3 * GB, trash: 0.1 * GB }}
                                    className="h-1.5 max-w-64"
                                />
                            </span>
                        </Setting>
                        <Setting
                            label="Billing"
                            action={
                                <Segmented
                                    label="Billing period"
                                    options={[
                                        { value: 'month', label: 'Monthly' },
                                        { value: 'year', label: 'Yearly' },
                                    ]}
                                    value={period}
                                    onChange={setPeriod}
                                />
                            }
                        >
                            Two months free yearly
                        </Setting>
                        <Setting
                            label="Card and invoices"
                            action={
                                <a
                                    href="#settings"
                                    className={buttonVariants({ variant: 'outline' })}
                                >
                                    Open
                                </a>
                            }
                            below={<Done>Saved</Done>}
                        >
                            Visa ending 4242
                        </Setting>
                    </SettingsGroup>
                </div>
            </SheetFrame>
        </Demo>
    );
}

/*
 * The family plan as a member without billing sees it: the real FamilyPlan, reading a stub
 * summary from a query client of its own whose queries never run (`enabled: false`), so
 * nothing is fetched. Without the family's own record there is no "places taken" line.
 */
const USER = 'playground-user';
const GROUP = 'playground-family';

function StubFamily({ summary, place }: { summary: FamilyGlance; place: 'top' | 'bottom' }) {
    const [client] = useState(() => {
        const stub = new QueryClient({
            defaultOptions: { queries: { enabled: false, retry: false } },
        });
        stub.setQueryData(familyBillingQueryOptions(USER, GROUP).queryKey, summary);
        return stub;
    });
    return (
        <QueryClientProvider client={client}>
            <FamilyPlan
                place={place}
                userId={USER}
                groupId={GROUP}
                family="The Lindqvists"
                roles={[]}
                onCheckoutSeen={() => {}}
            />
        </QueryClientProvider>
    );
}

export function FamilyGlanceDemo() {
    const none = { usedBytes: '0', quotaBytes: '0' };
    return (
        <Demo
            id="family-glance"
            title="Family plan glance"
            note={
                <>
                    What a member without billing is shown: the plan and the pool, or why there is
                    none. This is main’s version; the Plan heading becomes a settings group when
                    #202 merges.
                </>
            }
        >
            <SheetFrame className="pb-6" data-measure="">
                <StubFamily
                    place="bottom"
                    summary={{
                        enabled: true,
                        view: 'member',
                        hasPlan: true,
                        planName: 'Family Plus',
                        storage: { usedBytes: String(120 * GB), quotaBytes: String(1024 * GB) },
                    }}
                />
            </SheetFrame>
            <SheetFrame className="flex flex-col gap-3 py-6">
                <StubFamily
                    place="top"
                    summary={{
                        enabled: true,
                        view: 'member',
                        hasPlan: false,
                        planName: null,
                        storage: null,
                    }}
                />
                <StubFamily
                    place="top"
                    summary={{
                        enabled: true,
                        view: 'member',
                        hasPlan: false,
                        planName: null,
                        storage: none,
                        lapsedPlan: {
                            productName: 'Family Plus',
                            standing: 'paused',
                            youPay: false,
                        },
                    }}
                />
                <StubFamily
                    place="top"
                    summary={{
                        enabled: true,
                        view: 'member',
                        hasPlan: false,
                        planName: null,
                        storage: none,
                        lapsedPlan: {
                            productName: 'Family Plus',
                            standing: 'payment-failed',
                            youPay: false,
                        },
                    }}
                />
            </SheetFrame>
        </Demo>
    );
}

import { FolderMark } from '@/components/folder-mark';
import { AppWindow, Bar, FAMILY, FauxButton, Sidebar, Title } from './faux';
import { Scene } from './scene';

/*
 * The family folders, beside your own: a still. The sidebar has My files, private to you, and
 * Family folders under it; the family's folders are listed as folder rows, each one everyone in
 * the family can open; the meter at the sidebar's foot is the family's one plan.
 */

const FOLDERS = ['Holidays', 'House', 'School'];

function PoolMeter() {
    return (
        <span className="flex flex-col gap-1.5">
            <span className="truncate text-xs font-semibold text-muted-foreground">{FAMILY}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-foreground/10">
                <span className="block h-full w-[23%] rounded-full bg-primary" />
            </span>
            <span className="text-[13px] tabular-nums">460 GB of 2 TB used</span>
            <span className="text-[13px] text-muted-foreground tabular-nums">1.55 TB free</span>
        </span>
    );
}

export function FamilyFoldersScene() {
    return (
        <Scene<Record<string, never>>
            label={`HushOS with ${FAMILY}'s folders open. The sidebar lists My files, private to you, and Family folders right under it. The family's folders, Holidays, House and School, each say “Everyone in the family can open it”. At the sidebar's foot, the family's storage: 460 GB of 2 TB used.`}
            height={470}
            compact={{ height: 400 }}
            initial={{}}
        >
            {(_s, _rect, layout) => {
                const compact = layout === 'compact';
                return (
                    <AppWindow
                        className="inset-0"
                        sidebar={
                            compact ? undefined : (
                                <Sidebar active="family-folders" meter={<PoolMeter />} />
                            )
                        }
                    >
                        <Title
                            actions={
                                !compact && (
                                    <>
                                        <FauxButton variant="outline">Members</FauxButton>
                                        <FauxButton>New family folder</FauxButton>
                                    </>
                                )
                            }
                            description="Family folders. Everyone in the family can open what’s in them."
                        >
                            {FAMILY}
                        </Title>
                        <span className="flex flex-col border-t border-rule">
                            {FOLDERS.map((name) => (
                                <span
                                    key={name}
                                    className="flex min-h-14 items-center gap-3 border-b border-rule px-6 py-2"
                                >
                                    <FolderMark box={36} />
                                    <span className="flex min-w-0 flex-col gap-0.5">
                                        <span className="text-[15px] font-medium">{name}</span>
                                        <span className="text-[13px] text-muted-foreground">
                                            Everyone in the family can open it
                                        </span>
                                    </span>
                                </span>
                            ))}
                            {[96, 72].map((width) => (
                                <span
                                    key={width}
                                    className="flex min-h-14 items-center gap-3 border-b border-rule px-6 py-2 opacity-60"
                                >
                                    <FolderMark box={36} />
                                    <span className="flex flex-col gap-2">
                                        <Bar width={width} />
                                        <Bar width={width + 70} />
                                    </span>
                                </span>
                            ))}
                        </span>
                    </AppWindow>
                );
            }}
        </Scene>
    );
}

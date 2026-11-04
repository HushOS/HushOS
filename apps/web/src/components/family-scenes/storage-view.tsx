import { useRouteContext } from '@tanstack/react-router';
import { cn } from 'cn';
import { useId, useState } from 'react';
import { familyStorage } from '@/components/family-storage';
import { Fill, SizeDots, Slider, useSettled } from '@/components/fit-planner';
import { Checkbox } from '@/components/ui/checkbox';
import { formatQuota } from '@/lib/format';

/*
 * The post's one hands-on piece: a family's storage as one plan holding everyone's own files and
 * the family folders, as People and the two sizes move, and what changes when someone leaves. The
 * plan is the pricing planner's own answer (fitAnswer through familyStorage) and the dots are its
 * bar and its size block, so this can't drift from what the pricing page says. The dots are
 * decoration; the words beside them say every figure, and a screen reader hears the answer once
 * the sliders settle.
 */

const GB = 1024 ** 3;
const size = (bytes: number) => formatQuota(bytes, 'en-GB');
const peopleWords = (value: number) => `${value} people`;

/* Everyone's own files are solid dots, the family folders hollow ones: told apart by shape too. */
const OWN = 'bg-primary';
const FOLDERS = 'bg-transparent shadow-[inset_0_0_0_2px_var(--primary)]';

function Swatch({ look }: { look: string }) {
    return <span aria-hidden="true" className={cn('size-2.5 shrink-0 rounded-full', look)} />;
}

export function FamilyStorageView() {
    const { freeQuotaBytes } = useRouteContext({ from: '__root__' });
    const [people, setPeople] = useState(4);
    const [ownGb, setOwnGb] = useState(100);
    const [foldersGb, setFoldersGb] = useState(300);
    const [leaving, setLeaving] = useState(false);
    const leaveId = useId();
    const free = Number(freeQuotaBytes);
    const view = familyStorage({
        people,
        ownEach: ownGb * GB,
        folders: foldersGb * GB,
        leaving,
        freeBytes: free,
    });
    const plan =
        view.answer.kind === 'fits' || view.answer.kind === 'tight' ? view.answer.plan : null;
    const used = view.ownBytes + view.folderBytes;
    const headline =
        view.answer.kind === 'empty'
            ? 'Move a slider to start.'
            : !plan
              ? view.answer.kind === 'beyond' && view.answer.largest
                  ? `More than ${size(view.answer.largest.quotaBytes)}.`
                  : 'More than any family plan holds.'
              : view.answer.kind === 'fits'
                ? `${plan.name} fits.`
                : `Tight in ${plan.name}.`;
    const leaver = view.leaver;
    const leaverLine = leaver
        ? `Their own files, ${size(leaver.bytes)}, go back to their own storage: Free, ${size(leaver.quotaBytes)}, unless they choose a plan.` +
          (leaver.fits
              ? ''
              : ' That’s more than Free holds, so they can open, download and delete everything, but can’t upload until they make room. Nothing is deleted.')
        : '';
    const spoken = useSettled(
        plan
            ? `${headline} ${size(plan.quotaBytes)}. Everyone’s own files ${size(view.ownBytes)}, family folders ${size(view.folderBytes)}, ${size(Math.max(0, plan.quotaBytes - used))} free. ${leaverLine}`
            : `${headline} ${leaverLine}`,
    );
    return (
        <section
            aria-labelledby="family-storage-title"
            className="mt-6 grid gap-7 rounded-xl bg-muted/70 p-5 sm:p-6"
        >
            <div className="flex flex-col gap-1.5">
                <p id="family-storage-title" className="text-lg font-bold">
                    One plan for everyone’s files
                </p>
                <p className="text-[15px] leading-relaxed text-muted-foreground">
                    Move the sliders. The plan is the smallest that fits with a tenth to spare, for
                    versions and Trash, as the pricing page works it out.
                </p>
            </div>
            <div className="grid gap-5 sm:grid-cols-3">
                <Slider
                    label="People"
                    value={people}
                    min={2}
                    max={20}
                    step={1}
                    unit={peopleWords}
                    onChange={setPeople}
                />
                <Slider
                    label="Each person’s files"
                    value={ownGb}
                    max={500}
                    step={5}
                    unit={(value) => size(value * GB)}
                    onChange={setOwnGb}
                />
                <Slider
                    label="Family folders"
                    value={foldersGb}
                    max={2000}
                    step={10}
                    unit={(value) => size(value * GB)}
                    onChange={setFoldersGb}
                />
            </div>
            <div className="flex flex-col gap-4">
                <output className="sr-only">{spoken}</output>
                <div className="flex items-center justify-between gap-4">
                    <p className="text-[22px] leading-tight font-extrabold tracking-[-0.02em] sm:text-[26px]">
                        {headline}
                    </p>
                    {plan && (
                        <span className="flex shrink-0 items-center gap-3 text-[15px] font-semibold tabular-nums">
                            <SizeDots quotaBytes={plan.quotaBytes} />
                            {size(plan.quotaBytes)}
                        </span>
                    )}
                </div>
                {plan && (
                    <>
                        <Fill
                            shares={[
                                view.ownBytes / plan.quotaBytes,
                                view.folderBytes / plan.quotaBytes,
                            ]}
                            looks={[OWN, FOLDERS]}
                        />
                        <ul className="flex list-none flex-wrap gap-x-5 gap-y-1.5 pl-0 text-sm text-muted-foreground tabular-nums">
                            <li className="flex items-center gap-2 pl-0">
                                <Swatch look={OWN} />
                                Everyone’s own files, {size(view.ownBytes)}
                            </li>
                            <li className="flex items-center gap-2 pl-0">
                                <Swatch look={FOLDERS} />
                                Family folders, {size(view.folderBytes)}
                            </li>
                            <li className="flex items-center gap-2 pl-0">
                                <Swatch look="fit-dot-off bg-foreground/12" />
                                Free, {size(Math.max(0, plan.quotaBytes - used))}
                            </li>
                        </ul>
                    </>
                )}
            </div>
            <div className="flex flex-col gap-3 border-t border-rule pt-5">
                <label
                    htmlFor={leaveId}
                    className="flex min-h-9 w-fit cursor-pointer items-center gap-2.5 text-[15px] font-semibold pointer-coarse:min-h-11"
                >
                    <Checkbox
                        id={leaveId}
                        checked={leaving}
                        onCheckedChange={(value) => setLeaving(value === true)}
                    />
                    Someone leaves
                </label>
                <p className="text-[15px] leading-relaxed text-muted-foreground">
                    {leaver
                        ? `${leaverLine}${plan ? ` The family keeps ${plan.name}.` : ''}`
                        : 'Their own files leave the family’s storage with them.'}
                </p>
            </div>
        </section>
    );
}

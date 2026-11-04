import {
    createContext,
    useCallback,
    useContext,
    useState,
    useSyncExternalStore,
    type ReactNode,
} from 'react';
import { AccountChangedStep } from '@/components/drive/account-changed';
import { AddSomeone, firstName } from '@/components/drive/add-someone';
import { CheckContactStep, type Checking } from '@/components/drive/check-contact';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import type { AccountChange } from '@/lib/contacts';

/*
 * Adding someone, "Maya's account changed", Check it's Maya and Stop sharing
 * with Maya, as one flow in one dialog: each step replaces the one it came
 * from, so there is only ever one dialog on screen. Met inside another dialog
 * (the share sheet, Info on a narrow screen), the flow takes that dialog's
 * place and closing it comes back there; anywhere else it opens a dialog of
 * its own, hosted by the drive shell, and closing it closes it.
 */
export type FlowStart =
    | { kind: 'add' }
    /* Check who wrote this, from a mark: the writer's address, then their words. */
    | { kind: 'find'; writer: string }
    | { kind: 'changed'; change: AccountChange }
    | { kind: 'check'; person: Checking };
type FlowStep = FlowStart;

/*
 * One step at a time inside whatever DialogContent holds it. `onDone` ends
 * the flow; `onResolved` says trust was settled (Continue or They match), so
 * what waited on the person may run.
 */
export function ContactFlow({
    userId,
    start,
    onDone,
    onResolved,
}: {
    userId: string;
    start: FlowStart;
    onDone: () => void;
    onResolved?: () => void;
}) {
    const [step, setStep] = useState<FlowStep>(start);
    switch (step.kind) {
        case 'add':
        case 'find':
            return (
                <>
                    <DialogHeader>
                        <DialogTitle>
                            {step.kind === 'add' ? 'Add someone' : 'Check who wrote this'}
                        </DialogTitle>
                        {step.kind === 'find' && (
                            <DialogDescription>
                                Enter the email they use for HushOS. Once they’re in your contacts,
                                what they add and change shows as theirs.
                            </DialogDescription>
                        )}
                    </DialogHeader>
                    <AddSomeone
                        userId={userId}
                        writer={step.kind === 'find' ? step.writer : undefined}
                        onCancel={onDone}
                        onAdded={(pin) => {
                            toast.add({ type: 'success', title: `${firstName(pin.name)} added` });
                            // From a mark, the words come next if they like: the advanced door.
                            if (step.kind === 'find')
                                setStep({
                                    kind: 'check',
                                    person: { email: pin.email, name: pin.name },
                                });
                            else onDone();
                        }}
                        // Already in Contacts (added since the mark was drawn): the check the mark offered.
                        onAlready={(pin) =>
                            setStep({ kind: 'check', person: { email: pin.email, name: pin.name } })
                        }
                        onChanged={(change) => setStep({ kind: 'changed', change })}
                    />
                </>
            );
        case 'changed':
            return (
                <AccountChangedStep
                    key={step.change.contactId}
                    userId={userId}
                    change={step.change}
                    onDone={onDone}
                    onResolved={onResolved}
                    onCheck={() =>
                        setStep({
                            kind: 'check',
                            person: { email: step.change.email, name: step.change.name },
                        })
                    }
                />
            );
        case 'check':
            return (
                <CheckContactStep
                    key={step.person.email}
                    userId={userId}
                    person={step.person}
                    onDone={onDone}
                    onResolved={onResolved}
                />
            );
    }
}

/* The flow in a dialog of its own: closing any step closes it. */
export function ContactFlowDialog({
    userId,
    start,
    onOpenChange,
    onResolved,
}: {
    userId: string;
    start: FlowStart | null;
    onOpenChange: (open: boolean) => void;
    onResolved?: () => void;
}) {
    return (
        <Dialog open={start !== null} onOpenChange={onOpenChange}>
            <DialogContent
                className="sm:max-w-[480px]"
                onClick={(event) => event.stopPropagation()}
            >
                {start && (
                    <ContactFlow
                        key={flowKey(start)}
                        userId={userId}
                        start={start}
                        onDone={() => onOpenChange(false)}
                        onResolved={onResolved}
                    />
                )}
            </DialogContent>
        </Dialog>
    );
}

function flowKey(start: FlowStart) {
    switch (start.kind) {
        case 'add':
            return 'add';
        case 'find':
            return `find:${start.writer}`;
        case 'changed':
            return `changed:${start.change.contactId}`;
        case 'check':
            return `check:${start.person.email}`;
    }
}

/*
 * The shell's host, for flows started outside any dialog (a row's mark, the
 * Info panel beside the list) or by something that does not stay on screen: a
 * mark clears the moment its writer is added, and the check offered next must
 * outlive it.
 */
let requested: { start: FlowStart; onResolved?: () => void } | null = null;
const listeners = new Set<() => void>();
export function requestFlow(start: FlowStart | null, onResolved?: () => void) {
    requested = start ? { start, onResolved } : null;
    for (const listener of listeners) listener();
}
export function ContactFlowHost({ userId }: { userId: string }) {
    const current = useSyncExternalStore(
        (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        () => requested,
        () => null,
    );
    return (
        <ContactFlowDialog
            userId={userId}
            start={current?.start ?? null}
            onResolved={current?.onResolved}
            onOpenChange={(open) => !open && requestFlow(null)}
        />
    );
}

/* Where a flow opens from here: in the dialog this sits in, or the shell's own. */
type OpenFlow = (start: FlowStart, onResolved?: () => void) => void;
const FlowContext = createContext<OpenFlow>(requestFlow);
export function useContactFlow() {
    return useContext(FlowContext);
}

/*
 * For a dialog that hosts the flow in its own place (the share sheet, Info):
 * `flow` is the step to show instead of the dialog's own content, `open`
 * starts one (hand it to ContactFlowProvider around that content), and
 * `back` (the dialog's close) returns to the content.
 */
export function useFlowInPlace() {
    const [flow, setFlow] = useState<{ start: FlowStart; onResolved?: () => void } | null>(null);
    const open = useCallback<OpenFlow>((start, onResolved) => setFlow({ start, onResolved }), []);
    const back = useCallback(() => setFlow(null), []);
    return { flow, open, back };
}
export function ContactFlowProvider({ open, children }: { open: OpenFlow; children: ReactNode }) {
    return <FlowContext.Provider value={open}>{children}</FlowContext.Provider>;
}

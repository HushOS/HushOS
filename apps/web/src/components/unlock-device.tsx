import { revalidateLogic, useForm } from '@tanstack/react-form';
import { useEffect, useState } from 'react';
import { DeviceStorageUnreadable, StepCancelled } from '@hushos/auth/client';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { AuthNote } from '@/components/auth-layout';
import { StepChoices, StepField, stepWords, useStepPrompt } from '@/components/two-step-prompt';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';
import { codesLeft, FEW_CODES, notePhraseSignIn } from '@/lib/two-step';

const unlockFields = z.object({ password: z.string().min(1, 'Enter your password.').max(128) });

/*
 * Unlocks HushOS on this browser without leaving the page. Signing in again
 * runs OPAQUE for the known email, which is exactly what unlocking is. An
 * account with a second step is asked for it here too, when this browser's
 * session has not passed it in the last thirty days (docs/two-step-design.md 4):
 * after the password, the same form asks for the code. What follows a backup
 * code or the phrase is said as the sign-in page says it, but without leaving:
 * this form unlocks in place, often in the middle of something else.
 */

/* The buttons of the form, stacked on a phone with the main one first, as a dialog's are. */
const actions = 'flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-end';

export function UnlockDevice({
    user,
    onUnlocked,
    onCancel,
    onDescribe,
    className,
}: {
    user: { email: string };
    onUnlocked?: () => void | Promise<void>;
    /* In a dialog: Cancel beside Unlock. */
    onCancel?: () => void;
    /*
     * In a dialog that has a description of its own: told what the second step asks for
     * while it is asked (null otherwise), so the dialog says one thing, not two.
     */
    onDescribe?: (about: string | null) => void;
    className?: string;
}) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    // This browser's device key could not be read: the person may unlock as a new device instead.
    const [offerNewDevice, setOfferNewDevice] = useState(false);
    // The account's step is one this page's code cannot answer: a reload gets the code that can.
    const [outdated, setOutdated] = useState(false);
    // Back at the password from the step (backed out, or out of time): the field takes the focus.
    const [returned, setReturned] = useState(0);
    useEffect(() => {
        if (returned > 0) document.getElementById('unlock-password')?.focus();
    }, [returned]);
    const step = useStepPrompt({
        onExpired: () => setError('Unlocking timed out. Enter your password again.'),
    });
    const about = step.request ? stepWords[step.kind].about : null;
    useEffect(() => {
        onDescribe?.(about);
    }, [about, onDescribe]);
    const form = useForm({
        defaultValues: { password: '' },
        validationLogic: revalidateLogic(),
        validators: { onDynamic: unlockFields },
        // What the press asked for, given with that press and never kept: a press that fails
        // validation leaves nothing behind for the next one.
        onSubmitMeta: { asNewDevice: false },
        onSubmit: async ({ value, meta }) => {
            setPending(true);
            setError('');
            setOutdated(false);
            try {
                const { step: stepped } = await authClient.login(user.email, value.password, {
                    asNewDevice: meta.asNewDevice,
                    step: step.ask,
                });
                cue('success');
                // As after a sign-in: the phrase stands in for a method that is lost, and a
                // backup code may leave few. Said in passing; Account has the rest.
                if (stepped?.offered) {
                    if (stepped.answered === 'phrase') {
                        notePhraseSignIn(true);
                        toast.add({
                            title: 'Unlocked with your recovery phrase',
                            description:
                                'If you’ve lost your authenticator app, set it up again in Account, under Two-step sign-in.',
                        });
                    } else if (
                        stepped.answered === 'backup' &&
                        stepped.backupCodesLeft !== undefined &&
                        stepped.backupCodesLeft <= FEW_CODES
                    )
                        toast.add({
                            type: 'warning',
                            title: codesLeft(stepped.backupCodesLeft),
                            description:
                                'Each backup code works once. Make a new set in Account, under Two-step sign-in.',
                        });
                }
                // Kept, and busy, while what unlocking opens takes over; emptied after,
                // in case this form stays on screen.
                await onUnlocked?.();
                form.reset();
            } catch (error) {
                // Backed out of the step, or its time ran out (said by the step itself).
                if (error instanceof StepCancelled) return setReturned((count) => count + 1);
                cue('error');
                setOfferNewDevice(error instanceof DeviceStorageUnreadable);
                const old = (error as { code?: unknown } | null)?.code === 'update-required';
                setOutdated(old);
                setError(old ? 'This page is out of date. Reload it to unlock.' : authError(error));
            } finally {
                step.done();
                setPending(false);
            }
        },
    });
    if (step.request)
        return (
            <form
                className={className}
                onSubmit={(event) => {
                    event.preventDefault();
                    step.submit();
                }}
                aria-busy={step.checking}
                noValidate
            >
                <div className="flex flex-col gap-4">
                    {!onDescribe && <p className="text-sm text-muted-foreground">{about}</p>}
                    <StepField prompt={step} />
                    <StepChoices prompt={step} />
                    <div className={actions}>
                        <Button
                            type="button"
                            variant="outline"
                            size={onCancel ? 'default' : 'lg'}
                            disabled={step.checking}
                            onClick={step.cancel}
                        >
                            Back
                        </Button>
                        <Button
                            type="submit"
                            size={onCancel ? 'default' : 'lg'}
                            disabled={step.checking}
                        >
                            {step.checking ? 'Unlocking…' : 'Unlock'}
                        </Button>
                    </div>
                </div>
            </form>
        );
    return (
        <form
            className={className}
            onSubmit={(event) => {
                event.preventDefault();
                // Sign in, Unlock and Try again: always as this device.
                void form.handleSubmit({ asNewDevice: false });
            }}
            aria-busy={pending}
            noValidate
        >
            <div className="flex flex-col gap-4">
                {error && <AuthNote tone="danger">{error}</AuthNote>}
                <form.Field name="password">
                    {(field) => (
                        <AuthInput
                            label="Password"
                            hint={user.email}
                            id="unlock-password"
                            name={field.name}
                            type="password"
                            autoComplete="current-password"
                            value={field.state.value}
                            onChange={(event) => field.handleChange(event.target.value)}
                            onBlur={field.handleBlur}
                            errors={field.state.meta.errors}
                            disabled={pending}
                            required
                            maxLength={128}
                        />
                    )}
                </form.Field>
                <div className={actions}>
                    {onCancel && (
                        <Button
                            type="button"
                            variant="outline"
                            disabled={pending}
                            onClick={onCancel}
                        >
                            Cancel
                        </Button>
                    )}
                    {offerNewDevice && (
                        <Button
                            type="button"
                            variant="outline"
                            size={onCancel ? 'default' : 'lg'}
                            disabled={pending}
                            onClick={() => void form.handleSubmit({ asNewDevice: true })}
                        >
                            Unlock as a new device
                        </Button>
                    )}
                    {outdated && (
                        <Button
                            type="button"
                            variant="outline"
                            size={onCancel ? 'default' : 'lg'}
                            onClick={() => window.location.reload()}
                        >
                            Reload this page
                        </Button>
                    )}
                    <Button type="submit" size={onCancel ? 'default' : 'lg'} disabled={pending}>
                        {pending ? 'Unlocking…' : offerNewDevice ? 'Try again' : 'Unlock'}
                    </Button>
                </div>
            </div>
        </form>
    );
}

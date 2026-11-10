import { revalidateLogic, useForm } from '@tanstack/react-form';
import { useState } from 'react';
import { DeviceStorageUnreadable, StepCancelled } from '@hushos/auth/client';
import { z } from 'zod';
import { AuthInput } from '@/components/auth-input';
import { AuthNote } from '@/components/auth-layout';
import {
    StepChoices,
    StepField,
    STEP_TIMED_OUT,
    stepWords,
    useStepPrompt,
} from '@/components/two-step-prompt';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';
import { authError } from '@/lib/form';
import { cue } from '@/lib/sounds';

const unlockFields = z.object({ password: z.string().min(1, 'Enter your password.').max(128) });

/*
 * Unlocks HushOS on this browser without leaving the page. Signing in again
 * runs OPAQUE for the known email, which is exactly what unlocking is. An
 * account with a second step is asked for it here too, when this browser's
 * session has not passed it in the last thirty days (docs/two-step-design.md 4):
 * after the password, the same form asks for the code.
 */
export function UnlockDevice({
    user,
    onUnlocked,
    onCancel,
    className,
}: {
    user: { email: string };
    onUnlocked?: () => void | Promise<void>;
    /* In a dialog: Cancel beside Unlock. */
    onCancel?: () => void;
    className?: string;
}) {
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    // This browser's device key could not be read: the person may unlock as a new device instead.
    const [offerNewDevice, setOfferNewDevice] = useState(false);
    const step = useStepPrompt({ onExpired: () => setError(STEP_TIMED_OUT) });
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
            try {
                await authClient.login(user.email, value.password, {
                    asNewDevice: meta.asNewDevice,
                    step: step.ask,
                });
                cue('success');
                // Kept, and busy, while what unlocking opens takes over; emptied after,
                // in case this form stays on screen.
                await onUnlocked?.();
                form.reset();
            } catch (error) {
                // Backed out of the step, or its time ran out (said by the step itself).
                if (error instanceof StepCancelled) return;
                cue('error');
                setOfferNewDevice(error instanceof DeviceStorageUnreadable);
                setError(authError(error));
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
                    <p className="text-sm text-muted-foreground">{stepWords[step.kind].about}</p>
                    <StepField prompt={step} />
                    <StepChoices prompt={step} />
                    <div className="flex justify-end gap-2">
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
                <div className="flex justify-end gap-2">
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
                    <Button type="submit" size={onCancel ? 'default' : 'lg'} disabled={pending}>
                        {pending ? 'Unlocking…' : offerNewDevice ? 'Try again' : 'Unlock'}
                    </Button>
                </div>
            </div>
        </form>
    );
}

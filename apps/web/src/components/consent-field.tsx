import { Link } from '@tanstack/react-router';
import { messagesOf } from '@/components/auth-input';
import { FormRow } from '@/components/form-rows';
import { Checkbox } from '@/components/ui/checkbox';

export function ConsentField({
    checked,
    onChange,
    onBlur,
    errors,
    disabled,
}: {
    checked: boolean;
    onChange: (value: boolean) => void;
    onBlur?: () => void;
    errors: unknown[];
    disabled?: boolean;
}) {
    const message = messagesOf(errors);
    const invalid = message.length > 0;
    return (
        <FormRow label="Terms" htmlFor="agree" invalid={invalid}>
            <div className="flex items-start gap-3 py-1">
                <Checkbox
                    id="agree"
                    checked={checked}
                    onCheckedChange={(value) => onChange(value === true)}
                    onBlur={onBlur}
                    aria-invalid={invalid}
                    aria-describedby={invalid ? 'agree-error' : undefined}
                    disabled={disabled}
                />
                <label htmlFor="agree" className="text-sm leading-relaxed select-none">
                    I agree to the{' '}
                    <Link to="/terms" target="_blank" className="text-link">
                        Terms of Service
                    </Link>{' '}
                    and{' '}
                    <Link to="/privacy" target="_blank" className="text-link">
                        Privacy Policy
                    </Link>
                    .
                </label>
            </div>
            {invalid && (
                <p
                    id="agree-error"
                    role="alert"
                    className="bg-destructive-soft px-4 py-2 text-xs leading-relaxed text-destructive animate-in fade-in duration-200 ease-out-expo"
                >
                    {message}
                </p>
            )}
        </FormRow>
    );
}

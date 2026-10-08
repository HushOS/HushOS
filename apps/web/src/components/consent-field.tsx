import { Link } from '@tanstack/react-router';
import { messagesOf } from '@/components/auth-input';
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
        <div className="flex flex-col gap-1.5">
            <div className="flex items-start gap-2.5">
                <Checkbox
                    id="agree"
                    checked={checked}
                    onCheckedChange={(value) => onChange(value === true)}
                    onBlur={onBlur}
                    aria-invalid={invalid}
                    aria-describedby={invalid ? 'agree-error' : undefined}
                    disabled={disabled}
                    className="mt-0.5"
                />
                <label htmlFor="agree" className="text-sm leading-snug select-none">
                    I agree to the{' '}
                    <Link
                        to="/terms"
                        target="_blank"
                        className="font-semibold underline underline-offset-2"
                    >
                        Terms of Service
                    </Link>{' '}
                    and{' '}
                    <Link
                        to="/privacy"
                        target="_blank"
                        className="font-semibold underline underline-offset-2"
                    >
                        Privacy Policy
                    </Link>
                </label>
            </div>
            {invalid && (
                <p
                    id="agree-error"
                    role="alert"
                    className="pl-6.5 text-[13px] text-destructive animate-in fade-in duration-200 ease-out-expo"
                >
                    {message}
                </p>
            )}
        </div>
    );
}

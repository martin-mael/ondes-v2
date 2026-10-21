import { REGEXP_ONLY_DIGITS } from 'input-otp';
import { CircleAlertIcon } from 'lucide-react';
import { type ComponentProps, type FormEvent, useState } from 'react';
import type { z } from 'zod';
import { Alert, AlertDescription } from '@/ui/alert';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/ui/input-otp';
import { isApiError } from './api/client.ts';
import { useI18n } from './i18n/i18n.tsx';
import type { MessageKey } from './i18n/messages.ts';

// Form plumbing for the app: uncontrolled inputs read with FormData on submit, validated with
// the shared zod contract, field errors shaped for <FieldError errors={…} />, and api errors
// turned into translated messages.

export type FieldErrors = Partial<Record<string, { message: string }[]>>;

export function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const name = String(issue.path[0] ?? '');
    const list = out[name] ?? [];
    list.push({ message: issue.message });
    out[name] = list;
  }
  return out;
}

export function useZodForm<S extends z.ZodType>(
  schema: S,
  submit: (data: z.output<S>) => Promise<unknown>,
) {
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const parsed = schema.safeParse(values);
    setFormError(null);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setPending(true);
    try {
      await submit(parsed.data);
    } catch (error) {
      setFormError(error);
    } finally {
      setPending(false);
    }
  };

  /** Props for an input: name, id and aria-invalid. */
  const field = (name: string) => ({
    name,
    id: name,
    'aria-invalid': errors[name] ? true : undefined,
  });

  return { onSubmit, errors, formError, setFormError, pending, field };
}

/** Translated message for an api (or unexpected) error. */
export function useErrorMessage() {
  const { t } = useI18n();
  return (error: unknown): string => {
    if (!isApiError(error)) return t('error.generic');
    if (error.code === 'network') return t('error.network');
    if (error.status === 429 && error.code !== 'two_factor_locked') return t('error.rate_limited');
    const key = `error.${error.code}` as MessageKey;
    return key in knownErrors ? t(key) : error.message || t('error.generic');
  };
}

const knownErrors: Partial<Record<MessageKey, true>> = {
  'error.invalid_credentials': true,
  'error.invalid_code': true,
  'error.invalid_token': true,
  'error.email_not_verified': true,
  'error.no_pending_login': true,
  'error.two_factor_locked': true,
  'error.two_factor_required': true,
  'error.invitation_email_mismatch': true,
  'error.invitation_not_found': true,
  'error.invitation_not_pending': true,
  'error.invitation_used': true,
  'error.already_member': true,
  'error.forbidden': true,
  'error.not_found': true,
};

export function FormAlert({ error }: { error: unknown }) {
  const message = useErrorMessage();
  if (!error) return null;
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertDescription>{message(error)}</AlertDescription>
    </Alert>
  );
}

export type ZodForm = ReturnType<typeof useZodForm>;

export function TextField({
  form,
  name,
  label,
  description,
  ...input
}: {
  form: Pick<ZodForm, 'errors' | 'field'>;
  name: string;
  label: string;
  description?: string;
} & Omit<ComponentProps<typeof Input>, 'name' | 'id' | 'form'>) {
  const errors = form.errors[name];
  return (
    <Field data-invalid={errors ? true : undefined}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Input {...input} {...form.field(name)} />
      {description && <FieldDescription>{description}</FieldDescription>}
      <FieldError errors={errors} />
    </Field>
  );
}

/** Six-digit TOTP code, submitted as `name` (default `code`). */
export function CodeField({
  form,
  name = 'code',
  label,
}: {
  form: Pick<ZodForm, 'errors' | 'field'>;
  name?: string;
  label: string;
}) {
  const errors = form.errors[name];
  return (
    <Field data-invalid={errors ? true : undefined}>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <InputOTP
        {...form.field(name)}
        maxLength={6}
        pattern={REGEXP_ONLY_DIGITS}
        autoComplete="one-time-code"
        autoFocus
      >
        <InputOTPGroup>
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <InputOTPSlot key={index} index={index} />
          ))}
        </InputOTPGroup>
      </InputOTP>
      <FieldError errors={errors} />
    </Field>
  );
}

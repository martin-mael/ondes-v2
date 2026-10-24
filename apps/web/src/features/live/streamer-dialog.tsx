import {
  createStreamerSchema,
  type LiveAdHocPolicy,
  type LocalDate,
  type LocalTime,
  type Streamer,
  type StreamerWithPassword,
  updateStreamerSchema,
  zonedInstant,
  zonedParts,
} from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel, FieldLegend, FieldSet } from '@/ui/field';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { type FieldErrors, FormAlert, fieldErrors } from '../../app/forms.tsx';
import { DelayedSpinner } from '../../app/pending.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { showsQuery } from '../shows/api.ts';
import { invalidateLive, liveApi, userCandidatesQuery } from './api.ts';
import { useLiveT } from './messages.ts';
import { ShowChip } from './show-chip.tsx';

// Create or edit a streamer (`live:manage`). The expiry is typed in station time and sent as
// an instant. A new streamer's password is generated unless one is typed; it comes back once.

interface Draft {
  displayName: string;
  username: string;
  password: string;
  userId: string;
  enabled: boolean;
  expiresDate: string;
  expiresTime: string;
  anyTime: boolean;
  adHoc: LiveAdHocPolicy;
  showIds: string[];
}

function draftOf(streamer: Streamer | undefined, timezone: string): Draft {
  const expires = streamer?.expiresAt ? zonedParts(streamer.expiresAt, timezone) : null;
  return {
    displayName: streamer?.displayName ?? '',
    username: streamer?.username ?? '',
    password: '',
    userId: streamer?.user?.id ?? '',
    enabled: streamer?.enabled ?? true,
    expiresDate: expires?.date ?? '',
    expiresTime: expires?.time ?? '',
    anyTime: streamer?.anyTime ?? false,
    adHoc: streamer?.adHoc ?? 'approval',
    showIds: streamer?.shows.map((s) => s.id) ?? [],
  };
}

export function StreamerDialog({
  stationId,
  timezone,
  streamer,
  open,
  onOpenChange,
  onCreated,
}: {
  stationId: string;
  timezone: string;
  /** Absent: a new streamer. */
  streamer?: Streamer;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** With the generated (or typed) password, to show once. */
  onCreated?(result: StreamerWithPassword): void;
}) {
  const t = useLiveT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(streamer, timezone));
  const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(
    open && JSON.stringify(draft) !== JSON.stringify(draftOf(streamer, timezone)),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const users = useQuery({ ...userCandidatesQuery(stationId), enabled: open });
  const shows = useQuery({ ...showsQuery(stationId), enabled: open });

  useEffect(() => {
    if (open) {
      setDraft(draftOf(streamer, timezone));
      setErrors({});
      setFormError(null);
    }
  }, [open, streamer, timezone]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const hasExpiry = draft.expiresDate !== '' || draft.expiresTime !== '';
    if (hasExpiry && (!draft.expiresDate || !draft.expiresTime)) {
      setErrors({ expiresAt: [{ message: 'invalid' }] });
      return;
    }
    const expiresAt = hasExpiry
      ? zonedInstant(draft.expiresDate as LocalDate, draft.expiresTime as LocalTime, timezone)
      : null;
    const fields = {
      displayName: draft.displayName,
      username: draft.username,
      userId: draft.userId || null,
      enabled: draft.enabled,
      expiresAt,
      anyTime: draft.anyTime,
      adHoc: draft.adHoc,
      showIds: draft.showIds,
    };
    const body = streamer
      ? fields
      : { ...fields, ...(draft.password ? { password: draft.password } : {}) };
    const parsed = (streamer ? updateStreamerSchema : createStreamerSchema).safeParse(body);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setFormError(null);
    setPending(true);
    try {
      const json = { ...body, expiresAt: expiresAt?.toISOString() ?? null };
      if (streamer) {
        await liveApi.update(stationId, streamer.id, json);
      } else {
        onCreated?.(await liveApi.create(stationId, json));
      }
      await invalidateLive(queryClient, stationId);
      allowLeave();
      onOpenChange(false);
    } catch (error) {
      setFormError(error);
    } finally {
      setPending(false);
    }
  };

  const showList = shows.data?.items ?? [];

  return (
    <>
      {guard}
      <Dialog
        open={open}
        onOpenChange={(next) =>
          next ? onOpenChange(true) : confirmDiscard(() => onOpenChange(false))
        }
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{streamer ? t('form.editTitle') : t('form.newTitle')}</DialogTitle>
            <DialogDescription>{t('form.description')}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <FormAlert error={formError} />
            <Field data-invalid={errors.displayName ? true : undefined}>
              <FieldLabel htmlFor="streamer-name">{t('field.displayName')}</FieldLabel>
              <Input
                id="streamer-name"
                value={draft.displayName}
                onChange={(e) => set('displayName', e.target.value)}
                aria-invalid={errors.displayName ? true : undefined}
                autoFocus
              />
              <FieldError errors={errors.displayName && [{ message: t('field.required') }]} />
            </Field>
            <Field data-invalid={errors.username ? true : undefined}>
              <FieldLabel htmlFor="streamer-username">{t('field.username')}</FieldLabel>
              <Input
                id="streamer-username"
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
                value={draft.username}
                onChange={(e) => set('username', e.target.value.toLowerCase())}
                aria-invalid={errors.username ? true : undefined}
              />
              <FieldDescription>{t('field.usernameHelp')}</FieldDescription>
              <FieldError errors={errors.username && [{ message: t('field.usernameInvalid') }]} />
            </Field>
            {!streamer && (
              <Field data-invalid={errors.password ? true : undefined}>
                <FieldLabel htmlFor="streamer-password">{t('field.password')}</FieldLabel>
                <Input
                  id="streamer-password"
                  type="text"
                  autoComplete="new-password"
                  spellCheck={false}
                  className="font-mono"
                  value={draft.password}
                  onChange={(e) => set('password', e.target.value)}
                  aria-invalid={errors.password ? true : undefined}
                />
                <FieldDescription>{t('field.passwordHelp')}</FieldDescription>
                <FieldError errors={errors.password && [{ message: t('field.passwordInvalid') }]} />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="streamer-user">{t('field.user')}</FieldLabel>
              <NativeSelect
                id="streamer-user"
                value={draft.userId}
                onChange={(e) => set('userId', e.target.value)}
              >
                <NativeSelectOption value="">{t('field.userNone')}</NativeSelectOption>
                {(users.data?.users ?? []).map((u) => (
                  <NativeSelectOption key={u.id} value={u.id}>
                    {u.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>{t('field.userHelp')}</FieldDescription>
            </Field>
            {/* biome-ignore lint/a11y/noLabelWithoutControl: Base UI's checkbox renders the control. */}
            <label className="flex cursor-pointer items-center gap-2">
              <Checkbox checked={draft.enabled} onCheckedChange={(on) => set('enabled', on)} />
              {t('field.enabled')}
            </label>
            <Field data-invalid={errors.expiresAt ? true : undefined}>
              <FieldLabel htmlFor="streamer-expires">{t('field.expires')}</FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="streamer-expires"
                  type="date"
                  value={draft.expiresDate}
                  onChange={(e) => set('expiresDate', e.target.value)}
                  aria-invalid={errors.expiresAt ? true : undefined}
                />
                <Input
                  type="time"
                  aria-label={t('field.expires')}
                  value={draft.expiresTime}
                  onChange={(e) => set('expiresTime', e.target.value)}
                  aria-invalid={errors.expiresAt ? true : undefined}
                />
              </div>
              <FieldDescription>{t('field.expiresHelp')}</FieldDescription>
              <FieldError errors={errors.expiresAt && [{ message: t('field.expiresInvalid') }]} />
            </Field>
            <FieldSet>
              {/* biome-ignore lint/a11y/noLabelWithoutControl: Base UI's checkbox renders the control. */}
              <label className="flex cursor-pointer items-center gap-2">
                <Checkbox checked={draft.anyTime} onCheckedChange={(on) => set('anyTime', on)} />
                {t('field.anyTime')}
              </label>
              <FieldDescription>{t('field.anyTimeHelp')}</FieldDescription>
            </FieldSet>
            <Field>
              <FieldLabel htmlFor="streamer-ad-hoc">{t('field.adHoc')}</FieldLabel>
              <NativeSelect
                id="streamer-ad-hoc"
                value={draft.adHoc}
                onChange={(e) => set('adHoc', e.target.value as LiveAdHocPolicy)}
              >
                <NativeSelectOption value="approval">
                  {t('field.adHoc.approval')}
                </NativeSelectOption>
                <NativeSelectOption value="allowed">{t('field.adHoc.allowed')}</NativeSelectOption>
              </NativeSelect>
              <FieldDescription>{t('field.adHocHelp')}</FieldDescription>
            </Field>
            <FieldSet disabled={draft.anyTime}>
              <FieldLegend variant="label">{t('field.shows')}</FieldLegend>
              {shows.isSuccess && showList.length === 0 ? (
                <FieldDescription>{t('field.noShows')}</FieldDescription>
              ) : (
                <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
                  {showList.map((s) => (
                    // biome-ignore lint/a11y/noLabelWithoutControl: Base UI's checkbox renders the control.
                    <label key={s.id} className="flex cursor-pointer items-center gap-2">
                      <Checkbox
                        disabled={draft.anyTime}
                        checked={draft.showIds.includes(s.id)}
                        onCheckedChange={(on) =>
                          set(
                            'showIds',
                            on
                              ? [...draft.showIds, s.id]
                              : draft.showIds.filter((id) => id !== s.id),
                          )
                        }
                      />
                      <ShowChip show={s} />
                    </label>
                  ))}
                </div>
              )}
            </FieldSet>
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                <DelayedSpinner when={pending} data-icon="inline-start" />
                {streamer ? t('form.save') : t('form.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The password, once: right after creating a streamer or making a new password. */
export function PasswordDialog({
  result,
  onClose,
  copy,
}: {
  result: StreamerWithPassword | null;
  onClose(): void;
  copy(value: string): void;
}) {
  const t = useLiveT();
  return (
    <Dialog open={result !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t('password.title', { username: result?.streamer.username ?? '' })}
          </DialogTitle>
          <DialogDescription>{t('password.description')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Input
            readOnly
            className="font-mono"
            value={result?.password ?? ''}
            aria-label={t('field.password')}
          />
          <Button variant="outline" onClick={() => result && copy(result.password)}>
            {t('connection.copy')}
          </Button>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>{t('password.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

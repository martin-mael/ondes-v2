import { createShowSchema, type Show, updateShowSchema } from '@ondes/shared';
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
import { Textarea } from '@/ui/textarea';
import { type FieldErrors, FormAlert, fieldErrors } from '../../app/forms.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { hostCandidatesQuery, invalidateShows, showsApi } from './api.ts';
import { useShowT } from './messages.ts';

// Create or edit a show. Hosts are offered to `show:write` only (the api refuses the field to
// hosts editing their own show).

interface Draft {
  name: string;
  description: string;
  artworkUrl: string;
  colour: string | null;
  durationMin: string;
  defaultSlotType: 'prerecorded' | 'live';
  tags: string;
  hostUserIds: string[];
}

const draftOf = (show: Show | undefined): Draft => ({
  name: show?.name ?? '',
  description: show?.description ?? '',
  artworkUrl: show?.artworkUrl ?? '',
  colour: show?.colour ?? null,
  durationMin: show?.defaultDurationMs ? String(show.defaultDurationMs / 60_000) : '60',
  defaultSlotType: show?.defaultSlotType ?? 'prerecorded',
  tags: show?.tags.join(', ') ?? '',
  hostUserIds: show?.hosts.map((h) => h.userId) ?? [],
});

export function ShowFormDialog({
  stationId,
  show,
  open,
  onOpenChange,
  canManage,
  onSaved,
}: {
  stationId: string;
  /** Absent: a new show. */
  show?: Show;
  open: boolean;
  onOpenChange(open: boolean): void;
  canManage: boolean;
  onSaved?(show: Show): void;
}) {
  const t = useShowT();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>(() => draftOf(show));
  // Closing the dialog, or leaving the page, with changes asks first.
  const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(
    open && JSON.stringify(draft) !== JSON.stringify(draftOf(show)),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const hosts = useQuery({ ...hostCandidatesQuery(stationId), enabled: open && canManage });

  useEffect(() => {
    if (open) {
      setDraft(draftOf(show));
      setErrors({});
      setFormError(null);
    }
  }, [open, show]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const minutes = Number(draft.durationMin);
    const body = {
      name: draft.name,
      description: draft.description.trim() || null,
      artworkUrl: draft.artworkUrl.trim() || null,
      colour: draft.colour,
      defaultDurationMs: draft.durationMin.trim() && minutes > 0 ? minutes * 60_000 : null,
      defaultSlotType: draft.defaultSlotType,
      tags: draft.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      ...(canManage ? { hostUserIds: draft.hostUserIds } : {}),
    };
    const parsed = (show ? updateShowSchema : createShowSchema).safeParse(body);
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setFormError(null);
    setPending(true);
    try {
      const saved = show
        ? await showsApi.update(stationId, show.id, body)
        : await showsApi.create(stationId, body);
      await invalidateShows(queryClient, stationId);
      allowLeave();
      onOpenChange(false);
      onSaved?.(saved);
    } catch (error) {
      setFormError(error);
    } finally {
      setPending(false);
    }
  };

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
            <DialogTitle>{show ? t('form.editTitle') : t('form.newTitle')}</DialogTitle>
            <DialogDescription>{t('form.description')}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <FormAlert error={formError} />
            <Field data-invalid={errors.name ? true : undefined}>
              <FieldLabel htmlFor="show-name">{t('field.name')}</FieldLabel>
              <Input
                id="show-name"
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
                aria-invalid={errors.name ? true : undefined}
                autoFocus
              />
              <FieldError errors={errors.name && [{ message: t('field.required') }]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="show-description">{t('field.description')}</FieldLabel>
              <Textarea
                id="show-description"
                rows={3}
                value={draft.description}
                onChange={(e) => set('description', e.target.value)}
              />
            </Field>
            <Field data-invalid={errors.artworkUrl ? true : undefined}>
              <FieldLabel htmlFor="show-artwork">{t('field.artworkUrl')}</FieldLabel>
              <Input
                id="show-artwork"
                type="url"
                inputMode="url"
                placeholder="https://"
                value={draft.artworkUrl}
                onChange={(e) => set('artworkUrl', e.target.value)}
                aria-invalid={errors.artworkUrl ? true : undefined}
              />
              <FieldDescription>{t('field.artworkHelp')}</FieldDescription>
              <FieldError errors={errors.artworkUrl && [{ message: t('field.artworkInvalid') }]} />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field>
                <FieldLabel htmlFor="show-duration">{t('field.defaultDuration')}</FieldLabel>
                <Input
                  id="show-duration"
                  type="number"
                  min={1}
                  max={1440}
                  inputMode="numeric"
                  value={draft.durationMin}
                  onChange={(e) => set('durationMin', e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="show-type">{t('field.defaultSlotType')}</FieldLabel>
                <NativeSelect
                  id="show-type"
                  value={draft.defaultSlotType}
                  onChange={(e) =>
                    set('defaultSlotType', e.target.value as Draft['defaultSlotType'])
                  }
                >
                  <NativeSelectOption value="prerecorded">
                    {t('type.prerecorded')}
                  </NativeSelectOption>
                  <NativeSelectOption value="live">{t('type.live')}</NativeSelectOption>
                </NativeSelect>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="show-colour">{t('field.colour')}</FieldLabel>
              <div className="flex items-center gap-3">
                <input
                  id="show-colour"
                  type="color"
                  className="h-8 w-12 cursor-pointer rounded border border-border bg-transparent"
                  value={draft.colour ?? '#888888'}
                  onChange={(e) => set('colour', e.target.value)}
                />
                {draft.colour ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => set('colour', null)}
                  >
                    {t('field.colourClear')}
                  </Button>
                ) : (
                  <span className="text-muted-foreground">{t('field.colourNone')}</span>
                )}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="show-tags">{t('field.tags')}</FieldLabel>
              <Input
                id="show-tags"
                value={draft.tags}
                onChange={(e) => set('tags', e.target.value)}
              />
              <FieldDescription>{t('field.tagsHelp')}</FieldDescription>
            </Field>
            {canManage && (
              <FieldSet>
                <FieldLegend variant="label">{t('field.hosts')}</FieldLegend>
                <FieldDescription>{t('field.hostsHelp')}</FieldDescription>
                <div className="flex max-h-48 flex-col gap-2 overflow-y-auto">
                  {hosts.data?.items.map((host) => (
                    // biome-ignore lint/a11y/noLabelWithoutControl: Base UI's checkbox renders the control.
                    <label key={host.userId} className="flex cursor-pointer items-center gap-2">
                      <Checkbox
                        checked={draft.hostUserIds.includes(host.userId)}
                        onCheckedChange={(on) =>
                          set(
                            'hostUserIds',
                            on
                              ? [...draft.hostUserIds, host.userId]
                              : draft.hostUserIds.filter((id) => id !== host.userId),
                          )
                        }
                      />
                      {host.name}
                    </label>
                  ))}
                </div>
              </FieldSet>
            )}
            <DialogFooter>
              <Button type="submit" disabled={pending}>
                {show ? t('form.save') : t('form.create')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

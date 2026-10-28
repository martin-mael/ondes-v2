import {
  type LiveRecordingSettings,
  rolePermissions,
  type UpdateLiveRecordingSettings,
} from '@ondes/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from '@tanstack/react-router';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Checkbox } from '@/ui/checkbox';
import { Field, FieldDescription, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { findStation, useOrgs } from '../../../app/auth/session.ts';
import { FormAlert } from '../../../app/forms.tsx';
import { Page, PageHeader } from '../../../app/page-header.tsx';
import { DelayedSpinner, PageSkeleton } from '../../../app/pending.tsx';
import { useUnsavedChanges } from '../../../app/unsaved.tsx';
import { liveRecordingApi, liveRecordingSettingsQuery } from './api.ts';
import { useLiveRecordingT } from './messages.ts';

// Station settings: live recording (#67, ADR 0039). Whether live shows are recorded into their
// episodes, and how long their audio is kept.

const PRESETS = ['30', '90', '180', '365'] as const;
type Choice = 'forever' | (typeof PRESETS)[number] | 'custom';

type Draft = { enabled: boolean; choice: Choice; customDays: string };

function draftOf(settings: LiveRecordingSettings): Draft {
  const days = settings.retentionDays;
  if (days === null) return { enabled: settings.enabled, choice: 'forever', customDays: '' };
  const preset = PRESETS.find((p) => Number(p) === days);
  return preset
    ? { enabled: settings.enabled, choice: preset, customDays: '' }
    : { enabled: settings.enabled, choice: 'custom', customDays: String(days) };
}

/** The retention the draft asks for; undefined while a custom number isn't valid. */
function retentionOf(draft: Draft): number | null | undefined {
  if (draft.choice === 'forever') return null;
  if (draft.choice !== 'custom') return Number(draft.choice);
  const days = Number(draft.customDays);
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : undefined;
}

export function LiveRecordingPage() {
  const t = useLiveRecordingT();
  const { stationId } = useParams({ from: '/_app/stations/$stationId/settings/live-recording' });
  const station = findStation(useOrgs(), stationId)?.station;
  const canEdit = station ? rolePermissions[station.role].includes('live:manage') : false;
  const queryClient = useQueryClient();
  const query = useQuery(liveRecordingSettingsQuery(stationId));
  const [draft, setDraft] = useState<Draft | null>(null);
  useEffect(() => {
    if (query.data) setDraft(draftOf(query.data));
  }, [query.data]);
  const saved = query.data ? draftOf(query.data) : null;
  const dirty = !!draft && !!saved && JSON.stringify(draft) !== JSON.stringify(saved);
  const { guard } = useUnsavedChanges(dirty);
  const save = useMutation({
    mutationFn: (body: UpdateLiveRecordingSettings) =>
      liveRecordingApi.updateSettings(stationId, body),
    onSuccess: (data) => {
      queryClient.setQueryData(liveRecordingSettingsQuery(stationId).queryKey, data);
      toast.success(t('saved'));
    },
  });

  if (query.isError && !query.data) {
    return (
      <Page width="form" header={<PageHeader title={t('title')} />}>
        <FormAlert error={query.error} />
      </Page>
    );
  }
  if (query.isPending || !draft) return <PageSkeleton />;
  const retention = retentionOf(draft);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    // An unfinished custom number never blocks the save: the rest is saved, the retention kept.
    save.mutate({
      enabled: draft.enabled,
      ...(retention === undefined ? {} : { retentionDays: retention }),
    });
  };

  return (
    <Page width="form" header={<PageHeader title={t('title')} description={t('description')} />}>
      {!canEdit && <p className="text-sm text-muted-foreground">{t('readOnly')}</p>}
      <Card className="max-w-2xl">
        <CardContent>
          <form className="flex flex-col gap-5" onSubmit={submit}>
            <Field orientation="horizontal">
              <Checkbox
                id="live-recording-enabled"
                checked={draft.enabled}
                disabled={!canEdit}
                onCheckedChange={(checked) => setDraft({ ...draft, enabled: checked === true })}
              />
              <div className="flex flex-col gap-1">
                <FieldLabel htmlFor="live-recording-enabled">{t('enabled.label')}</FieldLabel>
                <FieldDescription>{t('enabled.hint')}</FieldDescription>
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="live-recording-retention">{t('retention.label')}</FieldLabel>
              <NativeSelect
                id="live-recording-retention"
                value={draft.choice}
                disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, choice: e.target.value as Choice })}
              >
                <NativeSelectOption value="forever">{t('retention.forever')}</NativeSelectOption>
                {PRESETS.map((days) => (
                  <NativeSelectOption key={days} value={days}>
                    {t('retention.days', { days })}
                  </NativeSelectOption>
                ))}
                <NativeSelectOption value="custom">{t('retention.custom')}</NativeSelectOption>
              </NativeSelect>
              <FieldDescription>{t('retention.hint')}</FieldDescription>
            </Field>
            {draft.choice === 'custom' && (
              <Field>
                <FieldLabel htmlFor="live-recording-days">{t('retention.customLabel')}</FieldLabel>
                <Input
                  id="live-recording-days"
                  className="max-w-32"
                  inputMode="numeric"
                  value={draft.customDays}
                  disabled={!canEdit}
                  onChange={(e) => setDraft({ ...draft, customDays: e.target.value })}
                />
                {retention === undefined && (
                  <FieldDescription className="text-amber-700 dark:text-amber-400">
                    {t('retention.invalid')}
                  </FieldDescription>
                )}
              </Field>
            )}
            {save.isError && <FormAlert error={save.error} />}
            {canEdit && (
              <div>
                <Button type="submit" disabled={!dirty || save.isPending}>
                  <DelayedSpinner when={save.isPending} />
                  {t('save')}
                </Button>
              </div>
            )}
          </form>
        </CardContent>
      </Card>
      {guard}
    </Page>
  );
}

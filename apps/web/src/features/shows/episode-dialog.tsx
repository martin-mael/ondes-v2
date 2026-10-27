import {
  type Episode,
  type EpisodeKind,
  type EpisodeStatus,
  localDateOf,
  rolePermissions,
  type Show,
  type ShowOccurrence,
  type UpdateEpisode,
} from '@ondes/shared';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Textarea } from '@/ui/textarea';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { EpisodeRecording } from '../settings/live-recording/episode-recording.tsx';
import { invalidateShows, showsApi } from './api.ts';
import { EpisodeAssetPicker } from './asset-picker.tsx';
import { formatDay, formatTime } from './format.ts';
import { useShowError, useShowT } from './messages.ts';
import { AUDIO_ACCEPT, useEpisodeUpload, useUploadProgress } from './upload.ts';

// Create or edit an episode: number (renumbering), title, kind, the occurrence it premieres in,
// and its audio (upload a file or attach a library asset).

const statusVariant: Record<EpisodeStatus, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  planned: 'outline',
  ready: 'default',
  aired: 'secondary',
  missing: 'destructive',
};

export function EpisodeStatusBadge({
  status,
  episodeId,
}: {
  status: EpisodeStatus;
  episodeId?: string;
}) {
  const t = useShowT();
  const progress = useUploadProgress(episodeId);
  if (progress) {
    return (
      <Badge variant="secondary">
        {progress.phase === 'uploading'
          ? t('status.uploading', { pct: progress.pct })
          : t('status.processing')}
      </Badge>
    );
  }
  return <Badge variant={statusVariant[status]}>{t(`status.${status}`)}</Badge>;
}

/** `slotId|date`: an occurrence's identity, as a select value. */
export const occurrenceKey = (o: { slotId: string; date: string }) => `${o.slotId}|${o.date}`;

/** Upload button: a hidden file input behind a button. */
export function UploadAudioButton({
  onFile,
  label,
  disabled,
  variant = 'outline',
}: {
  onFile(file: File): void;
  label: string;
  disabled?: boolean;
  variant?: 'outline' | 'default' | 'secondary';
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={AUDIO_ACCEPT}
        className="hidden"
        aria-label={label}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) onFile(file);
        }}
      />
      <Button
        type="button"
        size="sm"
        variant={variant}
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        {label}
      </Button>
    </>
  );
}

export function EpisodeDialog({
  stationId,
  show,
  episode,
  occurrences,
  timezone,
  canSearchLibrary,
  open,
  onOpenChange,
  initialOccurrence,
}: {
  stationId: string;
  show: Show;
  /** Absent: a new episode. */
  episode?: Episode;
  /** Upcoming occurrences of the show, to plan the episode in. */
  occurrences: ShowOccurrence[];
  timezone: string;
  canSearchLibrary: boolean;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** For a new episode: the occurrence it is created for. */
  initialOccurrence?: ShowOccurrence;
}) {
  const t = useShowT();
  const { locale } = useI18n();
  const showError = useShowError();
  const queryClient = useQueryClient();
  const upload = useEpisodeUpload(stationId);
  // A live episode's recording (#67): managers may process it again.
  const role = findStation(useOrgs(), stationId)?.station.role;
  const canRebuildRecording = role ? rolePermissions[role].includes('live:manage') : false;
  const [number, setNumber] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<EpisodeKind>('prerecorded');
  const [planned, setPlanned] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  // The fields as the dialog opened: closing it, or leaving the page, with changes asks first.
  const [initial, setInitial] = useState<string | null>(null);
  const fields = JSON.stringify({ number, title, description, kind, planned });
  const { guard, confirmDiscard } = useUnsavedChanges(
    open && initial !== null && fields !== initial,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the dialog opens.
  useEffect(() => {
    if (!open) return;
    const values = {
      number: episode ? String(episode.number) : '',
      title: episode?.title ?? '',
      description: episode?.description ?? '',
      kind: episode?.kind ?? (initialOccurrence?.type === 'live' ? 'live' : 'prerecorded'),
      planned:
        episode?.slotId && episode.occurrenceDate
          ? occurrenceKey({ slotId: episode.slotId, date: episode.occurrenceDate })
          : initialOccurrence
            ? occurrenceKey(initialOccurrence)
            : '',
    } as const;
    setNumber(values.number);
    setTitle(values.title);
    setDescription(values.description);
    setKind(values.kind);
    setPlanned(values.planned);
    setInitial(JSON.stringify(values));
    setError(null);
  }, [open]);

  // Free occurrences, plus the one this episode is in (it may be past the list's range).
  const choices = occurrences.filter(
    (o) => o.type !== 'rerun' && (!o.episode || o.episode.id === episode?.id),
  );
  const current = planned && !choices.some((o) => occurrenceKey(o) === planned) ? planned : null;

  const save = async (body: UpdateEpisode) => {
    setPending(true);
    setError(null);
    try {
      if (episode) await showsApi.updateEpisode(stationId, show.id, episode.id, body);
      else await showsApi.createEpisode(stationId, show.id, body);
      await invalidateShows(queryClient, stationId);
      return true;
    } catch (e) {
      setError(showError(e));
      return false;
    } finally {
      setPending(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const n = number.trim() ? Number(number) : undefined;
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) {
      setError(t('episode.numberInvalid'));
      return;
    }
    const [slotId, occurrenceDate] = planned ? planned.split('|') : [null, null];
    const ok = await save({
      ...(n !== undefined ? { number: n } : {}),
      title: title.trim() || null,
      description: description.trim() || null,
      kind,
      slotId: slotId ?? null,
      occurrenceDate: occurrenceDate ?? null,
    });
    if (ok) {
      toast.success(episode ? t('episode.saved') : t('episode.created'));
      onOpenChange(false);
    }
  };

  const label = (o: ShowOccurrence) =>
    `${formatDay(localDateOf(o.startsAt, timezone), locale)} ${formatTime(o.startsAt, timezone, locale)}${o.type === 'live' ? ` · ${t('type.live')}` : ''}`;

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
            <DialogTitle>
              {episode ? t('episode.editTitle', { number: episode.number }) : t('episode.newTitle')}
            </DialogTitle>
            <DialogDescription>{show.name}</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
            <div className="grid grid-cols-[6rem_1fr] gap-4">
              <Field data-invalid={error === t('episode.numberInvalid') ? true : undefined}>
                <FieldLabel htmlFor="episode-number">{t('episode.number')}</FieldLabel>
                <Input
                  id="episode-number"
                  type="number"
                  min={1}
                  inputMode="numeric"
                  placeholder={String(show.nextEpisodeNumber)}
                  value={number}
                  onChange={(e) => setNumber(e.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="episode-title">{t('episode.title')}</FieldLabel>
                <Input
                  id="episode-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </Field>
            </div>
            {!episode && <FieldDescription>{t('episode.numberHelp')}</FieldDescription>}
            <Field>
              <FieldLabel htmlFor="episode-description">{t('episode.description')}</FieldLabel>
              <Textarea
                id="episode-description"
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="episode-kind">{t('episode.kind')}</FieldLabel>
                <NativeSelect
                  id="episode-kind"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as EpisodeKind)}
                >
                  <NativeSelectOption value="prerecorded">
                    {t('type.prerecorded')}
                  </NativeSelectOption>
                  <NativeSelectOption value="live">{t('type.live')}</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="episode-occurrence">{t('episode.occurrence')}</FieldLabel>
                <NativeSelect
                  id="episode-occurrence"
                  value={planned}
                  onChange={(e) => setPlanned(e.target.value)}
                >
                  <NativeSelectOption value="">{t('episode.unscheduled')}</NativeSelectOption>
                  {current && (
                    <NativeSelectOption value={current}>
                      {formatDay(current.split('|')[1] ?? '', locale)}
                    </NativeSelectOption>
                  )}
                  {choices.map((o) => (
                    <NativeSelectOption key={occurrenceKey(o)} value={occurrenceKey(o)}>
                      {label(o)}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            </div>

            {episode && (
              <section className="flex flex-col gap-2 rounded-lg bg-muted/50 p-3">
                <div className="flex items-center gap-2">
                  <h3 className="font-medium">{t('episode.audio')}</h3>
                  <EpisodeStatusBadge status={episode.status} episodeId={episode.id} />
                </div>
                <p className="text-muted-foreground">
                  {episode.assetId ? t('episode.hasAudio') : t('episode.noAudio')}
                </p>
                <div className="flex flex-wrap gap-2">
                  <UploadAudioButton
                    label={episode.assetId ? t('episode.replaceAudio') : t('episode.uploadAudio')}
                    disabled={pending}
                    onFile={(file) => {
                      onOpenChange(false);
                      void upload({ showId: show.id, episodeId: episode.id }, file);
                    }}
                  />
                  {canSearchLibrary && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() => setPicking(true)}
                    >
                      {t('episode.attachAsset')}
                    </Button>
                  )}
                  {episode.assetId && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      disabled={pending}
                      onClick={() => save({ assetId: null })}
                    >
                      {t('episode.removeAudio')}
                    </Button>
                  )}
                </div>
              </section>
            )}

            {episode?.kind === 'live' && (
              <EpisodeRecording
                stationId={stationId}
                showId={show.id}
                episodeId={episode.id}
                timezone={timezone}
                canRebuild={canRebuildRecording}
              />
            )}

            <FieldError errors={error ? [{ message: error }] : undefined} />
            <DialogFooter>
              {episode && (
                <Button
                  type="button"
                  variant="destructive"
                  className="sm:mr-auto"
                  disabled={pending}
                  onClick={async () => {
                    if (!window.confirm(t('episode.deleteConfirm'))) return;
                    setPending(true);
                    try {
                      await showsApi.removeEpisode(stationId, show.id, episode.id);
                      await invalidateShows(queryClient, stationId);
                      toast.success(t('episode.deleted'));
                      onOpenChange(false);
                    } catch (e) {
                      setError(showError(e));
                    } finally {
                      setPending(false);
                    }
                  }}
                >
                  {t('episode.delete')}
                </Button>
              )}
              <Button type="submit" disabled={pending}>
                {episode ? t('form.save') : t('episode.create')}
              </Button>
            </DialogFooter>
          </form>
          {episode && (
            <EpisodeAssetPicker
              stationId={stationId}
              open={picking}
              onOpenChange={setPicking}
              pending={pending}
              onPick={async (assetId) => {
                if (await save({ assetId })) {
                  setPicking(false);
                  toast.success(t('episode.attached'));
                }
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

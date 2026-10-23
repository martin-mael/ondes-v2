import { localDateOf, type ShowConflict, type ShowOccurrence, zonedParts } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { CircleAlertIcon } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/ui/alert';
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
import { Field, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Separator } from '@/ui/separator';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { episodesQuery, invalidateShows, showsApi } from './api.ts';
import { EpisodeStatusBadge, UploadAudioButton } from './episode-dialog.tsx';
import { formatDay, formatDuration, formatTime } from './format.ts';
import { useShowError, useShowT } from './messages.ts';
import { RerunOf } from './rerun-dialog.tsx';
import { useEpisodeUpload } from './upload.ts';

// One calendar entry: an occurrence (its episode, audio, move, cancel) or a cancelled one
// (restore). Moves and cancellations are slot exceptions: `show:write` only.

export interface CancelledEntry {
  showId: string;
  showName: string;
  slotId: string;
  date: string;
  startsAt: Date;
  endsAt: Date;
}

export type CalendarSelection =
  | { kind: 'occurrence'; occurrence: ShowOccurrence; conflicts: ShowConflict[] }
  | { kind: 'cancelled'; entry: CancelledEntry }
  | null;

/** Toast for episodes detached by a slot exception, with a way to plan them again. */
export function useDetachedNotice(stationId: string) {
  const t = useShowT();
  const navigate = useNavigate();
  return (showId: string, detachedEpisodeIds: string[]) => {
    if (detachedEpisodeIds.length === 0) return;
    toast.warning(t('detached.title', { count: detachedEpisodeIds.length }), {
      description: t('detached.toast'),
      duration: 10_000,
      action: {
        label: t('detached.open'),
        onClick: () =>
          void navigate({
            to: '/stations/$stationId/shows/$showId',
            params: { stationId, showId },
          }),
      },
    });
  };
}

export function OccurrenceDialog({
  stationId,
  selection,
  onClose,
  timezone,
  canManage,
  canEdit,
  showNames,
}: {
  stationId: string;
  selection: CalendarSelection;
  onClose(): void;
  timezone: string;
  canManage: boolean;
  canEdit(showId: string): boolean;
  /** Show names by slot id, for conflicts. */
  showNames: Map<string, string>;
}) {
  const t = useShowT();
  const { locale } = useI18n();
  const showError = useShowError();
  const queryClient = useQueryClient();
  const upload = useEpisodeUpload(stationId);
  const detachedNotice = useDetachedNotice(stationId);
  const [pending, setPending] = useState(false);
  const [moveDate, setMoveDate] = useState('');
  const [moveTime, setMoveTime] = useState('');
  const [moveDuration, setMoveDuration] = useState('');

  const occurrence = selection?.kind === 'occurrence' ? selection.occurrence : null;
  const showId =
    selection?.kind === 'occurrence' ? selection.occurrence.show.id : selection?.entry.showId;
  const editable = showId ? canEdit(showId) : false;
  const unscheduled = useQuery({
    ...episodesQuery(stationId, showId ?? '', false),
    enabled: Boolean(occurrence && !occurrence.episode && editable && occurrence.type !== 'rerun'),
  });

  const toPlan = (unscheduled.data?.items ?? []).filter((e) => e.slotId === null);

  useEffect(() => {
    if (!occurrence) return;
    const start = zonedParts(occurrence.startsAt, timezone);
    setMoveDate(start.date);
    setMoveTime(start.time);
    setMoveDuration(String(Math.round(occurrence.durationMs / 60_000)));
  }, [occurrence, timezone]);

  const act = async (action: () => Promise<unknown>, done: string, close = true) => {
    setPending(true);
    try {
      const result = await action();
      toast.success(done);
      if (showId && result && typeof result === 'object' && 'detachedEpisodeIds' in result) {
        detachedNotice(showId, result.detachedEpisodeIds as string[]);
      }
      if (close) onClose();
    } catch (error) {
      toast.error(showError(error));
    } finally {
      await invalidateShows(queryClient, stationId);
      setPending(false);
    }
  };

  const move = (event: FormEvent) => {
    event.preventDefault();
    if (!occurrence) return;
    const minutes = Number(moveDuration);
    void act(
      () =>
        showsApi.putException(stationId, occurrence.show.id, occurrence.slotId, occurrence.date, {
          kind: 'moved',
          startDate: moveDate,
          startTime: moveTime,
          durationMs:
            minutes > 0 && minutes * 60_000 !== occurrence.durationMs ? minutes * 60_000 : null,
        }),
      t('occurrence.movedDone'),
    );
  };

  const title =
    selection?.kind === 'occurrence' ? selection.occurrence.show.name : selection?.entry.showName;
  const startsAt =
    occurrence?.startsAt ?? (selection?.kind === 'cancelled' ? selection.entry.startsAt : null);
  const endsAt =
    occurrence?.endsAt ?? (selection?.kind === 'cancelled' ? selection.entry.endsAt : null);

  return (
    <Dialog open={selection !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {startsAt && endsAt && (
              <>
                {formatDay(localDateOf(startsAt, timezone), locale, { year: 'numeric' })},{' '}
                {formatTime(startsAt, timezone, locale)}–{formatTime(endsAt, timezone, locale)}
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {selection?.kind === 'cancelled' && (
          <>
            <p>{t('occurrence.cancelledHelp')}</p>
            {canManage && (
              <DialogFooter>
                <Button
                  disabled={pending}
                  onClick={() =>
                    act(
                      () =>
                        showsApi.removeException(
                          stationId,
                          selection.entry.showId,
                          selection.entry.slotId,
                          selection.entry.date,
                        ),
                      t('occurrence.restored'),
                    )
                  }
                >
                  {t('exception.restore')}
                </Button>
              </DialogFooter>
            )}
          </>
        )}

        {occurrence && selection?.kind === 'occurrence' && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-1">
              <Badge variant="outline">{t(`type.${occurrence.type}`)}</Badge>
              <Badge variant="outline">{formatDuration(occurrence.durationMs)}</Badge>
              {occurrence.moved && (
                <Badge variant="secondary">
                  {t('occurrence.movedFrom', { date: formatDay(occurrence.date, locale) })}
                </Badge>
              )}
            </div>

            {selection.conflicts.length > 0 && (
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertDescription>
                  {selection.conflicts.map((c) => {
                    const other =
                      c.a.slotId === occurrence.slotId && c.a.date === occurrence.date ? c.b : c.a;
                    return (
                      <p key={`${other.slotId}|${other.date}`}>
                        {t('conflict.with', {
                          show: showNames.get(other.slotId) ?? '?',
                          duration: formatDuration(c.overlapMs),
                        })}
                      </p>
                    );
                  })}
                </AlertDescription>
              </Alert>
            )}

            <section className="flex flex-col gap-2">
              <h3 className="font-medium">{t('occurrence.episode')}</h3>
              {occurrence.episode ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    {t('episode.label', { number: occurrence.episode.number })}
                    {occurrence.episode.title ? ` · ${occurrence.episode.title}` : ''}
                  </span>
                  <EpisodeStatusBadge
                    status={occurrence.episode.status}
                    episodeId={occurrence.episode.id}
                  />
                  {editable && occurrence.episode.kind === 'prerecorded' && (
                    <UploadAudioButton
                      label={
                        occurrence.episode.assetId
                          ? t('episode.replaceAudio')
                          : t('episode.uploadAudio')
                      }
                      onFile={(file) => {
                        const episodeId = occurrence.episode?.id;
                        if (!episodeId) return;
                        onClose();
                        void upload({ showId: occurrence.show.id, episodeId }, file);
                      }}
                    />
                  )}
                </div>
              ) : occurrence.type === 'rerun' ? (
                <p>
                  <RerunOf occurrence={occurrence} />
                </p>
              ) : editable ? (
                <div className="flex flex-wrap items-center gap-2">
                  {occurrence.type === 'prerecorded' && (
                    <UploadAudioButton
                      variant="default"
                      label={t('episode.uploadAudio')}
                      onFile={(file) => {
                        onClose();
                        void upload(
                          {
                            showId: occurrence.show.id,
                            slotId: occurrence.slotId,
                            occurrenceDate: occurrence.date,
                          },
                          file,
                        );
                      }}
                    />
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      act(
                        () =>
                          showsApi.createEpisode(stationId, occurrence.show.id, {
                            slotId: occurrence.slotId,
                            occurrenceDate: occurrence.date,
                          }),
                        t('episode.created'),
                        false,
                      )
                    }
                  >
                    {t('occurrence.createEpisode')}
                  </Button>
                  {toPlan.length > 0 && (
                    <NativeSelect
                      size="sm"
                      aria-label={t('upcoming.assign')}
                      value=""
                      disabled={pending}
                      onChange={(e) => {
                        const id = e.target.value;
                        if (!id) return;
                        void act(
                          () =>
                            showsApi.updateEpisode(stationId, occurrence.show.id, id, {
                              slotId: occurrence.slotId,
                              occurrenceDate: occurrence.date,
                            }),
                          t('unscheduled.plannedShort'),
                          false,
                        );
                      }}
                    >
                      <NativeSelectOption value="">{t('upcoming.assign')}</NativeSelectOption>
                      {toPlan.map((e) => (
                        <NativeSelectOption key={e.id} value={e.id}>
                          {t('episode.label', { number: e.number })}
                          {e.title ? ` · ${e.title}` : ''}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                </div>
              ) : (
                <p className="text-muted-foreground">{t('upcoming.noEpisode')}</p>
              )}
              <Link
                to="/stations/$stationId/shows/$showId"
                params={{ stationId, showId: occurrence.show.id }}
                className="text-primary hover:underline"
              >
                {t('occurrence.openShow')}
              </Link>
            </section>

            {canManage && (
              <>
                <Separator />
                <form className="flex flex-col gap-3" onSubmit={move}>
                  <h3 className="font-medium">{t('occurrence.move')}</h3>
                  <div className="grid grid-cols-3 gap-2">
                    <Field>
                      <FieldLabel htmlFor="move-date">{t('slot.date')}</FieldLabel>
                      <Input
                        id="move-date"
                        type="date"
                        value={moveDate}
                        onChange={(e) => setMoveDate(e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="move-time">{t('slot.time')}</FieldLabel>
                      <Input
                        id="move-time"
                        type="time"
                        value={moveTime}
                        onChange={(e) => setMoveTime(e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="move-duration">{t('slot.duration')}</FieldLabel>
                      <Input
                        id="move-duration"
                        type="number"
                        min={1}
                        inputMode="numeric"
                        value={moveDuration}
                        onChange={(e) => setMoveDuration(e.target.value)}
                      />
                    </Field>
                  </div>
                  <p className="text-muted-foreground">{t('occurrence.moveHelp')}</p>
                  <DialogFooter>
                    {occurrence.moved && (
                      <Button
                        type="button"
                        variant="ghost"
                        disabled={pending}
                        onClick={() =>
                          act(
                            () =>
                              showsApi.removeException(
                                stationId,
                                occurrence.show.id,
                                occurrence.slotId,
                                occurrence.date,
                              ),
                            t('occurrence.restored'),
                          )
                        }
                      >
                        {t('occurrence.undoMove')}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="destructive"
                      disabled={pending}
                      onClick={() => {
                        if (!window.confirm(t('occurrence.cancelConfirm'))) return;
                        void act(
                          () =>
                            showsApi.putException(
                              stationId,
                              occurrence.show.id,
                              occurrence.slotId,
                              occurrence.date,
                              { kind: 'cancelled' },
                            ),
                          t('occurrence.cancelledDone'),
                        );
                      }}
                    >
                      {t('occurrence.cancel')}
                    </Button>
                    <Button type="submit" disabled={pending}>
                      {t('occurrence.moveSubmit')}
                    </Button>
                  </DialogFooter>
                </form>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { type Episode, localDateOf, type ShowOccurrence, type ShowSlot } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import {
  CalendarDaysIcon,
  CircleAlertIcon,
  PencilIcon,
  PlusIcon,
  RadioIcon,
  Repeat2Icon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/ui/table';
import { isApiError } from '../../app/api/client.ts';
import { FormAlert } from '../../app/forms.tsx';
import { useI18n } from '../../app/i18n/i18n.tsx';
import { BackButton, Page, PageHeader } from '../../app/page-header.tsx';
import { ListSkeleton, PageSkeleton } from '../../app/pending.tsx';
import { type ShowAccess, useShowAccess } from './access.ts';
import {
  episodesQuery,
  invalidateShows,
  occurrencesQuery,
  showQuery,
  showsApi,
  slotsQuery,
} from './api.ts';
import {
  EpisodeDialog,
  EpisodeStatusBadge,
  occurrenceKey,
  UploadAudioButton,
} from './episode-dialog.tsx';
import { formatDay, formatDuration, formatTime, ruleSummary } from './format.ts';
import { useShowError, useShowT } from './messages.ts';
import { canScheduleRerun, RerunDialog, RerunOf } from './rerun-dialog.tsx';
import { ShowFormDialog } from './show-form.tsx';
import { ShowArtwork } from './shows-page.tsx';
import { SlotEditorDialog } from './slot-editor.tsx';
import { useEpisodeUpload } from './upload.ts';

const route = getRouteApi('/_app/stations/$stationId/shows/$showId');

const DAY_MS = 24 * 3600 * 1000;
/** How far ahead "upcoming airings" looks. */
const UPCOMING_DAYS = 56;
/** "Create the missing episodes" covers airings from now to two weeks ahead. */
const PLAN_AHEAD_DAYS = 14;

/** Dialogs hold ids: what they show is read from the queries, so it stays fresh after writes. */
type EpisodeEdit = { episodeId?: string; occurrence?: ShowOccurrence } | null;

export function ShowPage() {
  const t = useShowT();
  const { stationId, showId } = route.useParams();
  const access = useShowAccess(stationId);
  const show = useQuery(showQuery(stationId, showId));
  // Start of today: today's airings stay listed until tomorrow.
  const [from] = useState(() => new Date(Math.floor(Date.now() / 60_000) * 60_000 - DAY_MS / 2));
  const to = useMemo(() => new Date(from.getTime() + UPCOMING_DAYS * DAY_MS), [from]);
  const occurrences = useQuery(occurrencesQuery(stationId, from, to, showId));
  const slots = useQuery(slotsQuery(stationId, showId));
  const episodes = useQuery(episodesQuery(stationId, showId));
  const unscheduled = useQuery(episodesQuery(stationId, showId, false));
  const [detached, setDetached] = useState<string[]>([]);
  const [editingShow, setEditingShow] = useState(false);
  const [slotEdit, setSlotEdit] = useState<{ slotId?: string } | null>(null);
  const [episodeEdit, setEpisodeEdit] = useState<EpisodeEdit>(null);
  const [rerunOf, setRerunOf] = useState<string | null>(null);

  if (show.isPending) return <PageSkeleton />;
  if (show.isError) {
    return (
      <div className="p-6">
        {isApiError(show.error, 'not_found') ? (
          <p className="text-sm text-muted-foreground">{t('show.notFound')}</p>
        ) : (
          <FormAlert error={show.error} />
        )}
      </div>
    );
  }
  const data = show.data;
  const canEdit = access.canEdit(data);
  const upcoming = occurrences.data?.occurrences ?? [];
  const detachedEpisodes = (episodes.data?.items ?? []).filter((e) => detached.includes(e.id));
  const toPlan = (unscheduled.data?.items ?? []).filter((e) => e.slotId === null);
  const editedSlot = slots.data?.items.find((x) => x.id === slotEdit?.slotId);
  const editedEpisode = episodes.data?.items.find((e) => e.id === episodeEdit?.episodeId);

  return (
    // The show's identity (artwork, name, hosts) and its actions are the header bar; its tags
    // and description, when it has any, open the page.
    <Page
      width="list"
      header={
        <PageHeader
          back={
            <>
              <BackButton
                nativeButton={false}
                render={<Link to="/stations/$stationId/shows" params={{ stationId }} />}
              >
                {t('show.back')}
              </BackButton>
              <ShowArtwork show={data} className="size-10 text-xs" />
            </>
          }
          title={data.name}
          description={
            data.hosts.length > 0
              ? t('show.hostedBy', { hosts: data.hosts.map((h) => h.name).join(', ') })
              : t('list.noHosts')
          }
          actions={
            <>
              <Button
                variant="outline"
                nativeButton={false}
                render={
                  <Link
                    to="/stations/$stationId/shows/calendar"
                    params={{ stationId }}
                    search={{ show: showId }}
                  />
                }
              >
                <CalendarDaysIcon data-icon="inline-start" />
                {t('calendar.title')}
              </Button>
              {canEdit && (
                <Button variant="outline" onClick={() => setEditingShow(true)}>
                  <PencilIcon data-icon="inline-start" />
                  {t('show.edit')}
                </Button>
              )}
            </>
          }
        />
      }
    >
      {(data.tags.length > 0 || data.description) && (
        <div className="flex flex-col gap-2">
          {data.tags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {data.tags.map((tag) => (
                <Badge key={tag} variant="outline">
                  {tag}
                </Badge>
              ))}
            </div>
          )}
          {data.description && <p className="max-w-2xl whitespace-pre-line">{data.description}</p>}
        </div>
      )}

      {detachedEpisodes.length > 0 && (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>{t('detached.title', { count: detachedEpisodes.length })}</AlertTitle>
          <AlertDescription>
            {t('detached.description', {
              episodes: detachedEpisodes
                .map((e) => e.number)
                .sort((a, b) => a - b)
                .map((number) => t('episode.label', { number }))
                .join(', '),
            })}
          </AlertDescription>
          <AlertAction>
            <Button size="sm" variant="ghost" onClick={() => setDetached([])}>
              {t('detached.dismiss')}
            </Button>
          </AlertAction>
        </Alert>
      )}

      <UpcomingSection
        stationId={stationId}
        showId={showId}
        access={access}
        canEdit={canEdit}
        occurrences={upcoming}
        pending={occurrences.isPending}
        error={occurrences.error}
        unscheduled={toPlan}
        onPlan={(occurrence) => setEpisodeEdit({ occurrence })}
        onEdit={(id) => {
          const episode = episodes.data?.items.find((e) => e.id === id);
          if (episode) setEpisodeEdit({ episodeId: episode.id });
        }}
      />

      {toPlan.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="font-heading font-semibold">{t('unscheduled.title')}</h2>
          <p className="text-muted-foreground">{t('unscheduled.description')}</p>
          <ul className="flex flex-col divide-y rounded-xl ring-1 ring-foreground/10">
            {toPlan.map((episode) => (
              <UnscheduledRow
                key={episode.id}
                stationId={stationId}
                showId={showId}
                episode={episode}
                canEdit={canEdit}
                free={upcoming.filter((o) => !o.episode && o.type !== 'rerun')}
                timezone={access.timezone}
                onEdit={() => setEpisodeEdit({ episodeId: episode.id })}
              />
            ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-heading font-semibold">{t('slots.title')}</h2>
          {access.canManage && (
            <Button className="ml-auto" size="sm" onClick={() => setSlotEdit({})}>
              <PlusIcon data-icon="inline-start" />
              {t('slots.add')}
            </Button>
          )}
        </div>
        <SlotList
          slots={slots.data?.items}
          episodes={episodes.data?.items}
          pending={slots.isPending}
          canManage={access.canManage}
          onEdit={(slot) => setSlotEdit({ slotId: slot.id })}
        />
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-heading font-semibold">{t('episodes.title')}</h2>
          {canEdit && (
            <Button className="ml-auto" size="sm" onClick={() => setEpisodeEdit({})}>
              <PlusIcon data-icon="inline-start" />
              {t('episodes.new')}
            </Button>
          )}
        </div>
        <EpisodeTable
          episodes={episodes.data?.items}
          pending={episodes.isPending}
          canEdit={canEdit}
          canManage={access.canManage}
          timezone={access.timezone}
          onEdit={(episode) => setEpisodeEdit({ episodeId: episode.id })}
          onRerun={(episode) => setRerunOf(episode.id)}
        />
      </section>

      <ShowFormDialog
        stationId={stationId}
        show={data}
        open={editingShow}
        onOpenChange={setEditingShow}
        canManage={access.canManage}
      />
      {access.canManage && (
        <>
          <SlotEditorDialog
            stationId={stationId}
            show={data}
            slot={editedSlot}
            timezone={access.timezone}
            // A deleted slot closes the dialog rather than turning it into a new one.
            open={slotEdit !== null && (!slotEdit.slotId || editedSlot !== undefined)}
            onOpenChange={(open) => !open && setSlotEdit(null)}
            onDetached={(ids) => setDetached(ids)}
          />
          <RerunDialog
            stationId={stationId}
            showId={showId}
            episode={episodes.data?.items.find((e) => e.id === rerunOf) ?? null}
            timezone={access.timezone}
            onClose={() => setRerunOf(null)}
          />
          <DeleteShow stationId={stationId} showId={showId} name={data.name} />
        </>
      )}
      <EpisodeDialog
        stationId={stationId}
        show={data}
        episode={editedEpisode}
        initialOccurrence={episodeEdit?.occurrence}
        occurrences={upcoming}
        timezone={access.timezone}
        canSearchLibrary={access.canSearchLibrary}
        open={episodeEdit !== null && (!episodeEdit.episodeId || editedEpisode !== undefined)}
        onOpenChange={(open) => !open && setEpisodeEdit(null)}
      />
    </Page>
  );
}

function UpcomingSection({
  stationId,
  showId,
  access,
  canEdit,
  occurrences,
  pending,
  error,
  unscheduled,
  onPlan,
  onEdit,
}: {
  stationId: string;
  showId: string;
  access: ShowAccess;
  canEdit: boolean;
  occurrences: ShowOccurrence[];
  pending: boolean;
  error: unknown;
  unscheduled: Episode[];
  onPlan(occurrence: ShowOccurrence): void;
  onEdit(episodeId: string): void;
}) {
  const t = useShowT();
  const { locale } = useI18n();
  const showError = useShowError();
  const queryClient = useQueryClient();
  const upload = useEpisodeUpload(stationId);
  const [busy, setBusy] = useState(false);
  const now = Date.now();
  const horizon = now + PLAN_AHEAD_DAYS * DAY_MS;
  const missing = occurrences.filter(
    (o) =>
      !o.episode &&
      o.type !== 'rerun' &&
      o.startsAt.getTime() >= now &&
      o.startsAt.getTime() < horizon,
  );

  const act = async (action: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await action();
      if (done) toast.success(done);
    } catch (e) {
      toast.error(showError(e));
    } finally {
      await invalidateShows(queryClient, stationId);
      setBusy(false);
    }
  };

  /** One episode per free airing, numbered in airing order. */
  const createMissing = () =>
    act(
      async () => {
        for (const o of missing) {
          await showsApi.createEpisode(stationId, showId, {
            slotId: o.slotId,
            occurrenceDate: o.date,
          });
        }
      },
      t('upcoming.created', { count: missing.length }),
    );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h2 className="font-heading font-semibold">{t('upcoming.title')}</h2>
        <span className="text-xs text-muted-foreground">
          {t('upcoming.timezone', { timezone: access.timezone })}
        </span>
        {canEdit && missing.length > 0 && (
          <Button
            className="ml-auto"
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={createMissing}
          >
            <PlusIcon data-icon="inline-start" />
            {t('upcoming.createMissing', { count: missing.length })}
          </Button>
        )}
      </div>
      {pending ? (
        <ListSkeleton />
      ) : error ? (
        <FormAlert error={error} />
      ) : occurrences.length === 0 ? (
        <Card>
          <CardContent className="py-6 text-center text-muted-foreground">
            {t('upcoming.empty')}
          </CardContent>
        </Card>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl ring-1 ring-foreground/10">
          {occurrences.map((o) => {
            const date = localDateOf(o.startsAt, access.timezone);
            const episode = o.episode;
            return (
              // Three columns on wide screens: when, what (episode and status), and the
              // actions, right-aligned so the buttons line up from one airing to the next.
              <li
                key={occurrenceKey(o)}
                className="grid grid-cols-1 items-center gap-x-4 gap-y-2 p-3 sm:grid-cols-[9rem_minmax(0,1fr)_auto]"
                data-testid="upcoming-row"
              >
                <div className="flex flex-col">
                  <span className="font-medium">{formatDay(date, locale)}</span>
                  <span className="text-muted-foreground tabular-nums">
                    {formatTime(o.startsAt, access.timezone, locale)}–
                    {formatTime(o.endsAt, access.timezone, locale)}
                  </span>
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {o.type === 'live' && (
                    <Badge variant="secondary">
                      <RadioIcon />
                      {t('type.live')}
                    </Badge>
                  )}
                  {o.type === 'rerun' && <Badge variant="outline">{t('type.rerun')}</Badge>}
                  {o.moved && <Badge variant="outline">{t('occurrence.moved')}</Badge>}
                  {episode ? (
                    <>
                      <button
                        type="button"
                        className="truncate text-left hover:underline disabled:no-underline"
                        disabled={!canEdit}
                        onClick={() => onEdit(episode.id)}
                      >
                        {t('episode.label', { number: episode.number })}
                        {episode.title ? ` · ${episode.title}` : ''}
                      </button>
                      <EpisodeStatusBadge status={episode.status} episodeId={episode.id} />
                    </>
                  ) : o.type === 'rerun' ? (
                    <RerunOf occurrence={o} />
                  ) : canEdit && unscheduled.length > 0 ? (
                    <NativeSelect
                      size="sm"
                      aria-label={t('upcoming.assign')}
                      value=""
                      disabled={busy}
                      onChange={(e) => {
                        const id = e.target.value;
                        if (id) {
                          void act(() =>
                            showsApi.updateEpisode(stationId, showId, id, {
                              slotId: o.slotId,
                              occurrenceDate: o.date,
                            }),
                          );
                        }
                      }}
                    >
                      <NativeSelectOption value="">{t('upcoming.assign')}</NativeSelectOption>
                      {unscheduled.map((e) => (
                        <NativeSelectOption key={e.id} value={e.id}>
                          {t('episode.label', { number: e.number })}
                          {e.title ? ` · ${e.title}` : ''}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  ) : (
                    <span className="text-muted-foreground">{t('upcoming.noEpisode')}</span>
                  )}
                </div>
                {/* Row actions are outline: a page of airings shouldn't be a column of blue. */}
                <div className="flex items-center gap-2 sm:justify-end">
                  {episode ? (
                    canEdit &&
                    episode.kind === 'prerecorded' &&
                    !episode.assetId && (
                      <UploadAudioButton
                        variant="outline"
                        label={t('episode.uploadAudio')}
                        onFile={(file) => upload({ showId, episodeId: episode.id }, file)}
                      />
                    )
                  ) : o.type !== 'rerun' && canEdit ? (
                    <>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onPlan(o)}>
                        {t('upcoming.plan')}
                      </Button>
                      {o.type === 'prerecorded' && (
                        <UploadAudioButton
                          variant="outline"
                          label={t('episode.uploadAudio')}
                          onFile={(file) =>
                            upload({ showId, slotId: o.slotId, occurrenceDate: o.date }, file)
                          }
                        />
                      )}
                    </>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function UnscheduledRow({
  stationId,
  showId,
  episode,
  canEdit,
  free,
  timezone,
  onEdit,
}: {
  stationId: string;
  showId: string;
  episode: Episode;
  canEdit: boolean;
  free: ShowOccurrence[];
  timezone: string;
  onEdit(): void;
}) {
  const t = useShowT();
  const { locale } = useI18n();
  const showError = useShowError();
  const queryClient = useQueryClient();
  return (
    <li className="flex flex-wrap items-center gap-3 p-3">
      <button type="button" className="hover:underline" onClick={onEdit} disabled={!canEdit}>
        {t('episode.label', { number: episode.number })}
        {episode.title ? ` · ${episode.title}` : ''}
      </button>
      <EpisodeStatusBadge status={episode.status} episodeId={episode.id} />
      {canEdit && free.length > 0 && (
        <NativeSelect
          size="sm"
          className="ml-auto"
          aria-label={t('unscheduled.planIn', { number: episode.number })}
          value=""
          onChange={async (e) => {
            const [slotId, occurrenceDate] = e.target.value.split('|');
            if (!slotId || !occurrenceDate) return;
            try {
              await showsApi.updateEpisode(stationId, showId, episode.id, {
                slotId,
                occurrenceDate,
              });
              toast.success(t('unscheduled.planned', { number: episode.number }));
            } catch (error) {
              toast.error(showError(error));
            } finally {
              await invalidateShows(queryClient, stationId);
            }
          }}
        >
          <NativeSelectOption value="">
            {t('unscheduled.planIn', { number: episode.number })}
          </NativeSelectOption>
          {free.map((o) => (
            <NativeSelectOption key={occurrenceKey(o)} value={occurrenceKey(o)}>
              {formatDay(localDateOf(o.startsAt, timezone), locale)}{' '}
              {formatTime(o.startsAt, timezone, locale)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      )}
    </li>
  );
}

/** A rerun slot's strategy in words. */
function rerunSummary(
  slot: ShowSlot,
  episodes: Episode[] | undefined,
  t: ReturnType<typeof useShowT>,
) {
  const rerun = slot.rerun;
  if (!rerun) return null;
  if (rerun.strategy === 'latest_episode') return t('rerun.slotLatest');
  const chosen = episodes?.find((e) => e.id === rerun.episodeId);
  if (!rerun.episodeId) return t('rerun.slotEpisodeGone');
  return chosen ? t('rerun.slotEpisode', { number: chosen.number }) : null;
}

function SlotList({
  slots,
  episodes,
  pending,
  canManage,
  onEdit,
}: {
  slots: ShowSlot[] | undefined;
  episodes: Episode[] | undefined;
  pending: boolean;
  canManage: boolean;
  onEdit(slot: ShowSlot): void;
}) {
  const t = useShowT();
  const { locale } = useI18n();
  if (pending) return <ListSkeleton rows={3} />;
  if (!slots || slots.length === 0) {
    return <p className="text-muted-foreground">{t('slots.empty')}</p>;
  }
  return (
    <ul className="flex flex-col divide-y rounded-xl ring-1 ring-foreground/10">
      {slots.map((slot) => (
        <li key={slot.id} className="flex flex-wrap items-center gap-3 p-3">
          <div className="flex flex-col">
            <span className="font-medium">{ruleSummary(slot.rule, t, locale)}</span>
            <span className="text-muted-foreground">
              {formatDuration(slot.durationMs)}
              {slot.exceptions.length > 0 &&
                ` · ${t('slots.exceptions', { count: slot.exceptions.length })}`}
              {slot.rerun && ` · ${rerunSummary(slot, episodes, t) ?? t('type.rerun')}`}
            </span>
          </div>
          <Badge variant="outline">{t(`type.${slot.type}`)}</Badge>
          {canManage && (
            <Button className="ml-auto" size="sm" variant="ghost" onClick={() => onEdit(slot)}>
              <PencilIcon data-icon="inline-start" />
              {t('slots.edit')}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function EpisodeTable({
  episodes,
  pending,
  canEdit,
  canManage,
  timezone,
  onEdit,
  onRerun,
}: {
  episodes: Episode[] | undefined;
  pending: boolean;
  canEdit: boolean;
  /** Scheduling a rerun adds a slot: programmers only. */
  canManage: boolean;
  timezone: string;
  onEdit(episode: Episode): void;
  onRerun(episode: Episode): void;
}) {
  const t = useShowT();
  const { locale } = useI18n();
  const today = localDateOf(new Date(), timezone);
  if (pending) return <ListSkeleton rows={3} />;
  if (!episodes || episodes.length === 0) {
    return <p className="text-muted-foreground">{t('episodes.empty')}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16">#</TableHead>
          <TableHead>{t('episode.title')}</TableHead>
          <TableHead>{t('episode.kind')}</TableHead>
          <TableHead>{t('episode.occurrence')}</TableHead>
          <TableHead>{t('episodes.status')}</TableHead>
          {canManage && <TableHead className="w-0" />}
        </TableRow>
      </TableHeader>
      <TableBody>
        {episodes.map((episode) => (
          <TableRow key={episode.id}>
            <TableCell className="tabular-nums">
              {canEdit ? (
                <button
                  type="button"
                  className="font-medium hover:underline"
                  onClick={() => onEdit(episode)}
                  aria-label={t('episode.editTitle', { number: episode.number })}
                >
                  {episode.number}
                </button>
              ) : (
                episode.number
              )}
            </TableCell>
            <TableCell>{episode.title ?? '–'}</TableCell>
            <TableCell>{t(`type.${episode.kind}`)}</TableCell>
            <TableCell>
              {episode.occurrenceDate
                ? formatDay(episode.occurrenceDate, locale, { year: 'numeric' })
                : t('episode.unscheduled')}
            </TableCell>
            <TableCell>
              <EpisodeStatusBadge status={episode.status} episodeId={episode.id} />
            </TableCell>
            {canManage && (
              <TableCell className="text-right">
                {canScheduleRerun(episode, today) && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={t('rerun.scheduleLabel', { number: episode.number })}
                    onClick={() => onRerun(episode)}
                  >
                    <Repeat2Icon data-icon="inline-start" />
                    {t('rerun.schedule')}
                  </Button>
                )}
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DeleteShow({
  stationId,
  showId,
  name,
}: {
  stationId: string;
  showId: string;
  name: string;
}) {
  const t = useShowT();
  const showError = useShowError();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  return (
    <div className="border-t pt-4">
      <Button
        variant="destructive"
        onClick={async () => {
          if (!window.confirm(t('show.deleteConfirm', { name }))) return;
          try {
            await showsApi.remove(stationId, showId);
            await invalidateShows(queryClient, stationId);
            toast.success(t('show.deleted'));
            await navigate({ to: '/stations/$stationId/shows', params: { stationId } });
          } catch (error) {
            toast.error(showError(error));
          }
        }}
      >
        {t('show.delete')}
      </Button>
    </div>
  );
}

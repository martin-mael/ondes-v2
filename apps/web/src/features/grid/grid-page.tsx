import { type ClockGridDto, daypartCells, localDateOf, rolePermissions } from '@ondes/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { CircleAlertIcon, EraserIcon, HandIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Card, CardContent } from '@/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/ui/field';
import { NativeSelect, NativeSelectOption } from '@/ui/native-select';
import { isApiError } from '../../app/api/client.ts';
import { findStation, useOrgs } from '../../app/auth/session.ts';
import { FormAlert } from '../../app/forms.tsx';
import { Page, PageHeader } from '../../app/page-header.tsx';
import { DelayedSpinner, PageSkeleton } from '../../app/pending.tsx';
import { useUnsavedChanges } from '../../app/unsaved.tsx';
import { clocksQuery } from '../clocks/api.ts';
import { gridApi, gridKeys, gridQuery } from './api.ts';
import { DaypartsPanel } from './dayparts.tsx';
import { useGridError, useGridT } from './messages.ts';
import { OverridesPanel } from './overrides.tsx';
import {
  cellKey,
  clockColor,
  type Draft,
  paint,
  rectangle,
  sameDraft,
  toCells,
  toDraft,
} from './paint.ts';
import { type GridClock, WeekGrid } from './week-grid.tsx';

// Weekly clock grid (#40): paint clocks onto the 168 hours of the week, bulk-paint dayparts,
// pick the default clock, and keep date-range overrides. The cells and the default are one
// draft, saved together (`PUT …/clock-grid`, versioned); dayparts and overrides save from
// their own dialogs. Every hour is station-local wall-clock time.

const route = getRouteApi('/_app/stations/$stationId/grid');

export function GridPage() {
  const t = useGridT();
  const gridError = useGridError();
  const { stationId } = route.useParams();
  const found = findStation(useOrgs(), stationId);
  const canEdit = new Set(found ? rolePermissions[found.station.role] : []).has('clock:write');
  const grid = useQuery(gridQuery(stationId));
  const clockList = useQuery(clocksQuery(stationId));
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<Draft>(new Map());
  const [defaultClockId, setDefaultClockId] = useState<string | null>(null);
  /** The saved grid the draft started from. */
  const [base, setBase] = useState<{
    cells: Draft;
    defaultClockId: string | null;
    version: number;
  } | null>(null);
  /** The clock painted, `null` for the eraser (back to the default), `undefined` until set. */
  const [brush, setBrush] = useState<string | null | undefined>(undefined);
  /** Touch screens: drag paints instead of scrolling. */
  const [touchPaint, setTouchPaint] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  /** What the stroke in progress paints: the brush, or `null` to clear. */
  const stroke = useRef<string | null>(null);

  const dirty =
    base !== null && (!sameDraft(draft, base.cells) || defaultClockId !== base.defaultClockId);
  const { guard } = useUnsavedChanges(dirty);
  /** The draft as last rendered, for a save that returns after more painting. */
  const latest = useRef({ draft, defaultClockId });
  latest.current = { draft, defaultClockId };

  const adopt = (saved: ClockGridDto) => {
    const cells = toDraft(saved.cells);
    setBase({ cells, defaultClockId: saved.defaultClockId, version: saved.version });
    setDraft(cells);
    setDefaultClockId(saved.defaultClockId);
  };

  // A newer server grid (first load, or someone else's save) replaces the draft only while it
  // has no unsaved change; otherwise saving answers `edit_conflict` and the user reloads.
  // biome-ignore lint/correctness/useExhaustiveDependencies: synced on server data only.
  useEffect(() => {
    if (grid.data && grid.data.version !== base?.version && !dirty) adopt(grid.data);
  }, [grid.data]);

  const clocks: GridClock[] = clockList.data?.items ?? [];
  const byId = useMemo(() => new Map(clocks.map((c) => [c.id, c])), [clocks]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: pick a first brush once.
  useEffect(() => {
    if (brush === undefined && clocks[0]) setBrush(clocks[0].id);
  }, [clocks.length]);

  if (grid.isPending || clockList.isPending) return <PageSkeleton />;
  if (grid.isError || clockList.isError) {
    const error = grid.error ?? clockList.error;
    return (
      <div className="p-6">
        {isApiError(error, 'forbidden') ? (
          <p className="text-sm text-muted-foreground">{t('forbidden')}</p>
        ) : (
          <FormAlert error={error} />
        )}
      </div>
    );
  }

  const timezone = grid.data.timezone;
  const brushName = brush ? (byId.get(brush)?.name ?? '') : t('brush.default');
  // Hours painted with a clock deleted since don't count as assigned.
  const unassigned =
    defaultClockId && byId.has(defaultClockId)
      ? 0
      : 7 * 24 - [...draft.values()].filter((id) => byId.has(id)).length;

  const onStroke = (cell: { weekday: number; hour: number }, first: boolean) => {
    if (first) {
      const current = draft.get(cellKey(cell.weekday, cell.hour)) ?? null;
      // Pressing on an hour that already has the brush clears instead.
      stroke.current = brush && current === brush ? null : (brush ?? null);
    }
    setDraft((d) => paint(d, [cell], stroke.current));
  };

  const save = async () => {
    if (!base) return;
    const sent = { draft, defaultClockId };
    setSaving(true);
    try {
      const saved = await gridApi.save(stationId, {
        version: base.version,
        defaultClockId,
        cells: toCells(draft),
      });
      const cells = toDraft(saved.cells);
      setBase({ cells, defaultClockId: saved.defaultClockId, version: saved.version });
      // Painting goes on during the request: keep what changed since, on top of the save.
      if (sameDraft(latest.current.draft, sent.draft)) setDraft(cells);
      if (latest.current.defaultClockId === sent.defaultClockId) {
        setDefaultClockId(saved.defaultClockId);
      }
      queryClient.setQueryData(gridKeys.all(stationId), saved);
      toast.success(t('saved'));
    } catch (error) {
      if (isApiError(error, 'edit_conflict')) setConflict(true);
      else toast.error(gridError(error));
    } finally {
      setSaving(false);
    }
  };

  const fetchFresh = () => queryClient.fetchQuery({ ...gridQuery(stationId), staleTime: 0 });

  /** After a conflict: their version replaces the draft, once the user agrees to lose it. */
  const loadTheirs = async () => {
    if (dirty && !window.confirm(t('conflict.loadConfirm'))) return;
    adopt(await fetchFresh());
    setConflict(false);
  };

  /** After a conflict: keep the draft, based on their version; the next save replaces it. */
  const keepMine = async () => {
    const fresh = await fetchFresh();
    setBase({
      cells: toDraft(fresh.cells),
      defaultClockId: fresh.defaultClockId,
      version: fresh.version,
    });
    setConflict(false);
  };

  const discard = () => {
    if (!base) return;
    setDraft(base.cells);
    setDefaultClockId(base.defaultClockId);
  };

  return (
    <Page
      header={
        <PageHeader
          title={t('title')}
          description={
            <>
              {t('description')} <span>{t('stationTime', { timezone })}</span>
            </>
          }
          actions={
            canEdit && (
              <>
                {dirty && (
                  <Button variant="outline" onClick={discard} disabled={saving}>
                    {t('discard')}
                  </Button>
                )}
                <Button onClick={save} disabled={!dirty || saving || conflict}>
                  <DelayedSpinner when={saving} data-icon="inline-start" />
                  {t('save')}
                </Button>
              </>
            )
          }
        />
      }
    >
      {conflict && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription className="flex flex-wrap items-center gap-3">
            {t('conflict')}
            <Button size="sm" variant="outline" onClick={loadTheirs}>
              {t('conflict.load')}
            </Button>
            <Button size="sm" variant="outline" onClick={keepMine}>
              {t('conflict.keep')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {clocks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10 text-center text-sm text-muted-foreground">
            {t('noClocks')}
            <Button
              variant="outline"
              nativeButton={false}
              render={<Link to="/stations/$stationId/clocks/new" params={{ stationId }} />}
            >
              {t('createClock')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="flex flex-col gap-3">
            {unassigned > 0 && (
              <Alert>
                <CircleAlertIcon />
                <AlertDescription>
                  {unassigned === 1
                    ? t('default.missingOne')
                    : t('default.missing', { count: unassigned })}
                </AlertDescription>
              </Alert>
            )}
            <WeekGrid
              draft={draft}
              clocks={byId}
              defaultClockId={defaultClockId}
              readOnly={!canEdit}
              touchPaint={touchPaint}
              onStroke={onStroke}
              onRectangle={(from, to) =>
                setDraft((d) => paint(d, rectangle(from, to), brush ?? null))
              }
            />
          </div>

          <aside className="flex flex-col gap-6">
            {canEdit && (
              <section className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">{t('brush.title')}</h2>
                <p className="text-xs text-muted-foreground">{t('brush.hint')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {clocks.map((clock) => (
                    <Button
                      key={clock.id}
                      variant="outline"
                      size="sm"
                      aria-pressed={brush === clock.id}
                      className={cn(brush === clock.id && 'border-primary bg-accent')}
                      onClick={() => setBrush(clock.id)}
                    >
                      <span
                        aria-hidden
                        className="size-3 rounded-[2px]"
                        style={{ backgroundColor: clockColor(clock) }}
                      />
                      {clock.name}
                    </Button>
                  ))}
                  <Button
                    variant="outline"
                    size="sm"
                    aria-pressed={brush === null}
                    title={t('brush.defaultHelp')}
                    className={cn(brush === null && 'border-primary bg-accent')}
                    onClick={() => setBrush(null)}
                  >
                    <EraserIcon data-icon="inline-start" />
                    {t('brush.default')}
                  </Button>
                </div>
                {/* Touch screens only: a drag scrolls the page unless this is on. */}
                <Button
                  variant="outline"
                  size="sm"
                  aria-pressed={touchPaint}
                  title={t('touch.help')}
                  className={cn(
                    'hidden self-start [@media(pointer:coarse)]:inline-flex',
                    touchPaint && 'border-primary bg-accent',
                  )}
                  onClick={() => setTouchPaint((on) => !on)}
                >
                  <HandIcon data-icon="inline-start" />
                  {t('touch.paint')}
                </Button>
              </section>
            )}

            <Field>
              <FieldLabel htmlFor="grid-default">{t('default.label')}</FieldLabel>
              <NativeSelect
                id="grid-default"
                value={defaultClockId ?? ''}
                disabled={!canEdit}
                onChange={(e) => setDefaultClockId(e.target.value || null)}
              >
                <NativeSelectOption value="">{t('default.none')}</NativeSelectOption>
                {clocks.map((c) => (
                  <NativeSelectOption key={c.id} value={c.id}>
                    {c.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              <FieldDescription>{t('default.help')}</FieldDescription>
            </Field>

            <DaypartsPanel
              stationId={stationId}
              dayparts={grid.data.dayparts}
              canEdit={canEdit}
              brushName={brushName}
              onApply={(part) => {
                setDraft((d) => paint(d, daypartCells(part), brush ?? null));
                toast.success(t('dayparts.applied', { daypart: part.name }));
              }}
            />

            <OverridesPanel
              stationId={stationId}
              overrides={grid.data.overrides}
              clocks={clocks}
              today={localDateOf(new Date(), timezone)}
              canEdit={canEdit}
            />
          </aside>
        </div>
      )}
      {guard}
    </Page>
  );
}

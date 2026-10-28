import {
  addDays,
  type KeptReasonDto,
  type LocalDate,
  type LogDiffDay,
  type LogDiffItem,
  type LogRegenPreviewResponse,
} from '@ondes/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
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
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { isApiError } from '../../../app/api/client.ts';
import { useErrorMessage } from '../../../app/forms.tsx';
import { DelayedSpinner } from '../../../app/pending.tsx';
import { useUnsavedChanges } from '../../../app/unsaved.tsx';
import { logKey } from '../api.ts';
import { ruleLabel, useTimelineT } from '../messages.ts';
import { formatClock, formatSigned } from '../time.ts';
import { regenApi } from './api.ts';
import { type RegenT, useRegenT } from './messages.ts';

// Regenerate the log (#101): pick days, preview what regenerating would change (the api's
// dry-run: added, removed, moved, rules relaxed, what couldn't be planned), then apply. The
// worker writes the days and `log.updated` refreshes the timeline. Times are station time.

const PREVIEW_MAX_DAYS = 7;
const LIST_MAX = 8;

export function RegenButton({
  stationId,
  date,
  today,
  timeZone,
  className,
}: {
  className?: string;
  stationId: string;
  /** The day the timeline shows: the default range. */
  date: LocalDate;
  today: LocalDate;
  timeZone: string;
}) {
  const t = useRegenT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className={className} variant="outline" onClick={() => setOpen(true)}>
        <RefreshCwIcon data-icon="inline-start" />
        {t('open')}
      </Button>
      {open && (
        <RegenDialog
          stationId={stationId}
          initialFrom={date < today ? today : date}
          today={today}
          timeZone={timeZone}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function RegenDialog({
  stationId,
  initialFrom,
  today,
  timeZone,
  onClose,
}: {
  stationId: string;
  initialFrom: LocalDate;
  today: LocalDate;
  timeZone: string;
  onClose: () => void;
}) {
  const t = useRegenT();
  const message = useErrorMessage();
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialFrom);
  const preview = useMutation({
    mutationFn: (range: { from: LocalDate; to: LocalDate }) => regenApi.preview(stationId, range),
  });
  const shown =
    preview.data && preview.variables?.from === from && preview.variables.to === to
      ? preview.data
      : undefined;
  // A preview not applied yet is work the person would lose by closing.
  const { guard, allowLeave, confirmDiscard } = useUnsavedChanges(shown !== undefined);
  const apply = useMutation({
    mutationFn: (result: LogRegenPreviewResponse) =>
      regenApi.apply(stationId, {
        from,
        to,
        expectedVersions: Object.fromEntries(result.days.map((d) => [d.localDate, d.version])),
      }),
    onSuccess: () => {
      toast.success(t('applied'));
      void queryClient.invalidateQueries({ queryKey: logKey(stationId) });
      allowLeave();
      onClose();
    },
    onError: (error) => {
      if (isApiError(error, 'log_regen_stale')) preview.reset();
      toast.error(errorText(t, message, error));
    },
  });

  const lastAllowed = addDays(from, PREVIEW_MAX_DAYS - 1);
  const close = () => confirmDiscard(onClose);
  const changes = shown?.days.some((d) => d.change !== 'unchanged') ?? false;

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && close()}>
        <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              preview.mutate({ from, to });
            }}
          >
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="regen-from">{t('from')}</Label>
              <Input
                id="regen-from"
                type="date"
                className="w-40"
                min={today}
                value={from}
                onChange={(e) => {
                  const value = e.target.value;
                  if (!value) return;
                  setFrom(value);
                  if (to < value || to > addDays(value, PREVIEW_MAX_DAYS - 1)) setTo(value);
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="regen-to">{t('to')}</Label>
              <Input
                id="regen-to"
                type="date"
                className="w-40"
                min={from}
                max={lastAllowed}
                value={to}
                onChange={(e) => e.target.value && setTo(e.target.value)}
              />
            </div>
            <Button type="submit" variant="outline" disabled={preview.isPending}>
              <DelayedSpinner when={preview.isPending} data-icon="inline-start" />
              {t('preview')}
            </Button>
            <p className="basis-full text-xs text-muted-foreground">{t('rangeHint')}</p>
          </form>
          {preview.isError && (
            <p role="alert" className="text-sm text-destructive">
              {errorText(t, message, preview.error)}
            </p>
          )}
          {shown && (
            <div className="-mx-6 min-h-0 flex-1 overflow-y-auto border-t px-6 pt-4">
              <PreviewSummary result={shown} timeZone={timeZone} />
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={close}>
              {t('cancel')}
            </Button>
            <Button
              disabled={!shown || !changes || apply.isPending}
              onClick={() => shown && apply.mutate(shown)}
            >
              <DelayedSpinner when={apply.isPending} data-icon="inline-start" />
              {t('apply')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {guard}
    </>
  );
}

function errorText(t: RegenT, message: (error: unknown) => string, error: unknown) {
  if (isApiError(error, 'log_regen_stale')) return t('stale');
  if (isApiError(error, 'log_regen_past')) return t('past');
  return message(error);
}

export function PreviewSummary({
  result,
  timeZone,
}: {
  result: LogRegenPreviewResponse;
  timeZone: string;
}) {
  const t = useRegenT();
  const changes = result.days.some((d) => d.change !== 'unchanged');
  return (
    <div className="flex flex-col gap-4 pb-2">
      <p className="text-sm text-muted-foreground">
        {t('frozenUntil', { time: formatClock(result.frozenUntil, timeZone, false) })}
      </p>
      {changes ? (
        <p className="text-sm">{t('totals', result.totals)}</p>
      ) : (
        <p className="text-sm">{t('nothing')}</p>
      )}
      {result.days.map((day) => (
        <DayDiff key={day.localDate} day={day} timeZone={timeZone} />
      ))}
    </div>
  );
}

function DayDiff({ day, timeZone }: { day: LogDiffDay; timeZone: string }) {
  const t = useRegenT();
  const tt = useTimelineT();
  const kept = Object.entries(day.kept) as [KeptReasonDto, number][];
  return (
    <section className="flex flex-col gap-2" aria-label={day.localDate}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">{day.localDate}</h3>
        <Badge variant={day.change === 'unchanged' ? 'outline' : 'secondary'}>
          {t(`day.${day.change}`)}
        </Badge>
        {day.change !== 'new' && (
          <span className="text-xs text-muted-foreground">
            {t('day.unchangedCount', { count: day.unchangedCount })}
            {kept.length > 0 &&
              ` · ${t('day.kept', { count: kept.reduce((s, [, n]) => s + n, 0) })} (${kept
                .map(([reason, n]) => `${n} ${t(`kept.${reason}`)}`)
                .join(', ')})`}
          </span>
        )}
      </div>
      {day.change !== 'unchanged' && (
        <>
          <ItemList
            title={t('section.added')}
            items={day.added}
            render={(item) => <Row item={item} timeZone={timeZone} />}
          />
          <ItemList
            title={t('section.removed')}
            items={day.removed}
            render={(item) => <Row item={item} timeZone={timeZone} />}
          />
          <ItemList
            title={t('section.moved')}
            items={day.moved}
            render={(m) => (
              <Row item={m.item} timeZone={timeZone} extra={formatSigned(m.shiftMs)} />
            )}
          />
          <ItemList
            title={t('section.relaxed')}
            items={day.relaxed}
            render={(r) => (
              <Row
                item={r.item}
                timeZone={timeZone}
                extra={[
                  r.item.relaxedRules.map((rule) => ruleLabel(tt, rule.rule)).join(', '),
                  r.new ? t('newRelaxed') : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              />
            )}
          />
        </>
      )}
      <ItemList
        title={t('section.issues')}
        items={day.issues}
        render={(issue) => (
          <span className="flex gap-3">
            <span className="w-12 shrink-0 tabular-nums text-muted-foreground">
              {formatClock(issue.at, timeZone, false)}
            </span>
            <span>
              {t(`issue.${issue.code}`)}
              {issue.detail && <span className="text-muted-foreground"> · {issue.detail}</span>}
            </span>
          </span>
        )}
      />
    </section>
  );
}

function ItemList<T>({
  title,
  items,
  render,
}: {
  title: string;
  items: readonly T[];
  render: (item: T) => React.ReactNode;
}) {
  const t = useRegenT();
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <h4 className="text-sm font-medium text-muted-foreground">
        {title} ({items.length})
      </h4>
      <ul className="flex flex-col gap-0.5 text-sm">
        {items.slice(0, LIST_MAX).map((item, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static, ordered list
          <li key={i}>{render(item)}</li>
        ))}
        {items.length > LIST_MAX && (
          <li className="text-muted-foreground">{t('more', { count: items.length - LIST_MAX })}</li>
        )}
      </ul>
    </div>
  );
}

function Row({ item, timeZone, extra }: { item: LogDiffItem; timeZone: string; extra?: string }) {
  const t = useRegenT();
  const title = item.asset
    ? [item.asset.artists.join(', '), item.asset.title].filter(Boolean).join(' – ')
    : (item.title ?? t('untitled'));
  return (
    <span className="flex gap-3">
      <span className="w-12 shrink-0 tabular-nums text-muted-foreground">
        {formatClock(item.plannedStart, timeZone, false)}
      </span>
      <span className="min-w-0 truncate">{title}</span>
      {extra && <span className="ml-auto shrink-0 text-muted-foreground">{extra}</span>}
    </span>
  );
}
